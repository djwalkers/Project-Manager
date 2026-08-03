-- 026: Local Ollama gateway configuration.
--
-- Adds a single nullable column so the Local Ollama provider's gateway URL
-- lives alongside the existing provider/model config in ai_settings,
-- rather than in browser-only localStorage. This is not a secret — no
-- API key is ever stored for the "ollama" provider (see lib/ai/settings.ts
-- — its api_key column stays null for that row), and the gateway URL is
-- validated server-side to be loopback-only before it's ever saved.
--
-- The existing `model` column is reused for the Ollama model name (e.g.
-- "qwen3:8b") — no new column needed there.

ALTER TABLE ai_settings ADD COLUMN IF NOT EXISTS local_gateway_url text;
