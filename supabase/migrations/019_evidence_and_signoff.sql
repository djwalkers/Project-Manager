-- 019: Evidence and Requirement Sign-off
-- Evidence records prove acceptance criteria have been met.
-- Sign-offs capture formal approval from each stakeholder group.

CREATE TABLE IF NOT EXISTS evidence (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     uuid REFERENCES projects(id) ON DELETE CASCADE,
  ac_id          uuid REFERENCES acceptance_criteria(id) ON DELETE CASCADE,
  evidence_type  text NOT NULL DEFAULT 'Other',
  title          text NOT NULL,
  description    text,
  url            text,
  evidence_date  date,
  owner          text,
  created_at     timestamptz DEFAULT now(),
  updated_at     timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS evidence_ac_idx      ON evidence(ac_id);
CREATE INDEX IF NOT EXISTS evidence_project_idx ON evidence(project_id);

ALTER TABLE evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY "evidence_anon_read" ON evidence FOR SELECT TO anon        USING (true);
CREATE POLICY "evidence_auth_all"  ON evidence FOR ALL    TO authenticated USING (true) WITH CHECK (true);

-- Requirement sign-off — one record per sign-off type per requirement
CREATE TABLE IF NOT EXISTS requirement_sign_offs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid REFERENCES projects(id) ON DELETE CASCADE,
  requirement_id   uuid REFERENCES requirements(id) ON DELETE CASCADE,
  sign_off_type    text NOT NULL, -- Business | Technical | Testing | Customer
  person           text,
  sign_off_date    date,
  status           text NOT NULL DEFAULT 'Pending',
  notes            text,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS req_sign_offs_req_idx     ON requirement_sign_offs(requirement_id);
CREATE INDEX IF NOT EXISTS req_sign_offs_project_idx ON requirement_sign_offs(project_id);

ALTER TABLE requirement_sign_offs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "req_sign_offs_anon_read" ON requirement_sign_offs FOR SELECT TO anon        USING (true);
CREATE POLICY "req_sign_offs_auth_all"  ON requirement_sign_offs FOR ALL    TO authenticated USING (true) WITH CHECK (true);
