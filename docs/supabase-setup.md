# Supabase setup

This app uses Supabase when public project credentials are present. Without them, it keeps using the existing browser `localStorage` data and shows a local-mode banner.

## 1. Create a Supabase project

Create a project in the Supabase dashboard and wait for the database to become available.

This MVP does not include authentication or Row Level Security policies. Use this configuration only for controlled development with non-sensitive data. Before deploying publicly, add authentication and enable RLS with appropriate policies.

## 2. Configure the environment

Copy `.env.local.example` to `.env.local`, then add the project values from **Project Settings → API**:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

Never put a service-role key in a `NEXT_PUBLIC_` variable.

## 3. Create the database schema

Open the Supabase SQL editor and run:

`supabase/migrations/001_initial_schema.sql`

The migration creates the project-control tables, indexes, update triggers, and stable unique keys used by the seed script.

## 4. Seed CR028

In the SQL editor, run:

`supabase/seed.sql`

The seed is idempotent: rerunning it updates the stable CR028 records instead of adding duplicates.

## 5. Restart and verify

Restart the development server so Next.js reads `.env.local`:

```bash
npm run dev
```

Open the dashboard and confirm that the local-mode banner is gone. The seeded dashboard should show:

- 10 open requirements
- 5 open risks
- 5 open actions
- 4 open decisions
- 5 pending test cases

Create or edit one record, refresh the page, and confirm that the change remains visible. The same change should also appear in the matching table in Supabase.
