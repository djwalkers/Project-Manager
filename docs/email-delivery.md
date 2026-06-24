# Automated email delivery

The Daily Brief and Weekly Executive Summary reuse the application’s existing deterministic content generators. Resend supplies delivery; Vercel Cron invokes the scheduled API routes.

## Environment variables

Add these server-side variables locally and in Vercel:

```dotenv
RESEND_API_KEY=re_...
DAILY_BRIEF_RECIPIENT=Andrew.Walker@bluestonex.com
RESEND_FROM_EMAIL=Project Manager <projects@your-verified-domain.com>
CRON_SECRET=generate-a-long-random-value
```

The existing `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` remain required for scheduled sends because cron cannot read browser localStorage. `RESEND_API_KEY` and `CRON_SECRET` must never use the `NEXT_PUBLIC_` prefix.

`DAILY_BRIEF_RECIPIENT` is the server fallback. Once Email Settings have been saved, the stored recipient takes precedence. If `RESEND_FROM_EMAIL` is omitted, the API uses Resend's onboarding sender for initial account testing only.

## Database migration

Run `supabase/migrations/007_email_delivery.sql` in the Supabase SQL editor. It creates:

- `email_settings`, with one stable default settings row;
- `email_activity_log`, containing every successful or failed attempt.

The migration is additive and safe to rerun. It follows the existing unauthenticated development posture by disabling RLS for these two tables. Add authentication and production RLS before exposing the app publicly.

## Resend configuration

1. Create or open a Resend account.
2. Add and verify the sending domain in Resend Domains.
3. Create an API key with send permission.
4. Set `RESEND_API_KEY` and a `RESEND_FROM_EMAIL` address on the verified domain.
5. During initial testing, Resend's onboarding sender can normally send only to the email associated with the Resend account.

## Vercel configuration

`vercel.json` invokes each route at both 06:00 and 07:00 UTC. The handlers check Europe/London local time and only send at 07:00, which preserves the intended hour across GMT and BST. A same-day successful-send check prevents duplicate scheduled delivery.

Add all environment variables to the Production environment in Vercel, then redeploy. Vercel sends `Authorization: Bearer <CRON_SECRET>` to cron endpoints when `CRON_SECRET` is configured.

## Deployment

1. Run migration 007 in Supabase.
2. Verify the existing CR028 data and snapshots are visible to the Supabase anon client.
3. Verify the sender domain in Resend and create an API key.
4. Add the Supabase, Resend, sender, recipient, and cron variables to Vercel.
5. Deploy the repository; Vercel reads `vercel.json` automatically.
6. Open Email Settings, save the recipient, and enable the required schedules.
7. Open System Health and confirm Resend, recipient, and schedule indicators.

## Testing

1. Keep both schedules disabled initially.
2. Use **Send Test Email** and confirm receipt plus a successful activity row.
3. Use **Send Daily Brief Now** and verify its subject, HTML sections, and plain-text alternative.
4. Use **Send Weekly Summary Now** and verify trend, governance, delivery, milestone, and intelligence sections.
5. Temporarily remove `RESEND_API_KEY`, send a test, and confirm a logged failure without an application crash; then restore it.
6. Temporarily enter an invalid recipient and confirm the validation failure is logged.
7. Recheck System Health for the latest daily/weekly status and timestamp.
8. Enable schedules and inspect Vercel's Cron dashboard after the next 07:00 Europe/London window.

Local mode supports settings, manual content generation, delivery attempts, and a browser-local activity log. Scheduled Vercel delivery requires Supabase because browser localStorage is unavailable to cron.
