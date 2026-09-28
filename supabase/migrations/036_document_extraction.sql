-- 036: Deterministic document extraction — jobs, fragments, worker credentials (Phase 1B).
--
--   document_version ──1:n── extraction_jobs ──1:n── source_fragments
--
-- * Every new document version is queued for extraction automatically
--   (persisted work, not a browser tab): an AFTER INSERT trigger creates a
--   Queued job and the version's extraction_status starts at 'Queued'.
-- * Extraction runs on the local worker (local-worker/), never on Vercel and
--   never through an AI model. The worker authenticates with a narrow,
--   revocable token (only its SHA-256 is stored here) to five
--   /api/worker/* routes; it never receives Supabase credentials.
-- * One active (Queued/Running) job per version — partial unique index.
-- * Each version's extraction output is its own: fragments belong to one
--   job of one immutable version, are immutable once the job completes, and
--   their text_hash is verified by the database on insert. Version 2's
--   extraction can never touch version 1's fragments. A completed
--   extraction is never silently replaced: re-queueing a version whose
--   latest job completed is refused.
-- * document_versions.extraction_status stays the one canonical status,
--   now: Not Started | Queued | Running | Completed | Completed with warnings | Failed.
-- * Reads: every valid role (can_read), including completed fragments and
--   job diagnostics/safe error messages. Writes: service role only, via the
--   functions below. anon: nothing (032 default privileges).
-- Existing data: no document_versions rows exist yet; any legacy status
-- values are mapped ('In Progress' → 'Running', 'Complete' → 'Completed').

-- ── Canonical extraction status ─────────────────────────────────────────────

ALTER TABLE public.document_versions DROP CONSTRAINT IF EXISTS document_versions_extraction_status_check;
UPDATE public.document_versions SET extraction_status = CASE extraction_status
  WHEN 'In Progress' THEN 'Running' WHEN 'Complete' THEN 'Completed' ELSE extraction_status END
  WHERE extraction_status IN ('In Progress', 'Complete');
ALTER TABLE public.document_versions ADD CONSTRAINT document_versions_extraction_status_check
  CHECK (extraction_status IN ('Not Started', 'Queued', 'Running', 'Completed', 'Completed with warnings', 'Failed'));
ALTER TABLE public.document_versions ALTER COLUMN extraction_status SET DEFAULT 'Queued';

ALTER TABLE public.document_versions
  ADD CONSTRAINT document_versions_id_project_id_key UNIQUE (id, project_id);

-- ── Worker credentials ──────────────────────────────────────────────────────

CREATE TABLE public.worker_credentials (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text        NOT NULL,
  scope             text        NOT NULL CHECK (scope IN ('extraction')),
  token_sha256      text        NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by_name   text,
  revoked_at        timestamptz,
  last_seen_at      timestamptz,
  last_seen_version text
);
-- At most one active credential per scope: issuing a new one revokes the old.
CREATE UNIQUE INDEX worker_credentials_one_active_per_scope ON public.worker_credentials (scope) WHERE revoked_at IS NULL;

-- ── Extraction jobs ─────────────────────────────────────────────────────────

CREATE TABLE public.extraction_jobs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid        NOT NULL,
  document_version_id uuid        NOT NULL,
  status              text        NOT NULL DEFAULT 'Queued' CHECK (status IN ('Queued', 'Running', 'Completed', 'Failed')),
  trigger             text        NOT NULL CHECK (trigger IN ('upload', 'manual', 'retry')),
  requested_by        uuid        REFERENCES auth.users(id) ON DELETE SET NULL,
  requested_by_name   text,
  queued_at           timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz,
  completed_at        timestamptz,
  lease_expires_at    timestamptz,
  attempt_count       integer     NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts        integer     NOT NULL DEFAULT 3 CHECK (max_attempts >= 1),
  worker_id           uuid        REFERENCES public.worker_credentials(id) ON DELETE SET NULL,
  worker_name         text,
  worker_version      text,
  extractor_version   text,
  outcome             text        CHECK (outcome IN ('completed', 'completed_with_warnings')),
  warnings_count      integer,
  fragment_count      integer,
  diagnostics         jsonb,
  error_category      text        CHECK (error_category IN ('download_failed', 'integrity_mismatch', 'unsupported_type', 'parse_error', 'encrypted', 'ocr_required', 'worker_timeout', 'upload_failed', 'internal_error')),
  error_message       text        CHECK (length(error_message) <= 1000),
  CONSTRAINT extraction_jobs_id_version_project_key UNIQUE (id, document_version_id, project_id),
  CONSTRAINT extraction_jobs_version_same_project_fkey
    FOREIGN KEY (document_version_id, project_id) REFERENCES public.document_versions (id, project_id) ON DELETE CASCADE,
  CONSTRAINT extraction_jobs_completed_shape CHECK (status <> 'Completed' OR (outcome IS NOT NULL AND completed_at IS NOT NULL AND extractor_version IS NOT NULL)),
  CONSTRAINT extraction_jobs_failed_shape CHECK (status <> 'Failed' OR error_category IS NOT NULL)
);
CREATE UNIQUE INDEX extraction_jobs_one_active_per_version ON public.extraction_jobs (document_version_id) WHERE status IN ('Queued', 'Running');
CREATE INDEX extraction_jobs_queue_idx ON public.extraction_jobs (status, queued_at);
CREATE INDEX extraction_jobs_version_idx ON public.extraction_jobs (document_version_id, queued_at DESC);

-- ── Source fragments ────────────────────────────────────────────────────────

CREATE TABLE public.source_fragments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          uuid        NOT NULL,
  document_version_id uuid        NOT NULL,
  extraction_job_id   uuid        NOT NULL,
  sequence            integer     NOT NULL CHECK (sequence >= 1),
  fragment_type       text        NOT NULL CHECK (fragment_type IN ('text', 'table', 'list')),
  section_heading     text,
  section_number      text,
  section_path        text[]      NOT NULL DEFAULT '{}',
  page_start          integer     CHECK (page_start >= 1),
  page_end            integer     CHECK (page_end >= 1),
  text                text        NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  text_hash           text        NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
  char_count          integer     NOT NULL CHECK (char_count >= 1),
  metadata            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_fragments_job_sequence_key UNIQUE (extraction_job_id, sequence),
  CONSTRAINT source_fragments_pages_ordered CHECK (page_start IS NULL OR page_end IS NULL OR page_end >= page_start),
  CONSTRAINT source_fragments_job_same_version_fkey
    FOREIGN KEY (extraction_job_id, document_version_id, project_id)
    REFERENCES public.extraction_jobs (id, document_version_id, project_id) ON DELETE CASCADE
);
CREATE INDEX source_fragments_version_idx ON public.source_fragments (document_version_id, extraction_job_id, sequence);

-- ── Immutability ────────────────────────────────────────────────────────────

-- Fragments never change. They are only deleted as part of cleaning up a job
-- that did not complete, or when their document is permanently deleted.
CREATE OR REPLACE FUNCTION public.source_fragments_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'source fragments are immutable: they record what the extractor found';
  END IF;
  IF EXISTS (SELECT 1 FROM public.extraction_jobs j WHERE j.id = OLD.extraction_job_id AND j.status = 'Completed') THEN
    RAISE EXCEPTION 'fragments of a completed extraction cannot be deleted';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER source_fragments_immutable BEFORE UPDATE OR DELETE ON public.source_fragments
  FOR EACH ROW EXECUTE FUNCTION public.source_fragments_immutable();

-- Terminal jobs (Completed / Failed) are history: never edited, and only
-- removed together with their document version.
CREATE OR REPLACE FUNCTION public.extraction_jobs_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM public.document_versions v WHERE v.id = OLD.document_version_id) THEN
      RAISE EXCEPTION 'extraction jobs are history and cannot be deleted on their own';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.status IN ('Completed', 'Failed') AND NEW.worker_id IS NOT DISTINCT FROM OLD.worker_id
     AND NEW.requested_by IS NOT DISTINCT FROM OLD.requested_by THEN
    RAISE EXCEPTION 'a % extraction job cannot be changed', lower(OLD.status);
  END IF;
  IF OLD.status IN ('Completed', 'Failed') THEN
    RETURN NEW; -- only FK ON DELETE SET NULL of worker_id / requested_by reaches here
  END IF;
  IF NEW.id <> OLD.id OR NEW.document_version_id <> OLD.document_version_id OR NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'an extraction job cannot be moved to another version';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER extraction_jobs_guard BEFORE UPDATE OR DELETE ON public.extraction_jobs
  FOR EACH ROW EXECUTE FUNCTION public.extraction_jobs_guard();

-- ── Automatic queueing of new versions ─────────────────────────────────────

CREATE OR REPLACE FUNCTION public.document_versions_queue_extraction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.extraction_jobs (project_id, document_version_id, trigger, requested_by, requested_by_name)
  VALUES (NEW.project_id, NEW.id, 'upload', NEW.uploaded_by, NEW.uploaded_by_name);
  RETURN NEW;
END;
$$;
CREATE TRIGGER document_versions_queue_extraction AFTER INSERT ON public.document_versions
  FOR EACH ROW EXECUTE FUNCTION public.document_versions_queue_extraction();

-- ── Work functions (service role only; called by /api routes) ─────────────

-- Manager/Admin: queue (or retry) extraction of one version.
CREATE OR REPLACE FUNCTION public.queue_extraction_job(p_project_id uuid, p_version_id uuid, p_user_id uuid, p_user_name text)
RETURNS TABLE (job_id uuid, trigger text, previous_status text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_version public.document_versions%ROWTYPE;
  v_latest public.extraction_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_version FROM public.document_versions v WHERE v.id = p_version_id AND v.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document version not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.documents d WHERE d.id = v_version.document_id AND d.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This source document is archived' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_latest FROM public.extraction_jobs j WHERE j.document_version_id = p_version_id ORDER BY j.queued_at DESC, j.id DESC LIMIT 1;
  IF FOUND AND v_latest.status IN ('Queued', 'Running') THEN
    RAISE EXCEPTION 'Extraction is already % for this version', lower(v_latest.status) USING ERRCODE = '23505';
  END IF;
  IF FOUND AND v_latest.status = 'Completed' THEN
    RAISE EXCEPTION 'This version has already been extracted; re-extraction is not supported yet' USING ERRCODE = '55000';
  END IF;
  previous_status := v_version.extraction_status;
  trigger := CASE WHEN FOUND AND v_latest.status = 'Failed' THEN 'retry' ELSE 'manual' END;
  INSERT INTO public.extraction_jobs (project_id, document_version_id, trigger, requested_by, requested_by_name)
  VALUES (p_project_id, p_version_id, trigger, p_user_id, p_user_name) RETURNING id INTO job_id;
  UPDATE public.document_versions v SET extraction_status = 'Queued', status_updated_at = now() WHERE v.id = p_version_id;
  RETURN NEXT;
END;
$$;

-- Worker: claim the oldest queued job. Expired leases (a crashed worker) are
-- re-queued, or failed as worker_timeout once max_attempts is reached.
CREATE OR REPLACE FUNCTION public.claim_extraction_job(p_worker_id uuid, p_worker_name text, p_worker_version text, p_lease_seconds integer)
RETURNS TABLE (job_id uuid, project_id uuid, document_version_id uuid, storage_path text, content_type text, sha256 text, size_bytes bigint, original_filename text, attempt_count integer)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_job public.extraction_jobs%ROWTYPE;
BEGIN
  WITH expired AS (
    SELECT j.id, j.document_version_id, j.attempt_count >= j.max_attempts AS exhausted
    FROM public.extraction_jobs j WHERE j.status = 'Running' AND j.lease_expires_at < now() FOR UPDATE SKIP LOCKED
  ), updated AS (
    UPDATE public.extraction_jobs j SET
      status = CASE WHEN e.exhausted THEN 'Failed' ELSE 'Queued' END,
      completed_at = CASE WHEN e.exhausted THEN now() ELSE NULL END,
      error_category = CASE WHEN e.exhausted THEN 'worker_timeout' ELSE NULL END,
      error_message = CASE WHEN e.exhausted THEN 'The extraction worker stopped responding repeatedly; retry when the worker is running.' ELSE NULL END,
      lease_expires_at = NULL
    FROM expired e WHERE j.id = e.id RETURNING j.document_version_id, j.status
  )
  UPDATE public.document_versions v SET extraction_status = u.status, status_updated_at = now()
  FROM updated u WHERE v.id = u.document_version_id;
  DELETE FROM public.source_fragments f USING public.extraction_jobs j
    WHERE f.extraction_job_id = j.id AND j.status IN ('Queued', 'Failed') AND j.worker_id IS NOT NULL;

  SELECT * INTO v_job FROM public.extraction_jobs j WHERE j.status = 'Queued' ORDER BY j.queued_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE public.extraction_jobs j SET status = 'Running', started_at = now(), attempt_count = j.attempt_count + 1,
    lease_expires_at = now() + make_interval(secs => greatest(p_lease_seconds, 60)),
    worker_id = p_worker_id, worker_name = p_worker_name, worker_version = p_worker_version
  WHERE j.id = v_job.id;
  UPDATE public.document_versions v SET extraction_status = 'Running', status_updated_at = now() WHERE v.id = v_job.document_version_id;
  RETURN QUERY SELECT v_job.id, v.project_id, v.id, v.storage_path, v.content_type, v.sha256, v.size_bytes, v.original_filename, v_job.attempt_count + 1
    FROM public.document_versions v WHERE v.id = v_job.document_version_id;
END;
$$;

-- Worker: add a batch of fragments to its running job. The database checks
-- ownership, the lease, and that every text_hash is the SHA-256 of its text.
CREATE OR REPLACE FUNCTION public.add_extraction_fragments(p_job_id uuid, p_worker_id uuid, p_fragments jsonb)
RETURNS integer
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  v_job public.extraction_jobs%ROWTYPE;
  v_bad integer;
  v_count integer;
BEGIN
  SELECT * INTO v_job FROM public.extraction_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'Running' OR v_job.worker_id IS DISTINCT FROM p_worker_id OR v_job.lease_expires_at < now() THEN
    RAISE EXCEPTION 'This extraction job is not running for this worker' USING ERRCODE = '55000';
  END IF;
  IF jsonb_typeof(p_fragments) <> 'array' OR jsonb_array_length(p_fragments) = 0 OR jsonb_array_length(p_fragments) > 1000 THEN
    RAISE EXCEPTION 'A fragment batch must contain 1–1000 fragments' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_fragments) f
    WHERE encode(sha256(convert_to(f->>'text', 'UTF8')), 'hex') IS DISTINCT FROM f->>'text_hash';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% fragment(s) have a text_hash that does not match their text', v_bad USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.source_fragments (project_id, document_version_id, extraction_job_id, sequence, fragment_type, section_heading,
    section_number, section_path, page_start, page_end, text, text_hash, char_count, metadata)
  SELECT v_job.project_id, v_job.document_version_id, v_job.id, (f->>'sequence')::integer, f->>'fragment_type', f->>'section_heading',
    f->>'section_number', coalesce(ARRAY(SELECT jsonb_array_elements_text(f->'section_path')), '{}'),
    (f->>'page_start')::integer, (f->>'page_end')::integer, f->>'text', f->>'text_hash', length(f->>'text'),
    coalesce(f->'metadata', '{}'::jsonb)
  FROM jsonb_array_elements(p_fragments) f;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- Worker: finish its running job. The fragment count must match what was stored.
CREATE OR REPLACE FUNCTION public.complete_extraction_job(p_job_id uuid, p_worker_id uuid, p_extractor_version text, p_outcome text, p_diagnostics jsonb, p_fragment_count integer)
RETURNS TABLE (document_version_id uuid, project_id uuid, extraction_status text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_job public.extraction_jobs%ROWTYPE;
  v_stored integer;
  v_status text;
BEGIN
  SELECT * INTO v_job FROM public.extraction_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'Running' OR v_job.worker_id IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'This extraction job is not running for this worker' USING ERRCODE = '55000';
  END IF;
  IF p_outcome NOT IN ('completed', 'completed_with_warnings') THEN
    RAISE EXCEPTION 'Unknown outcome %', p_outcome USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_stored FROM public.source_fragments f WHERE f.extraction_job_id = p_job_id;
  IF v_stored <> p_fragment_count OR v_stored = 0 THEN
    RAISE EXCEPTION 'Expected % fragments but % were stored', p_fragment_count, v_stored USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.source_fragments f WHERE f.extraction_job_id = p_job_id GROUP BY f.extraction_job_id HAVING max(f.sequence) <> count(*)) THEN
    RAISE EXCEPTION 'Fragment sequence numbers are not contiguous' USING ERRCODE = '22023';
  END IF;
  v_status := CASE WHEN p_outcome = 'completed' THEN 'Completed' ELSE 'Completed with warnings' END;
  UPDATE public.extraction_jobs j SET status = 'Completed', completed_at = now(), lease_expires_at = NULL,
    extractor_version = p_extractor_version, outcome = p_outcome, diagnostics = p_diagnostics,
    warnings_count = coalesce(jsonb_array_length(p_diagnostics->'warnings'), 0), fragment_count = v_stored
  WHERE j.id = p_job_id;
  UPDATE public.document_versions v SET extraction_status = v_status, status_updated_at = now() WHERE v.id = v_job.document_version_id;
  document_version_id := v_job.document_version_id; project_id := v_job.project_id; extraction_status := v_status;
  RETURN NEXT;
END;
$$;

-- Worker: fail its running job with a category and a safe message. Any
-- partial fragments are discarded — only completed extractions keep output.
CREATE OR REPLACE FUNCTION public.fail_extraction_job(p_job_id uuid, p_worker_id uuid, p_category text, p_message text, p_extractor_version text, p_diagnostics jsonb)
RETURNS TABLE (document_version_id uuid, project_id uuid)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_job public.extraction_jobs%ROWTYPE;
BEGIN
  SELECT * INTO v_job FROM public.extraction_jobs j WHERE j.id = p_job_id FOR UPDATE;
  IF NOT FOUND OR v_job.status <> 'Running' OR v_job.worker_id IS DISTINCT FROM p_worker_id THEN
    RAISE EXCEPTION 'This extraction job is not running for this worker' USING ERRCODE = '55000';
  END IF;
  DELETE FROM public.source_fragments f WHERE f.extraction_job_id = p_job_id;
  UPDATE public.extraction_jobs j SET status = 'Failed', completed_at = now(), lease_expires_at = NULL,
    error_category = p_category, error_message = left(p_message, 1000), extractor_version = p_extractor_version, diagnostics = p_diagnostics
  WHERE j.id = p_job_id;
  UPDATE public.document_versions v SET extraction_status = 'Failed', status_updated_at = now() WHERE v.id = v_job.document_version_id;
  document_version_id := v_job.document_version_id; project_id := v_job.project_id;
  RETURN NEXT;
END;
$$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.queue_extraction_job(uuid, uuid, uuid, text)',
    'public.claim_extraction_job(uuid, text, text, integer)',
    'public.add_extraction_fragments(uuid, uuid, jsonb)',
    'public.complete_extraction_job(uuid, uuid, text, text, jsonb, integer)',
    'public.fail_extraction_job(uuid, uuid, text, text, text, jsonb)'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.source_fragments_immutable()', 'public.extraction_jobs_guard()', 'public.document_versions_queue_extraction()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
  END LOOP;
END
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE public.worker_credentials ENABLE ROW LEVEL SECURITY;  -- no policies: service role only
ALTER TABLE public.extraction_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_fragments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "extraction_jobs_select" ON public.extraction_jobs FOR SELECT TO authenticated USING ((SELECT public.can_read()));
CREATE POLICY "source_fragments_select" ON public.source_fragments FOR SELECT TO authenticated USING ((SELECT public.can_read()));

REVOKE ALL ON public.worker_credentials, public.extraction_jobs, public.source_fragments FROM anon;
REVOKE ALL ON public.worker_credentials FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.extraction_jobs, public.source_fragments FROM authenticated;
