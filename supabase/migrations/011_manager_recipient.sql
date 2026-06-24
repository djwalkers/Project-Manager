-- 011: Separate manager recipient email
ALTER TABLE email_settings
  ADD COLUMN IF NOT EXISTS manager_recipient_email text;
