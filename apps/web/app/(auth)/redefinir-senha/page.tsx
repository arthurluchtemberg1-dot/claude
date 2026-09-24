"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function ResetPage() {
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const token = new URLSearchParams(window.location.search).get("token") ?? "";
          await api("/v1/auth/password/reset", { method: "POST", body: { token, password } });
          setMsg({ tone: "ok", text: "Senha alterada. Todas as sessões foram encerradas; entre novamente." });
        } catch (err) {
          setMsg({ tone: "err", text: err instanceof ApiError ? err.message : "Falha de rede" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Nova senha</h1>
      {msg && <Alert tone={msg.tone} title={msg.text} />}
      <Field label="Nova senha" hint="Mínimo de 10 caracteres.">{(id) => <Input id={id} type="password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      <Button type="submit" busy={busy} className="w-full">
        Salvar
      </Button>
      <a className="block text-sm text-primary underline" href="/entrar">
        Entrar
      </a>
    </form>
  );
}
