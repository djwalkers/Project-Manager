import { LoginForm } from "@/components/login-form";
import Image from "next/image";
import { BRAND } from "@/lib/brand";

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <Image src={BRAND.logo.mark} alt="" width={56} height={56} priority />
          <div className="text-center">
            <h1 className="text-xl font-semibold tracking-tight">{BRAND.productName}</h1>
            <p className="text-sm text-muted-foreground">{BRAND.productDescription}</p>
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
