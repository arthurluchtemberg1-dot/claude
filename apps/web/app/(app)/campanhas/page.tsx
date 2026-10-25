"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Input, Modal, PageHeader, Select, Skeleton, Switch, cx, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { addDays, dateTime, money, ratio, todayIn } from "@/lib/format";

/**
 * Gerenciador de campanhas: estado da Meta (status, orçamento, aprendizado) + gasto sincronizado + vendas confirmadas
 * atribuídas por ID. Ações (ligar/desligar, orçamento, duplicar, renomear) passam pelo servidor, que confere
 * permissões e trava de gestão; o resultado só é mostrado depois da confirmação da Meta.
 */

type Level = "campaign" | "adset" | "ad";
type Metric = { status: "ok"; value: string } | { status: "undefined" | "unavailable"; reason: string };

interface Row {
  id: string | null;
  name: string | null;
  previous_names: string[];
  network: string | null;
  known_entity: boolean | null;
  account: { id: string; name: string | null; external_id: string } | null;
  status: string | null;
  effective_status: string | null;
  learning_status: string | null;
  daily_budget_minor: string | null;
  lifetime_budget_minor: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adset_id: string | null;
  adset_name: string | null;
  manageable: boolean;
  spend_minor: string | null;
  impressions: string | null;
  link_clicks: string | null;
  orders: number;
  orders_credit: string;
  attributed_gross_minor: string;
  attributed_net_minor: string;
  reported_purchases: string | null;
  reported_purchase_value_minor: string | null;
  metrics: Record<"profit" | "roas" | "cpa" | "ctr" | "cpc" | "cpm" | "meta_roas" | "meta_cpa", Metric>;
}

interface Group {
  currency: string;
  rows: Row[];
  totals: {
    spend_minor: string | null;
    impressions: string | null;
    link_clicks: string | null;
    orders_credit: string;
    attributed_gross_minor: string;
    attributed_net_minor: string;
    metrics: Row["metrics"];
    unattributed_orders: number;
  };
  notes: string[];
}

interface MediaResponse {
  groups: Group[];
  accounts: { id: string; name: string | null; external_account_id: string; currency: string; account_status: number | null; sync_enabled: boolean; last_synced_at: string | null; last_sync_error: string | null }[];
  writes: { enabled: boolean; reasons: string[] };
  last_synced_at: string | null;
  disclaimer: string;
}

interface Change {
  id: string;
  level: Level;
  entity_id: string;
  entity_name: string | null;
  action: string;
  before: { status?: string; daily_budget_minor?: string | null; name?: string } | null;
  requested: { status?: string; daily_budget?: string; name?: string } | null;
  after: Record<string, unknown> | null;
  actor_type: "user" | "rule" | "ai";
  actor_name: string | null;
  rule_name: string | null;
  status: "pending" | "running" | "succeeded" | "failed" | "unknown" | "skipped";
  error: string | null;
  created_at: string;
  completed_at: string | null;
  currency: string;
  account_name: string | null;
}

const LEVELS: Record<Level, { tab: string; singular: string }> = {
  campaign: { tab: "Campanhas", singular: "Campanha" },
  adset: { tab: "Conjuntos", singular: "Conjunto" },
  ad: { tab: "Anúncios", singular: "Anúncio" },
};

const PRESETS = [
  { key: "today", label: "Hoje" },
  { key: "yesterday", label: "Ontem" },
  { key: "7d", label: "7 dias" },
  { key: "14d", label: "14 dias" },
  { key: "30d", label: "30 dias" },
  { key: "month", label: "Este mês" },
] as const;
type Preset = (typeof PRESETS)[number]["key"] | "custom";

function presetRange(p: Preset, today: string): { from: string; to: string } | null {
  switch (p) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "14d":
      return { from: addDays(today, -13), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "month":
      return { from: `${today.slice(0, 8)}01`, to: today };
    default:
      return null;
  }
}

const EFFECTIVE: Record<string, { label: string; tone: "ok" | "warn" | "err" | "neutral" }> = {
  ACTIVE: { label: "Ativo", tone: "ok" },
  PAUSED: { label: "Pausado", tone: "neutral" },
  CAMPAIGN_PAUSED: { label: "Campanha pausada", tone: "neutral" },
  ADSET_PAUSED: { label: "Conjunto pausado", tone: "neutral" },
  IN_PROCESS: { label: "Em processamento", tone: "warn" },
  WITH_ISSUES: { label: "Com problemas", tone: "err" },
  DISAPPROVED: { label: "Reprovado", tone: "err" },
  PENDING_REVIEW: { label: "Em análise", tone: "warn" },
  PREAPPROVED: { label: "Pré-aprovado", tone: "warn" },
  PENDING_BILLING_INFO: { label: "Pagamento pendente", tone: "err" },
};

