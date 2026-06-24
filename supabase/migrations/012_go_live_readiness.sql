-- 012: Go-Live Readiness and Cutover Plan

CREATE TABLE IF NOT EXISTS go_live_checklists (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category    text NOT NULL,
  item        text NOT NULL,
  owner       text,
  status      text NOT NULL DEFAULT 'Not Started',
  due_date    date,
  completed_date date,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE go_live_checklists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_go_live_checklists" ON go_live_checklists FOR ALL TO anon USING (true) WITH CHECK (true);

CREATE TABLE IF NOT EXISTS cutover_plan (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  step_number integer NOT NULL,
  activity    text NOT NULL,
  owner       text,
  planned_time text,
  actual_time text,
  status      text NOT NULL DEFAULT 'Not Started',
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cutover_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon_all_cutover_plan" ON cutover_plan FOR ALL TO anon USING (true) WITH CHECK (true);
