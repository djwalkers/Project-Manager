-- Meeting Intelligence: AI-processed meeting notes and suggestions
CREATE TABLE IF NOT EXISTS meeting_intelligence (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       uuid REFERENCES projects(id) ON DELETE CASCADE,
  meeting_ref      text NOT NULL,
  title            text NOT NULL,
  meeting_date     date,
  source           text NOT NULL DEFAULT 'Teams',
  participants     text,
  ai_summary       text,
  raw_input        text,
  processing_status text NOT NULL DEFAULT 'Draft',
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_intelligence_project_id_idx ON meeting_intelligence(project_id);
CREATE INDEX IF NOT EXISTS meeting_intelligence_date_idx       ON meeting_intelligence(meeting_date DESC);

-- Suggestions produced by AI analysis of meeting notes
CREATE TABLE IF NOT EXISTS meeting_suggestions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid REFERENCES projects(id) ON DELETE CASCADE,
  meeting_id           uuid REFERENCES meeting_intelligence(id) ON DELETE CASCADE,
  entity_type          text NOT NULL,
  action               text NOT NULL DEFAULT 'create',
  title                text NOT NULL,
  description          text,
  confidence           text NOT NULL DEFAULT 'Medium',
  reason               text,
  status               text NOT NULL DEFAULT 'Pending',
  existing_record_id   uuid,
  existing_record_ref  text,
  data_payload         jsonb,
  feedback             text,
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_suggestions_meeting_id_idx  ON meeting_suggestions(meeting_id);
CREATE INDEX IF NOT EXISTS meeting_suggestions_project_id_idx  ON meeting_suggestions(project_id);

-- RLS
ALTER TABLE meeting_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_suggestions  ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_intelligence' AND policyname='anon_read_meeting_intelligence') THEN
    CREATE POLICY anon_read_meeting_intelligence   ON meeting_intelligence FOR SELECT TO anon          USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_intelligence' AND policyname='auth_all_meeting_intelligence') THEN
    CREATE POLICY auth_all_meeting_intelligence    ON meeting_intelligence FOR ALL    TO authenticated  USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_intelligence' AND policyname='service_all_meeting_intelligence') THEN
    CREATE POLICY service_all_meeting_intelligence ON meeting_intelligence FOR ALL    TO service_role   USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_suggestions' AND policyname='anon_read_meeting_suggestions') THEN
    CREATE POLICY anon_read_meeting_suggestions    ON meeting_suggestions  FOR SELECT TO anon          USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_suggestions' AND policyname='auth_all_meeting_suggestions') THEN
    CREATE POLICY auth_all_meeting_suggestions     ON meeting_suggestions  FOR ALL    TO authenticated  USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meeting_suggestions' AND policyname='service_all_meeting_suggestions') THEN
    CREATE POLICY service_all_meeting_suggestions  ON meeting_suggestions  FOR ALL    TO service_role   USING (true);
  END IF;
END $$;
