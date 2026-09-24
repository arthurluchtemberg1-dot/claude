"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const r = await api<{ message: string }>("/v1/auth/password/forgot", { method: "POST", body: { email } });
          setMsg({ tone: "ok", text: r.message });
        } catch (err) {
          setMsg({ tone: "err", text: err instanceof ApiError ? err.message : "Falha de rede" });
        } finally {
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Recuperar senha</h1>
      {msg && <Alert tone={msg.tone} title={msg.text} />}
      <Field label="E-mail">{(id) => <Input id={id} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
      <Button type="submit" busy={busy} className="w-full">
        Enviar link
      </Button>
    </form>
  );
}
