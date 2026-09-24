"use client";

import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ApiError } from "@/lib/api";

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

export function Button({ variant = "primary", busy, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean }) {
  const styles = {
    primary: "bg-primary text-primary-contrast hover:opacity-90",
    secondary: "bg-surface-2 text-text border border-border hover:bg-surface",
    danger: "bg-err text-white hover:opacity-90",
    ghost: "text-text hover:bg-surface-2",
  }[variant];
  return (
    <button
      {...p}
      disabled={p.disabled || busy}
      aria-busy={busy || undefined}
      className={cx("inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60", styles, className)}
    >
      {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="text-xs text-err" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const inputCls = "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-muted";

export function Input(p: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...p} className={cx(inputCls, p.className)} />;
}

export function Textarea(p: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...p} className={cx(inputCls, "font-mono", p.className)} />;
}

export function Select(p: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...p} className={cx(inputCls, p.className)} />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-border bg-surface p-4", className)}>
      {(title || actions) && (
        <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: "neutral" | "ok" | "warn" | "err" | "info"; children: ReactNode; title?: string }) {
  const t = {
    neutral: "border-border text-muted",
    ok: "border-ok text-ok",
    warn: "border-warn text-warn",
    err: "border-err text-err",
    info: "border-primary text-primary",
  }[tone];
  return (
    <span title={title} className={cx("inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium", t)}>
      {children}
    </span>
  );
}

export function Alert({ tone = "info", title, children }: { tone?: "info" | "warn" | "err" | "ok"; title?: string; children?: ReactNode }) {
  const t = { info: "border-primary", warn: "border-warn", err: "border-err", ok: "border-ok" }[tone];
  return (
    <div role={tone === "err" ? "alert" : "status"} className={cx("rounded-md border-l-4 bg-surface p-3 text-sm", t)}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className="text-muted">{children}</div>}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: ApiError | Error | null; onRetry?: () => void }) {
  if (!error) return null;
  const rid = (error as ApiError).requestId;
  return (
    <Alert tone="err" title={error.message}>
      {rid && <span className="font-mono text-xs">request_id: {rid}</span>}
      {onRetry && (
        <div className="mt-2">
          <Button variant="secondary" onClick={onRetry}>
            Tentar novamente
          </Button>
        </div>
      )}
    </Alert>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded bg-surface-2", className ?? "h-4 w-full")} aria-hidden />;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-6 text-center">
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 text-sm text-muted">{children}</div>}
    </div>
  );
}

export function Table({ headers, children, caption }: { headers: ReactNode[]; children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {headers.map((h, i) => (
              <th key={i} scope="col" className="px-3 py-2 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx("px-3 py-2 align-top", className)}>{children}</td>;
}

/** Mensagem de resultado somente após confirmação do servidor (R39-03). */
export function useToast() {
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? (
    <div role="status" aria-live="polite" className={cx("fixed bottom-4 right-4 z-50 max-w-sm rounded-md border bg-surface p-3 text-sm shadow-lg", msg.tone === "ok" ? "border-ok" : "border-err")}>
      {msg.text}
    </div>
  ) : null;
  return { toast: setMsg, toastNode: node };
}

export function CopyButton({ value, label = "Copiar" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? "Copiado" : label}
    </Button>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 max-w-3xl text-sm text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  );
}
