"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { Sidebar } from "@/components/sidebar";
import { LoadingState } from "@/components/data-state";
import { useAuth } from "@/contexts/auth-context";
import { hasSupabaseConfig } from "@/lib/supabase/client";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading && !user && hasSupabaseConfig) {
      router.push("/login");
    }
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <LoadingState />
      </div>
    );
  }

  if (!user && hasSupabaseConfig) return null;

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar />
      <div className="min-w-0 flex-1">
        <Header />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
