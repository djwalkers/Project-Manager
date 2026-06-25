-- Extend discovery_questions with query-tracking fields
ALTER TABLE discovery_questions
  ADD COLUMN IF NOT EXISTS raised_to    text,
  ADD COLUMN IF NOT EXISTS raised_date  timestamptz,
  ADD COLUMN IF NOT EXISTS response     text,
  ADD COLUMN IF NOT EXISTS answered_by  text,
  ADD COLUMN IF NOT EXISTS answered_date timestamptz;

-- Microsoft OAuth token storage (server-side only; anon key cannot read this table)
CREATE TABLE IF NOT EXISTS microsoft_tokens (
  id           text PRIMARY KEY DEFAULT 'singleton',
  user_email   text NOT NULL,
  display_name text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at   timestamptz NOT NULL,
  scope        text,
  created_at   timestamptz DEFAULT now() NOT NULL,
  updated_at   timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE microsoft_tokens ENABLE ROW LEVEL SECURITY;

-- Only service-role callers (API routes) may access tokens
-- Deny all anon/authenticated access from the browser client
CREATE POLICY "No public access to microsoft tokens"
  ON microsoft_tokens FOR ALL
  TO public
  USING (false);
