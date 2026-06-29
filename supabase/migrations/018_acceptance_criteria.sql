-- 018: Acceptance Criteria — defines what "done" means for each requirement.
-- Optional per requirement; evidence used for SIT, UAT and project sign-off.

CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id uuid REFERENCES requirements(id) ON DELETE CASCADE,
  ac_ref         text NOT NULL,
  criterion      text NOT NULL,
  description    text,
  status         text NOT NULL DEFAULT 'Not Started',
  owner          text,
  evidence       text,
  notes          text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS acceptance_criteria_req_idx     ON acceptance_criteria(requirement_id);
CREATE INDEX IF NOT EXISTS acceptance_criteria_project_idx ON acceptance_criteria(project_id);

ALTER TABLE acceptance_criteria ENABLE ROW LEVEL SECURITY;

CREATE POLICY "acceptance_criteria_anon_read"
  ON acceptance_criteria FOR SELECT TO anon        USING (true);
CREATE POLICY "acceptance_criteria_auth_all"
  ON acceptance_criteria FOR ALL    TO authenticated USING (true) WITH CHECK (true);
