"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Field, Input } from "@/components/ui";

export default function MfaPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api("/v1/auth/mfa/verify", { method: "POST", body: { code } });
          window.location.href = "/painel";
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Falha de rede");
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Autenticação multifator</h1>
      <p className="text-sm text-muted">Informe o código de 6 dígitos do seu aplicativo autenticador.</p>
      {error && <Alert tone="err" title={error} />}
      <Field label="Código">{(id) => <Input id={id} inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />}</Field>
      <Button type="submit" busy={busy} className="w-full">
        Verificar
      </Button>
    </form>
  );
}
