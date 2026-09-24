"use client";

import { useState } from "react";
import { api, ApiError, setOrgId } from "@/lib/api";
import { Alert, Button } from "@/components/ui";

export default function InvitePage() {
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Aceitar convite</h1>
      <p className="text-sm text-muted">Entre com a conta do e-mail convidado (verificado) e confirme.</p>
      {msg && <Alert tone={msg.tone} title={msg.text} />}
      <Button
        busy={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const token = new URLSearchParams(window.location.search).get("token") ?? "";
            const r = await api<{ organization_id: string; organization_name: string }>("/v1/invites/accept", { method: "POST", body: { token } });
            setOrgId(r.organization_id);
            setMsg({ tone: "ok", text: `Você agora participa de ${r.organization_name}.` });
            setTimeout(() => (window.location.href = "/painel"), 1200);
          } catch (err) {
            if (err instanceof ApiError && err.status === 401) window.location.href = `/entrar?next=${encodeURIComponent(window.location.pathname + window.location.search)}`;
            setMsg({ tone: "err", text: err instanceof ApiError ? err.message : "Falha de rede" });
          } finally {
            setBusy(false);
          }
        }}
      >
        Aceitar convite
      </Button>
    </div>
  );
}