const ACTION_LABEL: Record<string, string> = { pause: "Pausar", activate: "Ativar", budget: "Orçamento", rename: "Renomear", duplicate: "Duplicar" };
const CHANGE_STATUS: Record<Change["status"], { label: string; tone: "ok" | "warn" | "err" | "neutral" | "info" }> = {
  pending: { label: "Na fila", tone: "info" },
  running: { label: "Enviando", tone: "info" },
  succeeded: { label: "Aplicada", tone: "ok" },
  failed: { label: "Falhou", tone: "err" },
  unknown: { label: "Confirmando", tone: "warn" },
  skipped: { label: "Não enviada", tone: "neutral" },
};

const OPTIONAL_COLS = [
  { key: "meta", label: "Compras (Meta)" },
  { key: "ctr", label: "CTR" },
  { key: "cpc", label: "CPC" },
  { key: "cpm", label: "CPM" },
  { key: "impressions", label: "Impressões" },
] as const;
type OptCol = (typeof OPTIONAL_COLS)[number]["key"];

function m(v: Metric, fmt: (s: string) => string) {
  return v.status === "ok" ? fmt(v.value) : <span title={v.reason}>—</span>;
}

/** Decimal com vírgula ou ponto → texto com ponto ("150,5" → "150.5"). */
function normalizeDecimal(s: string) {
  const t = s.trim().replace(/\s/g, "").replace(/^R\$/, "");
  const v = t.includes(",") ? t.replace(/\./g, "").replace(",", ".") : t;
  return /^\d+(\.\d{1,2})?$/.test(v) ? v : null;
}

function minorToInput(minor: string, currency: string) {
  return money(minor, currency).replace(/[^\d,.-]/g, "");
}

