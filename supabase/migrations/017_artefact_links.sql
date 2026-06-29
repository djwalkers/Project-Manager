-- 017: Artefact links — flexible many-to-many relationships between project artefacts.
-- Supports traceability between requirements, decisions, actions, deliverables, risks, tests and queries.

CREATE TABLE IF NOT EXISTS artefact_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid REFERENCES projects(id) ON DELETE CASCADE,
  source_entity text NOT NULL,
  source_id     uuid NOT NULL,
  target_entity text NOT NULL,
  target_id     uuid NOT NULL,
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS artefact_links_source_idx ON artefact_links(source_entity, source_id);
CREATE INDEX IF NOT EXISTS artefact_links_target_idx ON artefact_links(target_entity, target_id);

ALTER TABLE artefact_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "artefact_links_anon_read"  ON artefact_links FOR SELECT TO anon        USING (true);
CREATE POLICY "artefact_links_auth_all"   ON artefact_links FOR ALL    TO authenticated USING (true) WITH CHECK (true);
