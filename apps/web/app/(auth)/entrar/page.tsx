"use client";

import Link from "next/link";
import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ mfa_required: boolean }>("/v1/auth/login", { method: "POST", body: { email, password } });
      const next = new URLSearchParams(window.location.search).get("next");
      window.location.href = r.mfa_required ? "/mfa" : next && next.startsWith("/") && !next.startsWith("//") ? next : "/painel";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Falha de rede");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h1 className="text-lg font-semibold">Entrar</h1>
      {error && <Alert tone="err" title={error} />}
      <Field label="E-mail">{(id) => <Input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Field label="Senha">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" busy={busy} className="w-full">
        Entrar
      </Button>
      <div className="flex justify-between text-sm">
        <Link className="text-primary underline" href="/cadastro">
          Criar conta
        </Link>
        <Link className="text-primary underline" href="/esqueci-senha">
          Esqueci a senha
        </Link>
      </div>
    </form>
  );
}
