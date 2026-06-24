import { LoginForm } from "@/components/login-form";
import { Boxes } from "lucide-react";

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <Boxes className="h-6 w-6" aria-hidden="true" />
          </span>
          <div className="text-center">
            <h1 className="text-xl font-semibold">Project Manager</h1>
            <p className="text-sm text-muted-foreground">CR028 Control Centre</p>
          </div>
        </div>

        {/* Form card */}
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h2 className="mb-1 text-base font-semibold">Sign in</h2>
          <p className="mb-5 text-sm text-muted-foreground">
            Enter your credentials to access the dashboard.
          </p>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
