"use client";

import Link from "next/link";
import { useSession } from "@/components/shell";
import { useApi } from "@/lib/api";

/**
 * Progresso de configuração ("Primeiros passos"): cada passo é conferido no servidor (nada marcado à mão).
 * Passos sem permissão de leitura aparecem como "não verificável" em vez de concluídos.
 */

export interface SetupStep {
  key: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  optional?: boolean;
  done: boolean | null; // null = carregando ou sem permissão para verificar
  minutes: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function useSetupProgress() {
  const { me, org } = useSession();
  const conns = useApi<{ connections: any[] }>("/v1/connections");
  const orders = useApi<{ orders: any[] }>("/v1/orders?limit=30");
  const diag = useApi<{ tracking?: { last_event_at: string | null } }>("/v1/diagnostics/overview");
  const meta = useApi<{ connection: { status: string } | null; writes: { setting_on: boolean } }>("/v1/meta");
  const push = useApi<{ subscriptions: any[] }>("/v1/notifications/push/subscriptions");
  const rules = useApi<{ rules: any[] }>("/v1/rules");
  const dests = useApi<{ destinations: any[] }>("/v1/destinations");
  const val = <T,>(r: { data: T | null; error: unknown }, f: (d: T) => boolean): boolean | null => (r.error ? null : r.data ? f(r.data) : null);

  const steps: SetupStep[] = [
    {
      key: "mfa",
      title: "Ative a verificação em duas etapas",
      description: "Exigida para conectar integrações e liberar ações. Leia o QR code com um app autenticador (Google Authenticator, Authy…).",
      href: "/configuracoes#mfa",
      cta: "Ativar agora",
      optional: !org.organization.mfa_required,
      done: me.user.mfa_enabled,
      minutes: 2,
    },
    {
      key: "checkout",
      title: "Conecte seu checkout",
      description: "Crie a conexão (ex.: Lowify) e cadastre a URL do webhook no checkout para receber vendas aprovadas, pendentes e reembolsos.",
      href: "/integracoes",
      cta: "Conectar checkout",
      done: val(conns, (d) => d.connections.some((c) => c.provider !== "meta_ads" && c.status !== "revoked")),
      minutes: 3,
    },
    {
      key: "sale",
      title: "Receba a primeira venda",
      description: "Faça uma venda de teste autorizada (ou aguarde a próxima). Ela aparece em Vendas em segundos.",
      href: "/vendas",
      cta: "Ver vendas",
      done: val(orders, (d) => d.orders.length > 0),
      minutes: 2,
    },
    {
      key: "sdk",
      title: "Instale o script de rastreamento",
      description: "Cole o script na página de vendas para ligar visitas, UTMs e cliques ao pedido (atribuição por ID de campanha).",
      href: "/instalacao",
      cta: "Copiar script",
      done: val(diag, (d) => !!d.tracking?.last_event_at),
      minutes: 3,
    },
    {
      key: "meta",
      title: "Conecte a Meta Ads",
      description: "Token de usuário do sistema do Business Manager: traz campanhas, gasto e compras reportadas, e permite controlar anúncios.",
      href: "/integracoes/meta",
      cta: "Conectar Meta",
      done: val(meta, (d) => d.connection?.status === "connected"),
      minutes: 5,
    },
    {
      key: "utm",
      title: "Coloque os parâmetros de URL nos anúncios",
      description: "Com os IDs de campanha, conjunto e anúncio na URL, cada venda é ligada ao anúncio certo — mesmo se você renomear.",
      href: "/integracoes/meta",
      cta: "Copiar parâmetros",
      done: val(orders, (d) => d.orders.some((o) => !!o.campaign_id)),
      minutes: 3,
    },
    {
      key: "push",
      title: "Ative as notificações no celular",
      description: "Instale o painel na tela inicial e receba cada venda aprovada e alertas de conta/limite de gasto.",
      href: "/notificacoes",
      cta: "Ativar notificações",
      optional: true,
      done: val(push, (d) => d.subscriptions.some((s) => !s.disabled_at)),
      minutes: 1,
    },
    {
      key: "writes",
      title: "Libere as ações de gestão",
      description: "Permite pausar, ativar e ajustar orçamento pela tela de Campanhas e pelas regras. Fica registrado quem fez o quê.",
      href: "/integracoes/meta",
      cta: "Liberar ações",
      optional: true,
      done: val(meta, (d) => !!d.writes?.setting_on),
      minutes: 1,
    },
    {
      key: "rules",
      title: "Crie uma regra de automação",
      description: "Ex.: avisar ou pausar anúncio que gastou sem vender. Simule antes de ativar.",
      href: "/automacao",
      cta: "Criar regra",
      optional: true,
      done: val(rules, (d) => d.rules.length > 0),
      minutes: 3,
    },
    {
      key: "capi",
      title: "Envie vendas à API de Conversões",
      description: "Devolve à Meta as compras confirmadas pelo checkout para otimizar a entrega (opcional).",
      href: "/pixels",
      cta: "Configurar",
      optional: true,
      done: val(dests, (d) => d.destinations.length > 0),
      minutes: 4,
    },
  ];
  const required = steps.filter((s) => !s.optional);
  const loading = [conns, orders, meta].some((r) => r.loading && !r.data);
  return { steps, loading, requiredDone: required.filter((s) => s.done).length, requiredTotal: required.length, doneCount: steps.filter((s) => s.done).length };
}

/** Faixa no painel enquanto faltam passos essenciais. */
export function SetupBanner() {
  const p = useSetupProgress();
  if (p.loading || p.requiredDone >= p.requiredTotal) return null;
  const next = p.steps.find((s) => !s.optional && s.done === false);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary bg-primary/5 p-3 text-sm">
      <div>
        <p className="font-semibold">
          Configuração: {p.requiredDone} de {p.requiredTotal} passos essenciais
        </p>
        {next && <p className="text-muted">Próximo: {next.title}</p>}
      </div>
      <Link href="/primeiros-passos" className="rounded-md bg-primary px-3 py-2 font-medium text-primary-contrast hover:opacity-90">
        Continuar configuração
      </Link>
    </div>
  );
}
