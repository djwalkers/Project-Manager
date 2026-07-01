"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/header";
import { MobileNav, Sidebar } from "@/components/sidebar";
import { CommandPalette } from "@/components/command-palette";
import { LoadingState } from "@/components/data-state";
import { useAuth } from "@/contexts/auth-context";
import { hasSupabaseConfig } from "@/lib/supabase/client";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  useEffect(() => {
    if (!loading && !user && hasSupabaseConfig) {
      router.push("/login");
    }
  }, [loading, user, router]);

  // ⌘K / Ctrl+K opens the command palette
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

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
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <div className="min-w-0 flex-1">
        <Header onMenuOpen={() => setMobileNavOpen(true)} />
        <main className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
