-- 023: Security hardening.
--
-- go_live_checklists and cutover_plan are now served exclusively through
-- authenticated Next.js API routes (app/api/go-live/checklists,
-- app/api/go-live/cutover) using the service-role client, which bypasses
-- RLS entirely. The permissive anon policies that used to be the only thing
-- allowing access to these tables are no longer needed and are removed.
--
-- ai_settings.api_key must never be readable by client code. The metadata
-- endpoint (GET /api/ai-settings) already reads via the service-role/anon
-- fallback client server-side and strips api_key before responding, so no
-- legitimate caller depends on either read policy below — both are removed.

DROP POLICY IF EXISTS "anon_all_go_live_checklists" ON go_live_checklists;
DROP POLICY IF EXISTS "anon_all_cutover_plan" ON cutover_plan;

DROP POLICY IF EXISTS "anon_read_ai_settings" ON ai_settings;
DROP POLICY IF EXISTS "auth_read_ai_settings" ON ai_settings;

-- service_all_ai_settings (service_role) is untouched — service_role
-- bypasses RLS regardless, and it remains the only way to read or write
-- ai_settings, go_live_checklists, or cutover_plan going forward.
