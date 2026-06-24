"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { createClient, hasSupabaseConfig } from "@/lib/supabase/client";
import type { AuthUser, UserRole } from "@/lib/auth";
import { setAuditUser } from "@/lib/audit";

interface AuthContextValue {
  user: AuthUser | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signIn: async () => ({ error: null }),
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

async function fetchProfile(userId: string): Promise<{ fullName: string; role: UserRole }> {
  const client = createClient();
  const { data } = await client
    .from("user_profiles")
    .select("full_name, role")
    .eq("id", userId)
    .single();
  return {
    fullName: data?.full_name ?? "Unknown",
    role: (data?.role ?? "Viewer") as UserRole,
  };
}

function buildAuthUser(user: User, fullName: string, role: UserRole): AuthUser {
  return {
    id: user.id,
    email: user.email ?? "",
    fullName,
    role,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const hydrateUser = useCallback(async (supabaseUser: User | null) => {
    if (!supabaseUser) {
      setUser(null);
      setAuditUser(null);
      return;
    }
    const profile = await fetchProfile(supabaseUser.id);
    const authUser = buildAuthUser(supabaseUser, profile.fullName, profile.role);
    setUser(authUser);
    setAuditUser({ id: authUser.id, name: authUser.fullName });
  }, []);

  useEffect(() => {
    if (!hasSupabaseConfig) {
      // Local mode — create a synthetic admin user so the UI still renders
      const localUser = { id: "local", email: "local@dev", fullName: "Local Dev", role: "Admin" as UserRole };
      setUser(localUser);
      setAuditUser({ id: localUser.id, name: localUser.fullName });
      setLoading(false);
      return;
    }

    const client = createClient();

    client.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      await hydrateUser(s?.user ?? null);
      setLoading(false);
    });

    const { data: { subscription } } = client.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      await hydrateUser(s?.user ?? null);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, [hydrateUser]);

  const signIn = useCallback(async (email: string, password: string) => {
    const client = createClient();
    const { error } = await client.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }, []);

  const signOut = useCallback(async () => {
    const client = createClient();
    await client.auth.signOut();
    setUser(null);
    setSession(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
