-- 037: Re-extraction when a newer extractor is available (Phase 1B follow-up).
--
-- Migration 036 refused to re-queue any version whose latest job completed,
-- so an improved extractor could never be applied to an existing upload.
-- This migration allows exactly one deliberate case: a Manager/Admin asks
-- for re-extraction AND the extractor version the worker actually reports
-- is semantically newer than the version used by the version's latest
-- successful extraction. It always creates a NEW job; earlier jobs, their
-- fragments, diagnostics and extractor versions are never modified (036's
-- immutability triggers still apply). Same-version repeats remain refused;
-- a failed run can still be retried as before.
--
-- A failed newer run no longer hides the previous usable extraction: the
-- version's canonical extraction_status returns to that successful status
-- (the failure stays on the job, for display). With no earlier success the
-- status is 'Failed', as before.
--
-- Preserved: one active job per version, lease/ownership checks, hash
-- verification, RLS (read: can_read; write: service role), anon refusal.

-- The extractor version the worker reports (heartbeat/claim), and the
-- version a re-extraction was requested for.
ALTER TABLE public.worker_credentials ADD COLUMN IF NOT EXISTS last_seen_extractor_version text
  CHECK (last_seen_extractor_version IS NULL OR last_seen_extractor_version ~ '^\d{1,6}(\.\d{1,6}){0,2}$');
ALTER TABLE public.extraction_jobs ADD COLUMN IF NOT EXISTS requested_extractor_version text;
ALTER TABLE public.extraction_jobs DROP CONSTRAINT IF EXISTS extraction_jobs_trigger_check;
ALTER TABLE public.extraction_jobs ADD CONSTRAINT extraction_jobs_trigger_check CHECK (trigger IN ('upload', 'manual', 'retry', 'upgrade'));

-- Semantic version comparison of MAJOR[.MINOR[.PATCH]] (missing parts = 0;
-- a pre-release/build suffix after '-' or '+' is ignored). Parts compare as
-- integers, so '1.10.0' > '1.9.0'. NULL when either side is not a version.
CREATE OR REPLACE FUNCTION public.semver_parts(v text)
RETURNS integer[] LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN core ~ '^\d{1,6}(\.\d{1,6}){0,2}$'
    THEN (string_to_array(core, '.')::integer[] || ARRAY[0, 0])[1:3] END
  FROM (SELECT split_part(split_part(v, '-', 1), '+', 1) AS core) s;
$$;

