// Universal Supabase anon client — works on both server (API routes, email crons)
// and client. Uses @supabase/supabase-js directly so it has no browser storage
// dependency, unlike createBrowserClient from @supabase/ssr.
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasAnonConfig = Boolean(supabaseUrl && supabaseAnonKey);

export const supabaseAnon = hasAnonConfig
  ? createClient(supabaseUrl as string, supabaseAnonKey as string)
  : null;
