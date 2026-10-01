-- 045: AC generation — persist the semantic-fidelity repair stage (AC prompts
-- 1.2.0). A criterion whose expected result adds a rule the input never
-- states gets one bounded repair attempt; its validated output is stored like
-- every other stage so a retry can reuse it. Only the allowed stage names
-- change: existing stage results, runs and output are untouched.

ALTER TABLE public.ac_generation_stage_results DROP CONSTRAINT ac_generation_stage_results_stage_check;
ALTER TABLE public.ac_generation_stage_results
  ADD CONSTRAINT ac_generation_stage_results_stage_check CHECK (stage IN ('obligations', 'criteria', 'coverage', 'repair'));
