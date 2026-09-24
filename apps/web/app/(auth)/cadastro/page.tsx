"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function SignupPage() {
  const [form, setForm] = useState({ displayName: "", email: "", password: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/v1/auth/signup", { method: "POST", body: form });
      window.location.href = "/onboarding";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha de rede");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="text-lg font-semibold">Criar conta</h1>
      {error && <Alert tone="err" title={error} />}
      <Field label="Nome">{(id) => <Input id={id} required autoComplete="name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />}</Field>
      <Field label="E-mail">{(id) => <Input id={id} type="email" required autoComplete="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
      <Field label="Senha" hint="Mínimo de 10 caracteres.">
        {(id) => <Input id={id} type="password" required minLength={10} autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />}
      </Field>
      <Button type="submit" busy={busy} className="w-full">
        Criar conta
      </Button>
      <p className="text-sm text-muted">
        Já tem conta?{" "}
        <Link className="text-primary underline" href="/entrar">
          Entrar
        </Link>
      </p>
    </form>
  );
}
