-- 035: Source Documents foundation (Phase 1A).
--
-- Extends the existing `documents` table (the logical source document —
-- one per CR / specification / design) and adds `document_versions`: one
-- immutable row per uploaded file. The original file lives in the private
-- Supabase Storage bucket `source-documents`.
--
--   documents          project_id, document_name (title), document_type,
--                      notes (description), current_version_id, created_by,
--                      created_at, archived_at …
--   document_versions  document_id, project_id, version_number, original
--                      filename, storage_path, sha256, content_type,
--                      size_bytes, uploaded_by, uploaded_at, is_original,
--                      extraction_status, analysis_status
--
-- Guarantees enforced here (not only in application code):
--   * every document and version belongs to a project, and a version's
--     project is its document's project (composite FK);
--   * version numbers are unique per document; new versions are numbered
--     max+1 under a row lock, so they are deterministic and monotonic;
--   * exactly one version is current: documents.current_version_id is
--     NOT NULL and must reference one of that document's own versions;
--   * versions are immutable — only the extraction/analysis status
--     placeholders can change, and a version can only disappear when its
--     whole document is permanently deleted (Admin);
--   * storage paths are unique and project-prefixed; files are private.
--
-- Writes go only through the authenticated /api/source-documents routes
-- (Manager/Admin; permanent delete Admin), which use the service role and
-- the functions below. Viewer/Manager/Admin read directly under RLS
-- (can_read). anon has no access (migration 032 default privileges).
-- Future source_fragments will reference document_versions(id).
--
-- Existing data: `documents` has no rows; the legacy storage_path column is
-- kept (unused) rather than dropped.

-- ── documents: logical source document ─────────────────────────────────────

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS current_version_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS created_by_name text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by_name text;

ALTER TABLE public.documents
  ADD CONSTRAINT documents_document_type_check CHECK (
    document_type IS NULL OR document_type IN (
      'Change Request', 'Functional Specification', 'Technical Specification', 'Design Document', 'Other'
    )
  );

ALTER TABLE public.documents
  ADD CONSTRAINT documents_id_project_id_key UNIQUE (id, project_id);

-- ── document_versions: immutable uploaded originals ────────────────────────

