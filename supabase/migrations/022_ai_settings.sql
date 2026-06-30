-- AI Settings: store provider configuration and API keys server-side.
-- The api_key column is NEVER returned to the client; API routes mask it as a boolean.

CREATE TABLE IF NOT EXISTS ai_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider   text NOT NULL DEFAULT 'none',  -- none | openai | gemini | anthropic
  model      text,
  api_key    text,
  enabled    boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE ai_settings ENABLE ROW LEVEL SECURITY;

-- Anon and authenticated users can read metadata rows (API routes strip api_key before responding).
CREATE POLICY "anon_read_ai_settings"   ON ai_settings FOR SELECT TO anon          USING (true);
CREATE POLICY "auth_read_ai_settings"   ON ai_settings FOR SELECT TO authenticated USING (true);
-- Service role bypasses RLS automatically — used by server-side API routes for writes.
CREATE POLICY "service_all_ai_settings" ON ai_settings FOR ALL    TO service_role  USING (true) WITH CHECK (true);
