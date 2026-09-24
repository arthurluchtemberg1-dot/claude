"use client";

import { useState } from "react";
import { api, ApiError, setOrgId } from "@/lib/api";
import { Alert, Button, Field, Input, Select } from "@/components/ui";

export default function OnboardingPage() {
  const [form, setForm] = useState({ name: "", timezone: "America/Sao_Paulo", currency: "BRL", internal_mode: false });
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
          const r = await api<{ id: string }>("/v1/orgs", { method: "POST", body: form });
          setOrgId(r.id);
          window.location.href = "/integracoes";
        } catch (err) {
          if (err instanceof ApiError && err.status === 401) window.location.href = "/entrar";
          setError(err instanceof ApiError ? err.message : "Falha de rede");
          setBusy(false);
        }
      }}
    >
      <h1 className="text-lg font-semibold">Criar organização</h1>
      <p className="text-sm text-muted">A organização é a fronteira de isolamento dos seus dados. Nenhum dado de exemplo é criado.</p>
      {error && <Alert tone="err" title={error} />}
      <Field label="Nome da organização">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
      <Field label="Fuso horário">
        {(id) => (
          <Select id={id} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {["America/Sao_Paulo", "America/Manaus", "America/Recife", "America/Fortaleza", "America/Belem", "America/Cuiaba", "America/Rio_Branco", "America/Noronha", "UTC", "America/New_York", "Europe/Lisbon"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Moeda de apresentação">
        {(id) => (
          <Select id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            {["BRL", "USD", "EUR"].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        )}
      </Field>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={form.internal_mode} onChange={(e) => setForm({ ...form, internal_mode: e.target.checked })} />
        <span>
          Uso interno (sem cobrança de assinatura). Autenticação e isolamento continuam iguais.
        </span>
      </label>
      <Button type="submit" busy={busy} className="w-full">
        Criar e continuar
      </Button>
    </form>
  );
}
