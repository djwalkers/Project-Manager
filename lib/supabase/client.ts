"use client";

import { createBrowserClient } from "@supabase/ssr";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabaseAnonKey);

export function createClient() {
  return createBrowserClient(supabaseUrl as string, supabaseAnonKey as string);
}

// Singleton for components that don't need SSR-cookie handling
export const supabase = hasSupabaseConfig ? createClient() : null;