export default function CampaignsPage() {
  const { org, can } = useSession();
  const tz = org.organization.timezone;
  const today = todayIn(tz);
  const [preset, setPreset] = useState<Preset>("today");
  const [range, setRange] = useState(() => presetRange("today", today)!);
  const [level, setLevel] = useState<Level>("campaign");
  const [account, setAccount] = useState("");
  const [status, setStatus] = useState<"all" | "active" | "paused">("all");
  const [search, setSearch] = useState("");
  const [campaign, setCampaign] = useState<{ id: string; name: string | null } | null>(null);
  const [adset, setAdset] = useState<{ id: string; name: string | null } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cols, setCols] = useState<Set<OptCol>>(() => new Set<OptCol>(["meta", "ctr", "cpc"]));
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: "spend", dir: -1 });
  const [busy, setBusy] = useState<string | null>(null);
  const [inflight, setInflight] = useState<Map<string, string>>(new Map()); // change_id → entity_id
  const [budgetEdit, setBudgetEdit] = useState<{ row: Row; currency: string; value: string } | null>(null);
  const [renameEdit, setRenameEdit] = useState<{ row: Row; value: string } | null>(null);
  const [bulkBudget, setBulkBudget] = useState<{ value: string } | null>(null);
  const [historyFor, setHistoryFor] = useState<Row | null>(null);
  const { toast, toastNode } = useToast();

  useEffect(() => {
    try {
      const saved = localStorage.getItem("tracker.campaigns.cols");
      if (saved) setCols(new Set(JSON.parse(saved) as OptCol[]));
    } catch {
      /* preferência opcional */
    }
  }, []);
  const toggleCol = (k: OptCol) => {
    const next = new Set(cols);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setCols(next);
    try {
      localStorage.setItem("tracker.campaigns.cols", JSON.stringify([...next]));
    } catch {
      /* preferência opcional */
    }
  };

  const qs = new URLSearchParams({ level, from: range.from, to: range.to, status });
  if (account) qs.set("account_id", account);
  if (campaign && level !== "campaign") qs.set("campaign_id", campaign.id);
  if (adset && level === "ad") qs.set("adset_id", adset.id);
  const { data, error, loading, reload } = useApi<MediaResponse>(`/v1/media/entities?${qs}`);
  const changes = useApi<{ changes: Change[] }>("/v1/media/changes?limit=30");

  // Atualização automática a cada 60 s com a aba visível.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 60_000);
    return () => clearInterval(t);
  }, [reload]);

  // Acompanha as alterações enviadas até a Meta confirmar (ou falhar).
  const reloadRef = useRef({ reload, changes: changes.reload });
  reloadRef.current = { reload, changes: changes.reload };
  useEffect(() => {
    if (!inflight.size) return;
    let stop = false;
    const started = Date.now();
    const poll = async () => {
      while (!stop && Date.now() - started < 60_000) {
        await new Promise((r) => setTimeout(r, 1500));
        let list: Change[];
        try {
          list = (await api<{ changes: Change[] }>("/v1/media/changes?limit=50")).changes;
        } catch {
          continue;
        }
        const mine = list.filter((c) => inflight.has(c.id));
        const done = mine.filter((c) => c.status === "succeeded" || c.status === "failed" || c.status === "skipped");
        if (done.length && done.length === mine.length) {
          const failed = done.filter((c) => c.status !== "succeeded");
          toast(
            failed.length
              ? { tone: "err", text: `${failed.length} alteração(ões) não aplicada(s): ${failed.map((f) => `${f.entity_name ?? f.entity_id}: ${f.error ?? "falha"}`).join("; ")}`.slice(0, 300) }
              : { tone: "ok", text: done.length === 1 ? "Alteração confirmada pela Meta" : `${done.length} alterações confirmadas pela Meta` },
          );
          setInflight(new Map());
          void reloadRef.current.reload();
          void reloadRef.current.changes();
          return;
        }
      }
      if (!stop) {
        toast({ tone: "err", text: "A Meta ainda não confirmou; acompanhe no histórico de alterações." });
        setInflight(new Map());
        void reloadRef.current.changes();
      }
    };
    void poll();
    return () => {
      stop = true;
    };
  }, [inflight, toast]);

  const send = useCallback(
    async (body: { action: string; entity_ids: string[]; budget?: { mode: "absolute" | "percent"; value: string }; name?: string }, lvl: Level = level) => {
      setBusy(`${body.action}:${body.entity_ids.join(",")}`);
      try {
        const r = await api<{ results: { entity_id: string; ok: boolean; change_id?: string; error?: string; noop?: boolean }[] }>("/v1/media/actions", {
          method: "POST",
          body: { ...body, level: lvl, request_id: crypto.randomUUID() },
        });
        const queued = r.results.filter((x) => x.ok && x.change_id);
        const refused = r.results.filter((x) => !x.ok);
        if (refused.length) toast({ tone: refused.every((x) => x.noop) ? "ok" : "err", text: refused.map((x) => `${x.entity_id}: ${x.error}`).join("; ").slice(0, 300) });
        if (queued.length) setInflight(new Map(queued.map((x) => [x.change_id!, x.entity_id])));
        setSelected(new Set());
        return queued.length > 0;
      } catch (e) {
        toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha ao enviar" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [level, toast],
  );

  const syncNow = async () => {
    setBusy("sync");
    try {
      await api("/v1/meta/sync", { method: "POST", body: {} });
      toast({ tone: "ok", text: "Sincronização com a Meta na fila; os números atualizam em instantes." });
      setTimeout(() => void reload(), 8000);
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha ao sincronizar" });
    } finally {
      setBusy(null);
    }
  };

  const group = data?.groups[0];
  const currency = group?.currency ?? org.organization.currency ?? "BRL";
  const pendingIds = new Set(inflight.values());
  const writes = data?.writes;
  const canWrite = !!writes?.enabled && can("media.execute");

  const rows = useMemo(() => {
    const list = (group?.rows ?? []).filter((r) => !search.trim() || `${r.name ?? ""} ${r.id ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
    const val = (r: Row): number => {
      const metric = (k: keyof Row["metrics"]) => (r.metrics[k].status === "ok" ? Number((r.metrics[k] as { value: string }).value) : -Infinity);
      switch (sort.key) {
        case "name":
          return 0;
        case "spend":
          return r.spend_minor === null ? -Infinity : Number(r.spend_minor);
        case "sales":
          return Number(r.orders_credit);
        case "revenue":
          return Number(r.attributed_gross_minor);
        case "budget":
          return r.daily_budget_minor === null ? -Infinity : Number(r.daily_budget_minor);
        default:
          return metric(sort.key as keyof Row["metrics"]);
      }
    };
    return [...list].sort((a, b) => (sort.key === "name" ? sort.dir * String(a.name ?? "").localeCompare(String(b.name ?? ""), "pt-BR") : sort.dir * (val(a) - val(b)) || 0));
  }, [group, search, sort]);

  const selectable = rows.filter((r) => r.id && r.manageable);
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.id!));
  const setPresetRange = (p: Preset) => {
    setPreset(p);
    const r = presetRange(p, today);
    if (r) setRange(r);
  };
  const drill = (r: Row) => {
    if (!r.id) return;
    if (level === "campaign") {
      setCampaign({ id: r.id, name: r.name });
      setAdset(null);
      setLevel("adset");
    } else if (level === "adset") {
      setAdset({ id: r.id, name: r.name });
      if (r.campaign_id) setCampaign({ id: r.campaign_id, name: r.campaign_name });
      setLevel("ad");
    }
    setSelected(new Set());
  };
  const th = (key: string, label: string, cls = "") => (
    <th scope="col" className={cx("whitespace-nowrap px-3 py-2 font-medium", cls)}>
      <button type="button" className="inline-flex items-center gap-1 uppercase hover:text-text" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : -1 }))}>
        {label}
        {sort.key === key && <span aria-hidden>{sort.dir === -1 ? "↓" : "↑"}</span>}
      </button>
    </th>
  );
  const disabledReason = !can("media.execute") ? "Seu papel não permite alterar campanhas" : (writes?.reasons.join("; ") ?? "");

  const kpis = group
    ? [
        { label: "Gasto", value: group.totals.spend_minor === null ? "—" : money(group.totals.spend_minor, currency) },
        { label: "Faturamento", value: money(group.totals.attributed_gross_minor, currency) },
        { label: "Vendas", value: ratio(group.totals.orders_credit, Number.isInteger(Number(group.totals.orders_credit)) ? 0 : 2) },
        { label: "ROAS", value: group.totals.metrics.roas.status === "ok" ? `${ratio(group.totals.metrics.roas.value)}x` : "—" },
        { label: "CPA", value: group.totals.metrics.cpa.status === "ok" ? money(group.totals.metrics.cpa.value, currency) : "—" },
        {
          label: "Lucro",
          value: group.totals.metrics.profit.status === "ok" ? money(group.totals.metrics.profit.value, currency) : "—",
          tone: group.totals.metrics.profit.status === "ok" ? (BigInt(group.totals.metrics.profit.value) < 0n ? "text-err" : "text-ok") : "",
        },
      ]
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campanhas"
        description="Gasto da Meta e vendas confirmadas pelo checkout, juntos por ID. Ligue, desligue e ajuste orçamento sem sair daqui."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {data?.last_synced_at && <span className="text-xs text-muted">Sincronizado {dateTime(data.last_synced_at, tz)}</span>}
            {!!data?.accounts.length && (
              <Button variant="secondary" busy={busy === "sync"} onClick={() => void syncNow()}>
                Sincronizar agora
              </Button>
            )}
            <Link href="/integracoes/meta" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2">
              {data?.accounts.length ? "Contas Meta" : "Conectar Meta"}
            </Link>
          </div>
        }
      />

      {data && !data.accounts.length && (
        <Alert tone="info" title="Conecte sua conta da Meta para ver campanhas, gasto e controlar anúncios">
          Leva cerca de 5 minutos: crie um usuário do sistema no Business Manager, gere o token e cole em <Link className="underline" href="/integracoes/meta">Integrações → Meta</Link>. Vendas atribuídas por UTM já aparecem abaixo mesmo sem a conexão.
        </Alert>
      )}
      {data?.accounts.some((a) => a.sync_enabled && a.last_sync_error) && (
        <Alert tone="warn" title="Falha na última sincronização de uma conta">
          {data.accounts
            .filter((a) => a.sync_enabled && a.last_sync_error)
            .map((a) => `${a.name ?? a.external_account_id}: ${a.last_sync_error}`)
            .join(" · ")}
        </Alert>
      )}

      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Período">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={preset === p.key}
              onClick={() => setPresetRange(p.key)}
              className={cx("rounded-full border px-3 py-1 text-sm", preset === p.key ? "border-primary bg-primary text-primary-contrast" : "border-border hover:bg-surface-2")}
            >
              {p.label}
            </button>
          ))}
          <div className="flex items-center gap-1">
            <Input aria-label="De" type="date" className="w-auto py-1" value={range.from} max={range.to} onChange={(e) => (setPreset("custom"), setRange((r) => ({ ...r, from: e.target.value })))} />
            <span className="text-muted">–</span>
            <Input aria-label="Até" type="date" className="w-auto py-1" value={range.to} min={range.from} onChange={(e) => (setPreset("custom"), setRange((r) => ({ ...r, to: e.target.value })))} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!!data?.accounts.length && (
            <Select aria-label="Conta de anúncios" className="w-auto py-1" value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Todas as contas</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name ?? a.external_account_id}
                </option>
              ))}
            </Select>
          )}
          <Select aria-label="Status" className="w-auto py-1" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="all">Todos os status</option>
            <option value="active">Ativos</option>
            <option value="paused">Pausados</option>
          </Select>
          <Input aria-label="Buscar por nome ou ID" placeholder="Buscar por nome ou ID" className="w-56 py-1" value={search} onChange={(e) => setSearch(e.target.value)} />
          <details className="relative">
            <summary className="cursor-pointer list-none rounded-md border border-border px-3 py-1 text-sm hover:bg-surface-2">Colunas</summary>
            <div className="absolute right-0 z-20 mt-1 w-48 rounded-md border border-border bg-surface p-2 shadow-lg">
              {OPTIONAL_COLS.map((c) => (
                <label key={c.key} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={cols.has(c.key)} onChange={() => toggleCol(c.key)} />
                  {c.label}
                </label>
              ))}
            </div>
          </details>
        </div>
      </Card>

      {kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-lg border border-border bg-surface p-3">
              <p className="text-xs uppercase tracking-wide text-muted">{k.label}</p>
              <p className={cx("mt-1 text-lg font-semibold tabular", k.tone)}>{k.value}</p>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Nível" className="flex rounded-lg border border-border bg-surface p-1">
          {(Object.keys(LEVELS) as Level[]).map((l) => (
            <button
              key={l}
              role="tab"
              type="button"
              aria-selected={level === l}
              onClick={() => {
                setLevel(l);
                setSelected(new Set());
                if (l === "campaign") {
                  setCampaign(null);
                  setAdset(null);
                }
                if (l === "adset") setAdset(null);
              }}
              className={cx("rounded-md px-3 py-1.5 text-sm font-medium", level === l ? "bg-primary text-primary-contrast" : "text-muted hover:text-text")}
            >
              {LEVELS[l].tab}
            </button>
          ))}
        </div>
        {campaign && level !== "campaign" && (
          <Badge tone="info">
            Campanha: {campaign.name ?? campaign.id}
            <button type="button" aria-label="Remover filtro de campanha" className="ml-1" onClick={() => (setCampaign(null), setAdset(null))}>
              ×
            </button>
          </Badge>
        )}
        {adset && level === "ad" && (
          <Badge tone="info">
            Conjunto: {adset.name ?? adset.id}
            <button type="button" aria-label="Remover filtro de conjunto" className="ml-1" onClick={() => setAdset(null)}>
              ×
            </button>
          </Badge>
        )}
      </div>

      {data && !canWrite && !!data.accounts.length && (
        <p className="text-xs text-muted">
          Somente leitura: {disabledReason}.{" "}
          {can("org.manage") && (
            <Link href="/integracoes/meta" className="underline">
              Liberar ações
            </Link>
          )}
        </p>
      )}

      {selected.size > 0 && (
        <div className="sticky top-14 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-primary bg-surface p-2 shadow">
          <span className="text-sm font-medium">{selected.size} selecionado(s)</span>
          <Button variant="secondary" disabled={!canWrite} busy={busy?.startsWith("activate")} onClick={() => void send({ action: "activate", entity_ids: [...selected] })}>
            Ativar
          </Button>
          <Button variant="secondary" disabled={!canWrite} busy={busy?.startsWith("pause")} onClick={() => void send({ action: "pause", entity_ids: [...selected] })}>
            Pausar
          </Button>
          {level !== "ad" && (
            <Button variant="secondary" disabled={!canWrite} onClick={() => setBulkBudget({ value: "" })}>
              Ajustar orçamento
            </Button>
          )}
          <Button variant="secondary" disabled={!canWrite} busy={busy?.startsWith("duplicate")} onClick={() => window.confirm(`Duplicar ${selected.size} item(ns)? As cópias nascem pausadas.`) && void send({ action: "duplicate", entity_ids: [...selected] })}>
            Duplicar
          </Button>
          <Button variant="ghost" onClick={() => setSelected(new Set())}>
            Limpar
          </Button>
        </div>
      )}

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton className="h-64" />}
      {data && group && (
        <div className="relative overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <caption className="sr-only">{LEVELS[level].tab} com gasto, vendas e controles</caption>
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th scope="col" className="w-8 px-3 py-2">
                  <input type="checkbox" aria-label="Selecionar todos" checked={allSelected} disabled={!selectable.length} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((r) => r.id!)) : new Set())} />
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                {th("name", LEVELS[level].singular, "sticky left-0 bg-surface-2")}
                {level !== "ad" && th("budget", "Orçamento")}
                {th("spend", "Gasto")}
                {th("sales", "Vendas")}
                {th("revenue", "Faturamento")}
                {th("roas", "ROAS")}
                {th("cpa", "CPA")}
                {th("profit", "Lucro")}
                {cols.has("meta") && th("meta_roas", "Compras Meta")}
                {cols.has("ctr") && th("ctr", "CTR")}
                {cols.has("cpc") && th("cpc", "CPC")}
                {cols.has("cpm") && th("cpm", "CPM")}
                {cols.has("impressions") && <th className="px-3 py-2 font-medium">Impressões</th>}
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.length === 0 && (
                <tr>
                  <td colSpan={16} className="p-6">
                    <Empty title={search ? "Nada encontrado com essa busca" : `Nenhum(a) ${LEVELS[level].singular.toLowerCase()} com gasto, venda ou estado sincronizado no período`}>
                      {data.accounts.length ? "Troque o período, a conta ou o filtro de status." : "Conecte a Meta ou importe gastos em Custos e mídia."}
                    </Empty>
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const eff = r.effective_status && r.effective_status !== r.status ? EFFECTIVE[r.effective_status] : null;
                const pending = r.id ? pendingIds.has(r.id) : false;
                const toggleable = r.manageable && (r.status === "ACTIVE" || r.status === "PAUSED");
                return (
                  <tr key={`${r.network}-${r.id}`} className={cx("hover:bg-surface-2/50", selected.has(r.id ?? "") && "bg-primary/5")}>
                    <td className="px-3 py-2 align-top">
                      {r.id && r.manageable && (
                        <input
                          type="checkbox"
                          aria-label={`Selecionar ${r.name ?? r.id}`}
                          checked={selected.has(r.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(r.id!);
                            else next.delete(r.id!);
                            setSelected(next);
                          }}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {toggleable ? (
                        <Switch
                          label={`${r.status === "ACTIVE" ? "Pausar" : "Ativar"} ${r.name ?? r.id}`}
                          checked={r.status === "ACTIVE"}
                          busy={pending || busy === `${r.status === "ACTIVE" ? "pause" : "activate"}:${r.id}`}
                          disabled={!canWrite}
                          title={!canWrite ? disabledReason : undefined}
                          onChange={(on) => void send({ action: on ? "activate" : "pause", entity_ids: [r.id!] })}
                        />
                      ) : (
                        <span className="text-xs text-muted">{r.status ? (EFFECTIVE[r.status]?.label ?? r.status) : "—"}</span>
                      )}
                    </td>
                    <td className="sticky left-0 max-w-[320px] bg-surface px-3 py-2 align-top">
                      {r.id && level !== "ad" && r.known_entity ? (
                        <button type="button" className="text-left font-medium text-primary hover:underline" onClick={() => drill(r)}>
                          {r.name ?? "Sem nome registrado"}
                        </button>
                      ) : (
                        <div className="font-medium">{r.name ?? (r.id ? "Sem nome registrado" : "Sem ID de campanha")}</div>
                      )}
                      {r.id && <div className="font-mono text-xs text-muted">ID {r.id}</div>}
                      <div className="mt-1 flex flex-wrap gap-1">
                        {eff && <Badge tone={eff.tone}>{eff.label}</Badge>}
                        {r.learning_status === "LEARNING" && (
                          <Badge tone="warn" title="Fase de aprendizado da Meta: evite mudanças bruscas; regras não agem por padrão">
                            Aprendizado
                          </Badge>
                        )}
                        {r.learning_status === "FAIL" && <Badge tone="warn" title="A Meta indicou aprendizado limitado">Aprendizado limitado</Badge>}
                        {pending && <Badge tone="info">Enviando…</Badge>}
                        {r.known_entity === false && r.id && (
                          <Badge tone="warn" title="ID declarado na origem da venda sem gasto/entidade registrada nesta organização">
                            ID não confirmado
                          </Badge>
                        )}
                      </div>
                      {level !== "campaign" && (r.campaign_name || r.adset_name) && (
                        <div className="mt-1 truncate text-xs text-muted">{[r.campaign_name, level === "ad" ? r.adset_name : null].filter(Boolean).join(" › ")}</div>
                      )}
                      {r.previous_names.length > 0 && <div className="text-xs text-muted">Antes: {r.previous_names.join(", ")}</div>}
                    </td>
                    {level !== "ad" && (
                      <td className="whitespace-nowrap px-3 py-2 align-top tabular">
                        {r.daily_budget_minor !== null ? (
                          <button
                            type="button"
                            className={cx("rounded px-1", canWrite && "underline decoration-dotted hover:bg-surface-2")}
                            disabled={!canWrite}
                            title={canWrite ? "Alterar orçamento diário" : disabledReason}
                            onClick={() => setBudgetEdit({ row: r, currency, value: minorToInput(r.daily_budget_minor!, currency) })}
                          >
                            {money(r.daily_budget_minor, currency)}
                            <span className="text-xs text-muted">/dia</span>
                          </button>
                        ) : r.lifetime_budget_minor !== null ? (
                          <span title="Orçamento vitalício">{money(r.lifetime_budget_minor, currency)} total</span>
                        ) : r.manageable ? (
                          <span className="text-xs text-muted" title="Orçamento definido em outro nível">
                            {level === "campaign" ? "nos conjuntos" : "na campanha"}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    )}
                    <td className="whitespace-nowrap px-3 py-2 align-top tabular">
                      {r.spend_minor === null ? (
                        <span className="text-muted" title="Sem gasto importado/sincronizado para este ID">
                          indisponível
                        </span>
                      ) : (
                        money(r.spend_minor, currency)
                      )}
                    </td>
                    <td className="px-3 py-2 align-top tabular">
                      {ratio(r.orders_credit, Number.isInteger(Number(r.orders_credit)) ? 0 : 2)}
                      {r.orders_credit !== String(r.orders) && <div className="text-xs text-muted">{r.orders} pedido(s)</div>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top tabular">{money(r.attributed_gross_minor, currency)}</td>
                    <td className="px-3 py-2 align-top tabular">{m(r.metrics.roas, (v) => `${ratio(v)}x`)}</td>
                    <td className="whitespace-nowrap px-3 py-2 align-top tabular">{m(r.metrics.cpa, (v) => money(v, currency))}</td>
                    <td className={cx("whitespace-nowrap px-3 py-2 align-top tabular", r.metrics.profit.status === "ok" && (BigInt(r.metrics.profit.value) < 0n ? "text-err" : "text-ok"))}>
                      {m(r.metrics.profit, (v) => money(v, currency))}
                    </td>
                    {cols.has("meta") && (
                      <td className="whitespace-nowrap px-3 py-2 align-top tabular" title="Reportado pela Meta (pixel/API de conversões); pode divergir das vendas confirmadas">
                        {r.reported_purchases === null ? "—" : ratio(r.reported_purchases, Number.isInteger(Number(r.reported_purchases)) ? 0 : 2)}
                        {r.metrics.meta_roas.status === "ok" && <div className="text-xs text-muted">ROAS {ratio(r.metrics.meta_roas.value)}x</div>}
                      </td>
                    )}
                    {cols.has("ctr") && <td className="px-3 py-2 align-top tabular">{m(r.metrics.ctr, (v) => `${ratio(v)}%`)}</td>}
                    {cols.has("cpc") && <td className="whitespace-nowrap px-3 py-2 align-top tabular">{m(r.metrics.cpc, (v) => money(v, currency))}</td>}
                    {cols.has("cpm") && <td className="whitespace-nowrap px-3 py-2 align-top tabular">{m(r.metrics.cpm, (v) => money(v, currency))}</td>}
                    {cols.has("impressions") && <td className="px-3 py-2 align-top tabular">{r.impressions === null ? "—" : Number(r.impressions).toLocaleString("pt-BR")}</td>}
                    <td className="px-3 py-2 align-top">
                      {r.id && r.manageable && (
                        <details className="relative">
                          <summary className="cursor-pointer list-none rounded px-2 py-1 text-muted hover:bg-surface-2" aria-label={`Mais ações para ${r.name ?? r.id}`}>
                            ⋯
                          </summary>
                          <div className="absolute right-0 z-20 mt-1 w-44 rounded-md border border-border bg-surface p-1 text-sm shadow-lg">
                            <button type="button" className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50" disabled={!canWrite} onClick={() => window.confirm(`Duplicar "${r.name ?? r.id}"? A cópia nasce pausada.`) && void send({ action: "duplicate", entity_ids: [r.id!] })}>
                              Duplicar
                            </button>
                            <button type="button" className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2 disabled:opacity-50" disabled={!canWrite} onClick={() => setRenameEdit({ row: r, value: r.name ?? "" })}>
                              Renomear
                            </button>
                            <button type="button" className="block w-full rounded px-2 py-1.5 text-left hover:bg-surface-2" onClick={() => setHistoryFor(r)}>
                              Histórico
                            </button>
                          </div>
                        </details>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {group?.notes.map((n, i) => (
        <p key={i} className="text-xs text-muted">
          {n}
        </p>
      ))}
      {data && <p className="text-xs text-muted">{data.disclaimer}</p>}

      <Card title="Histórico de alterações" actions={<Button variant="ghost" onClick={() => void changes.reload()}>Atualizar</Button>}>
        <ChangeList changes={changes.data?.changes ?? []} tz={tz} loading={changes.loading && !changes.data} />
      </Card>

      {budgetEdit && (
        <Modal title={`Orçamento diário · ${budgetEdit.row.name ?? budgetEdit.row.id}`} onClose={() => setBudgetEdit(null)}>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = normalizeDecimal(budgetEdit.value);
              if (!v) return toast({ tone: "err", text: "Valor inválido (ex.: 150,00)" });
              const cur = Number(budgetEdit.row.daily_budget_minor) / 100;
              if (Number(v) > cur * 2 && !window.confirm(`Mais que dobrar o orçamento (${money(budgetEdit.row.daily_budget_minor, currency)} → R$ ${v.replace(".", ",")})? Confirme.`)) return;
              if (await send({ action: "budget", entity_ids: [budgetEdit.row.id!], budget: { mode: "absolute", value: v } })) setBudgetEdit(null);
            }}
          >
            <p className="text-sm text-muted">Atual: {money(budgetEdit.row.daily_budget_minor, currency)} por dia. A Meta pode levar alguns minutos para redistribuir a entrega.</p>
            <Input aria-label="Novo orçamento diário" inputMode="decimal" autoFocus value={budgetEdit.value} onChange={(e) => setBudgetEdit({ ...budgetEdit, value: e.target.value })} />
            <div className="flex flex-wrap gap-2">
              {[-20, -10, 10, 20, 30].map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant="secondary"
                  onClick={() => setBudgetEdit({ ...budgetEdit, value: ((Number(budgetEdit.row.daily_budget_minor) * (100 + p)) / 10000).toFixed(2).replace(".", ",") })}
                >
                  {p > 0 ? `+${p}%` : `${p}%`}
                </Button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setBudgetEdit(null)}>
                Cancelar
              </Button>
              <Button type="submit" busy={busy?.startsWith("budget")}>
                Salvar orçamento
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {bulkBudget && (
        <Modal title={`Ajustar orçamento de ${selected.size} item(ns)`} onClose={() => setBulkBudget(null)}>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              const v = bulkBudget.value.trim().replace(",", ".");
              if (!/^-?\d{1,3}(\.\d{1,2})?$/.test(v) || Number(v) === 0 || Number(v) <= -100) return toast({ tone: "err", text: "Informe um percentual, ex.: 20 ou -15" });
              if (await send({ action: "budget", entity_ids: [...selected], budget: { mode: "percent", value: v } })) setBulkBudget(null);
            }}
          >
            <p className="text-sm text-muted">Variação percentual sobre o orçamento diário atual de cada item (itens sem orçamento diário neste nível são ignorados com aviso).</p>
            <Input aria-label="Variação (%)" inputMode="decimal" placeholder="ex.: 20 ou -15" autoFocus value={bulkBudget.value} onChange={(e) => setBulkBudget({ value: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setBulkBudget(null)}>
                Cancelar
              </Button>
              <Button type="submit" busy={busy?.startsWith("budget")}>
                Aplicar
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {renameEdit && (
        <Modal title="Renomear" onClose={() => setRenameEdit(null)}>
          <form
            className="space-y-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!renameEdit.value.trim()) return;
              if (await send({ action: "rename", entity_ids: [renameEdit.row.id!], name: renameEdit.value.trim() })) setRenameEdit(null);
            }}
          >
            <p className="text-sm text-muted">O histórico continua ligado pelo ID; o nome antigo fica registrado. Se você usa o nome na UTM, links antigos seguem válidos pelo ID.</p>
            <Input aria-label="Novo nome" autoFocus maxLength={400} value={renameEdit.value} onChange={(e) => setRenameEdit({ ...renameEdit, value: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRenameEdit(null)}>
                Cancelar
              </Button>
              <Button type="submit" busy={busy?.startsWith("rename")}>
                Salvar nome
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {historyFor && (
        <Modal title={`Histórico · ${historyFor.name ?? historyFor.id}`} onClose={() => setHistoryFor(null)}>
          <EntityHistory entityId={historyFor.id!} tz={tz} />
        </Modal>
      )}
      {toastNode}
    </div>
  );
}

function describeChange(c: Change) {
  const cur = c.currency;
  switch (c.action) {
    case "pause":
      return "Pausou";
    case "activate":
      return "Ativou";
    case "budget":
      return `Orçamento ${c.before?.daily_budget_minor ? money(c.before.daily_budget_minor, cur) : "—"} → ${c.requested?.daily_budget ? money(c.requested.daily_budget, cur) : "—"}`;
    case "rename":
      return `Renomeou para "${c.requested?.name ?? ""}"`;
    case "duplicate":
      return "Duplicou (cópia pausada)";
    default:
      return ACTION_LABEL[c.action] ?? c.action;
  }
}

function ChangeList({ changes, tz, loading }: { changes: Change[]; tz: string; loading?: boolean }) {
  if (loading) return <Skeleton className="h-24" />;
  if (!changes.length) return <p className="text-sm text-muted">Nenhuma alteração feita pelo painel, regras ou Gestor IA ainda.</p>;
  return (
    <ul className="divide-y divide-border text-sm">
      {changes.map((c) => (
        <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
          <div className="min-w-0">
            <p>
              <span className="font-medium">{c.entity_name ?? c.entity_id}</span> · {describeChange(c)}
            </p>
            <p className="text-xs text-muted">
              {dateTime(c.created_at, tz)} · {c.actor_type === "rule" ? `Regra ${c.rule_name ?? ""}` : c.actor_type === "ai" ? "Gestor IA" : (c.actor_name ?? "Usuário")}
              {c.account_name ? ` · ${c.account_name}` : ""}
            </p>
            {c.error && c.status !== "succeeded" && <p className="text-xs text-err">{c.error}</p>}
          </div>
          <Badge tone={CHANGE_STATUS[c.status].tone}>{CHANGE_STATUS[c.status].label}</Badge>
        </li>
      ))}
    </ul>
  );
}

function EntityHistory({ entityId, tz }: { entityId: string; tz: string }) {
  const { data, loading, error } = useApi<{ changes: Change[] }>(`/v1/media/changes?entity_id=${encodeURIComponent(entityId)}`);
  if (error) return <ErrorBox error={error} />;
  return <ChangeList changes={data?.changes ?? []} tz={tz} loading={loading && !data} />;
}