CREATE TABLE public.document_versions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id       uuid        NOT NULL,
  project_id        uuid        NOT NULL,  -- guaranteed by the composite FK to documents (id, project_id)
  version_number    integer     NOT NULL CHECK (version_number >= 1),
  original_filename text        NOT NULL CHECK (length(btrim(original_filename)) > 0),
  storage_bucket    text        NOT NULL DEFAULT 'source-documents' CHECK (storage_bucket = 'source-documents'),
  storage_path      text        NOT NULL UNIQUE,
  sha256            text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content_type      text        NOT NULL CHECK (content_type IN (
                                  'application/pdf',
                                  'application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
  size_bytes        bigint      NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
  uploaded_by       uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  uploaded_by_name  text        NOT NULL,
  uploaded_at       timestamptz NOT NULL DEFAULT now(),
  is_original       boolean     NOT NULL DEFAULT true,
  extraction_status text        NOT NULL DEFAULT 'Not Started' CHECK (extraction_status IN ('Not Started', 'Queued', 'In Progress', 'Complete', 'Failed')),
  analysis_status   text        NOT NULL DEFAULT 'Not Started' CHECK (analysis_status IN ('Not Started', 'Queued', 'In Progress', 'Complete', 'Failed')),
  status_updated_at timestamptz,
  CONSTRAINT document_versions_document_version_key UNIQUE (document_id, version_number),
  CONSTRAINT document_versions_id_document_id_key UNIQUE (id, document_id),
  CONSTRAINT document_versions_path_in_project CHECK (storage_path LIKE project_id::text || '/%'),
  CONSTRAINT document_versions_document_same_project_fkey
    FOREIGN KEY (document_id, project_id) REFERENCES public.documents (id, project_id) ON DELETE CASCADE
);

CREATE INDEX document_versions_document_idx ON public.document_versions (document_id, version_number DESC);
CREATE INDEX document_versions_project_idx ON public.document_versions (project_id);
CREATE INDEX document_versions_sha256_idx ON public.document_versions (project_id, sha256);

-- Exactly one current version, and it must be one of the document's own.
-- Deferred so a document and its first version can be created together.
ALTER TABLE public.documents
  ADD CONSTRAINT documents_current_version_fkey
  FOREIGN KEY (current_version_id, id) REFERENCES public.document_versions (id, document_id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE public.documents ALTER COLUMN current_version_id SET NOT NULL;

-- ── Immutability ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.document_versions_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Only as part of permanently deleting the whole document (cascade).
    IF NOT EXISTS (SELECT 1 FROM public.documents d WHERE d.id = OLD.document_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'document versions are immutable: a version cannot be deleted on its own';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.document_id IS DISTINCT FROM OLD.document_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.version_number IS DISTINCT FROM OLD.version_number
     OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
     OR NEW.storage_bucket IS DISTINCT FROM OLD.storage_bucket
     OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.content_type IS DISTINCT FROM OLD.content_type
     OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
     OR NEW.uploaded_by_name IS DISTINCT FROM OLD.uploaded_by_name
     OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
     OR NEW.is_original IS DISTINCT FROM OLD.is_original THEN
    RAISE EXCEPTION 'document versions are immutable: only extraction/analysis status may change';
  END IF;
  -- uploaded_by may only be cleared by the auth.users FK (ON DELETE SET NULL);
  -- the uploader's name (uploaded_by_name) is kept for provenance.
  IF NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
     AND NOT (NEW.uploaded_by IS NULL AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.uploaded_by)) THEN
    RAISE EXCEPTION 'document versions are immutable: only extraction/analysis status may change';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER document_versions_immutable
  BEFORE UPDATE OR DELETE ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_versions_immutable();

-- ── Atomic write functions (service role only) ─────────────────────────────

-- Registers an uploaded file: creates the document with version 1, or adds
-- version max+1 to an existing (non-archived) document of the same project,
-- and makes it current. Refuses a file identical to an existing version.
CREATE OR REPLACE FUNCTION public.register_source_document_version(
  p_project_id uuid,
  p_document_id uuid,
  p_title text,
  p_document_type text,
  p_notes text,
  p_storage_path text,
  p_original_filename text,
  p_content_type text,
  p_size_bytes bigint,
  p_sha256 text,
  p_user_id uuid,
  p_user_name text
)
RETURNS TABLE (document_id uuid, version_id uuid, version_number integer, previous_version_number integer, created_document boolean)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_variable
DECLARE
  v_doc public.documents%ROWTYPE;
  v_version_id uuid := gen_random_uuid();
  v_next integer;
  v_prev integer;
  v_dup integer;
BEGIN
  IF p_document_id IS NULL THEN
    IF p_title IS NULL OR length(btrim(p_title)) = 0 THEN
      RAISE EXCEPTION 'A document title is required' USING ERRCODE = '22023';
    END IF;
    document_id := gen_random_uuid();
    INSERT INTO public.documents (id, project_id, document_name, document_type, notes, current_version_id, created_by, created_by_name)
    VALUES (document_id, p_project_id, btrim(p_title), p_document_type, NULLIF(btrim(coalesce(p_notes, '')), ''), v_version_id, p_user_id, p_user_name);
    v_next := 1;
    v_prev := NULL;
    created_document := true;
  ELSE
    SELECT * INTO v_doc FROM public.documents d WHERE d.id = p_document_id AND d.project_id = p_project_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Source document not found in this project' USING ERRCODE = 'P0002';
    END IF;
    IF v_doc.archived_at IS NOT NULL THEN
      RAISE EXCEPTION 'This source document is archived; restore it before uploading a new version' USING ERRCODE = '55000';
    END IF;
    SELECT v.version_number INTO v_dup FROM public.document_versions v WHERE v.document_id = p_document_id AND v.sha256 = p_sha256 ORDER BY v.version_number LIMIT 1;
    IF FOUND THEN
      RAISE EXCEPTION 'This file is identical to version % of this document', v_dup USING ERRCODE = '23505';
    END IF;
    SELECT v.version_number INTO v_prev FROM public.document_versions v WHERE v.id = v_doc.current_version_id;
    SELECT coalesce(max(v.version_number), 0) + 1 INTO v_next FROM public.document_versions v WHERE v.document_id = p_document_id;
    document_id := p_document_id;
    created_document := false;
  END IF;

  INSERT INTO public.document_versions (id, document_id, project_id, version_number, original_filename, storage_path, sha256, content_type, size_bytes, uploaded_by, uploaded_by_name)
  VALUES (v_version_id, document_id, p_project_id, v_next, p_original_filename, p_storage_path, p_sha256, p_content_type, p_size_bytes, p_user_id, p_user_name);

  IF NOT created_document THEN
    UPDATE public.documents d SET current_version_id = v_version_id WHERE d.id = document_id;
  END IF;

  version_id := v_version_id;
  version_number := v_next;
  previous_version_number := v_prev;
  RETURN NEXT;
END;
$$;

-- Makes an existing version of the document current (e.g. roll back to v1).
CREATE OR REPLACE FUNCTION public.set_current_document_version(p_project_id uuid, p_document_id uuid, p_version_id uuid)
RETURNS TABLE (previous_version_number integer, current_version_number integer)
LANGUAGE plpgsql
SET search_path = ''
AS $$
#variable_conflict use_variable
DECLARE
  v_doc public.documents%ROWTYPE;
BEGIN
  SELECT * INTO v_doc FROM public.documents d WHERE d.id = p_document_id AND d.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Source document not found in this project' USING ERRCODE = 'P0002';
  END IF;
  IF v_doc.archived_at IS NOT NULL THEN
    RAISE EXCEPTION 'This source document is archived' USING ERRCODE = '55000';
  END IF;
  SELECT v.version_number INTO current_version_number FROM public.document_versions v WHERE v.id = p_version_id AND v.document_id = p_document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'That version does not belong to this document' USING ERRCODE = 'P0002';
  END IF;
  SELECT v.version_number INTO previous_version_number FROM public.document_versions v WHERE v.id = v_doc.current_version_id;
  UPDATE public.documents d SET current_version_id = p_version_id WHERE d.id = p_document_id;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.register_source_document_version(uuid, uuid, text, text, text, text, text, text, bigint, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_current_document_version(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.document_versions_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.register_source_document_version(uuid, uuid, text, text, text, text, text, text, bigint, text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_current_document_version(uuid, uuid, uuid) TO service_role;

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Read: every valid role (Viewer included). Write: none directly — only the
-- server routes (service role). documents keeps its 031 SELECT policy; its
-- direct-write policies are removed.

ALTER TABLE public.document_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "document_versions_select" ON public.document_versions
  FOR SELECT TO authenticated USING ((SELECT public.can_read()));

DROP POLICY IF EXISTS "documents_insert" ON public.documents;
DROP POLICY IF EXISTS "documents_update" ON public.documents;
DROP POLICY IF EXISTS "documents_delete" ON public.documents;

REVOKE ALL ON public.document_versions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.document_versions FROM authenticated;

-- ── Private Storage bucket ─────────────────────────────────────────────────
-- Not public, 25 MB per object, PDF/DOCX only. No storage.objects policies
-- are created for it, so anon and authenticated users cannot list, read or
-- write it directly: uploads use one-time signed upload URLs and reads use
-- short-lived signed URLs, both issued by the server after a role check.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'source-documents', 'source-documents', false, 26214400,
  ARRAY['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
)
ON CONFLICT (id) DO NOTHING;
