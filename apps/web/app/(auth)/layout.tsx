import type { ReactNode } from "react";
import { BRAND } from "@/lib/brand";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        <p className="mb-1 text-center text-2xl font-semibold">{BRAND.name}</p>
        <p className="mb-6 text-center text-sm text-muted">{BRAND.tagline}</p>
        <div className="rounded-lg border border-border bg-surface p-6">{children}</div>
      </div>
    </main>
  );
}