CREATE OR REPLACE FUNCTION public.compare_semver(a text, b text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE WHEN x IS NULL OR y IS NULL THEN NULL WHEN x > y THEN 1 WHEN x < y THEN -1 ELSE 0 END
  FROM (SELECT public.semver_parts(a) AS x, public.semver_parts(b) AS y) p;
$$;

-- Status a version should show after a run fails: the latest successful
-- extraction's status if there is one, otherwise 'Failed'.
CREATE OR REPLACE FUNCTION public.extraction_status_after_failure(p_version_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT coalesce((
    SELECT CASE WHEN j.outcome = 'completed' THEN 'Completed' ELSE 'Completed with warnings' END
    FROM public.extraction_jobs j
    WHERE j.document_version_id = p_version_id AND j.status = 'Completed'
    ORDER BY j.completed_at DESC, j.id DESC LIMIT 1
  ), 'Failed');
$$;

-- Queue / retry / re-extract. p_available_extractor_version is supplied by
-- the server from the worker credential's last reported extractor version
-- (never from the browser), and is only used when p_mode = 'upgrade'.
CREATE OR REPLACE FUNCTION public.queue_extraction_job(p_project_id uuid, p_version_id uuid, p_user_id uuid, p_user_name text, p_mode text, p_available_extractor_version text)
RETURNS TABLE (job_id uuid, trigger text, previous_status text, previous_extractor_version text)
LANGUAGE plpgsql SET search_path = '' AS $$
#variable_conflict use_variable
DECLARE
  v_version public.document_versions%ROWTYPE;
  v_latest public.extraction_jobs%ROWTYPE;
  v_success public.extraction_jobs%ROWTYPE;
  v_has_latest boolean;
  v_has_success boolean;
BEGIN
  IF p_mode NOT IN ('manual', 'upgrade') THEN RAISE EXCEPTION 'Unknown mode %', p_mode USING ERRCODE = '22023'; END IF;
  SELECT * INTO v_version FROM public.document_versions v WHERE v.id = p_version_id AND v.project_id = p_project_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Document version not found in this project' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.documents d WHERE d.id = v_version.document_id AND d.archived_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This source document is archived' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_latest FROM public.extraction_jobs j WHERE j.document_version_id = p_version_id ORDER BY j.queued_at DESC, j.id DESC LIMIT 1;
  v_has_latest := FOUND;
  IF v_has_latest AND v_latest.status IN ('Queued', 'Running') THEN
    RAISE EXCEPTION 'Extraction is already % for this version', lower(v_latest.status) USING ERRCODE = '23505';
  END IF;
  SELECT * INTO v_success FROM public.extraction_jobs j WHERE j.document_version_id = p_version_id AND j.status = 'Completed' ORDER BY j.completed_at DESC, j.id DESC LIMIT 1;
  v_has_success := FOUND;

  IF p_mode = 'upgrade' THEN
    IF NOT v_has_success THEN
      RAISE EXCEPTION 'This version has no successful extraction to upgrade' USING ERRCODE = '55000';
    END IF;
    IF coalesce(public.compare_semver(p_available_extractor_version, v_success.extractor_version), 0) <= 0 THEN
      RAISE EXCEPTION 'Already extracted with extractor % — the worker reports %, which is not newer', v_success.extractor_version, coalesce(p_available_extractor_version, 'no version') USING ERRCODE = '55000';
    END IF;
    trigger := 'upgrade';
  ELSIF v_has_latest AND v_latest.status = 'Failed' THEN
    trigger := 'retry';
  ELSIF v_has_success THEN
    RAISE EXCEPTION 'This version has already been extracted; re-extract only when a newer extractor is available' USING ERRCODE = '55000';
  ELSE
    trigger := 'manual';
  END IF;

  previous_status := v_version.extraction_status;
  previous_extractor_version := CASE WHEN v_has_success THEN v_success.extractor_version END;
  INSERT INTO public.extraction_jobs (project_id, document_version_id, trigger, requested_by, requested_by_name, requested_extractor_version)
  VALUES (p_project_id, p_version_id, trigger, p_user_id, p_user_name, CASE WHEN trigger = 'upgrade' THEN p_available_extractor_version END)
  RETURNING id INTO job_id;
  UPDATE public.document_versions v SET extraction_status = 'Queued', status_updated_at = now() WHERE v.id = p_version_id;
  RETURN NEXT;
END;
$$;

-- The 036 signature stays (as a manual-mode wrapper) so already-deployed app
-- code keeps working until it is updated; it can never request an upgrade.
CREATE OR REPLACE FUNCTION public.queue_extraction_job(p_project_id uuid, p_version_id uuid, p_user_id uuid, p_user_name text)
RETURNS TABLE (job_id uuid, trigger text, previous_status text)
LANGUAGE sql SET search_path = '' AS $$
  SELECT q.job_id, q.trigger, q.previous_status
  FROM public.queue_extraction_job(p_project_id, p_version_id, p_user_id, p_user_name, 'manual', NULL) q;
$$;

-- A failed run keeps the previous usable extraction visible (see header).
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
  UPDATE public.document_versions v SET extraction_status = public.extraction_status_after_failure(v_job.document_version_id), status_updated_at = now()
  WHERE v.id = v_job.document_version_id;
  document_version_id := v_job.document_version_id; project_id := v_job.project_id;
  RETURN NEXT;
END;
$$;

-- Same rule when a crashed worker's job exhausts its attempts.
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
  UPDATE public.document_versions v
  SET extraction_status = CASE WHEN u.status = 'Failed' THEN public.extraction_status_after_failure(u.document_version_id) ELSE u.status END,
      status_updated_at = now()
  FROM updated u WHERE v.id = u.document_version_id;
  DELETE FROM public.source_fragments f USING public.extraction_jobs j WHERE f.extraction_job_id = j.id AND j.status IN ('Queued', 'Failed') AND j.worker_id IS NOT NULL;
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

REVOKE ALL ON FUNCTION public.queue_extraction_job(uuid, uuid, uuid, text, text, text), public.queue_extraction_job(uuid, uuid, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.queue_extraction_job(uuid, uuid, uuid, text, text, text), public.queue_extraction_job(uuid, uuid, uuid, text) TO service_role;
REVOKE ALL ON FUNCTION public.fail_extraction_job(uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_extraction_job(uuid, uuid, text, text, text, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.claim_extraction_job(uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_extraction_job(uuid, text, text, integer) TO service_role;
REVOKE ALL ON FUNCTION public.compare_semver(text, text), public.semver_parts(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compare_semver(text, text), public.semver_parts(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.extraction_status_after_failure(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.extraction_status_after_failure(uuid) TO service_role;
