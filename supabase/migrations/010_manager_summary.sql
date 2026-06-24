-- 010: Add manager summary to email settings and activity log

ALTER TABLE email_settings
  ADD COLUMN IF NOT EXISTS manager_summary_enabled boolean NOT NULL DEFAULT false;

-- Allow "Manager Summary" as a valid email_type in activity log
ALTER TABLE email_activity_log
  DROP CONSTRAINT IF EXISTS email_activity_log_email_type_check;

ALTER TABLE email_activity_log
  ADD CONSTRAINT email_activity_log_email_type_check
    CHECK (email_type IN ('Test', 'Daily Brief', 'Weekly Summary', 'Manager Summary'));
