"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { Alert } from "@/components/ui";

export default function VerifyEmailPage() {
  const [state, setState] = useState<{ tone: "info" | "ok" | "err"; text: string }>({ tone: "info", text: "Verificando…" });
  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) return setState({ tone: "err", text: "Link sem token." });
    api("/v1/auth/verify-email", { method: "POST", body: { token } })
      .then(() => setState({ tone: "ok", text: "E-mail confirmado." }))
      .catch((e) => setState({ tone: "err", text: e instanceof ApiError ? e.message : "Falha de rede" }));
  }, []);
  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">Verificação de e-mail</h1>
      <Alert tone={state.tone} title={state.text} />
      <Link className="text-primary underline" href="/painel">
        Ir para o painel
      </Link>
    </div>
  );
}
