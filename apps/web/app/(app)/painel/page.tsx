"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BarLineChart, DistributionBar } from "@/components/charts";
import { SetupBanner } from "@/components/setup";
import { useSession } from "@/components/shell";
import { Badge, Button, Card, cx, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { addDays, ATTRIBUTION_LABELS, dateTime, minorToChartNumber, money, ratio, STATUS_LABELS, todayIn } from "@/lib/format";

interface Metric {
  id: string;
  label: string;
  unit: "money" | "count" | "ratio" | "percent";
  status: "ok" | "undefined" | "unavailable";
  amount_minor?: string;
  currency?: string;
  value?: string;
  fraction?: { num: string; den: string };
  fractional?: boolean;
  quality?: "complete" | "partial" | "estimated";
  reason?: string;
  notes: string[];
  formula: string;
  denominator: string | null;
  source: string;
}

interface Summary {
  scope: { from: string; to: string; timezone: string; basis: string; policy: string; as_of: string };
  groups: { currency: string; policy_label: string | null; notes: string[]; metrics: Metric[]; previous: Metric[] | null }[];
  freshness: { last_receipt_at: string | null; last_order_processed_at: string | null; last_spend_snapshot_at: string | null; pending_receipts: string; problem_receipts: string; degraded_connections: string };
  disclaimer: string;
}

interface Timeseries {
  days: { day: string; currency: string; approved_orders: number; gross: string; net: string }[];
  spend: { day: string; currency: string; spend: string }[];
  hours: { hour: number; orders: number }[];
  attribution_quality: { category: string; quality: string; orders: number }[];
}

const COHORT_ONLY = new Set(["customers_acquired", "ltv_observed"]);

/** Destaques (uma vez cada; o restante fica em "Mais métricas"). */
const HERO = ["gross_approved_revenue", "media_spend", "roas_gross", "contribution_after_media", "approved_orders_gross", "cpa_approved"];
/** Métricas em que subir é ruim (variação em vermelho). */
const LOWER_IS_BETTER = new Set(["media_spend", "cpa_approved", "cpa_retained", "financial_reversals", "fees", "unattributed_orders", "cpl"]);

const CARD_ORDER = [
  "customers_acquired",
  "ltv_observed",
  "revenue_after_reversals",
  "financial_reversals",
  "retained_orders",
  "cpa_retained",
  "roas_after_reversals",
  "avg_ticket_gross",
  "fees",
  "org_revenue",
  "mer",
  "unattributed_orders",
  "orders_generated",
  "payment_approval_rate",
  "cpl",
  "breakeven_roas",
];

const PRESETS = [
  ["today", "Hoje"],
  ["yesterday", "Ontem"],
  ["7d", "7 dias"],
  ["30d", "30 dias"],
  ["month", "Este mês"],
] as const;

function rangeFor(p: string, today: string) {
  switch (p) {
    case "today":
      return [today, today];
    case "yesterday":
      return [addDays(today, -1), addDays(today, -1)];
    case "30d":
      return [addDays(today, -29), today];
    case "month":
      return [`${today.slice(0, 8)}01`, today];
    default:
      return [addDays(today, -6), today];
  }
}

function display(m: Metric): string {
  if (m.status !== "ok") return "—";
  if (m.unit === "money") return money(m.amount_minor, m.currency);
  if (m.unit === "percent") return `${ratio(m.value, 1)}%`;
  if (m.unit === "ratio") return ratio(m.value, 2);
  return m.fractional ? ratio(m.value, 2) : Number(m.value).toLocaleString("pt-BR");
}

/** Variação percentual só para exibição (os valores exatos vêm do servidor). */
function change(cur: Metric, prev: Metric | undefined): number | null {
  if (!prev || cur.status !== "ok" || prev.status !== "ok") return null;
  const a = Number(cur.unit === "money" ? cur.amount_minor : cur.value);
  const b = Number(prev.unit === "money" ? prev.amount_minor : prev.value);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return ((a - b) / Math.abs(b)) * 100;
}

function Delta({ m, prev, big }: { m: Metric; prev?: Metric; big?: boolean }) {
  const pct = change(m, prev);
  if (pct === null) return null;
  const good = LOWER_IS_BETTER.has(m.id) ? pct < 0 : pct > 0;
  const tone = Math.abs(pct) < 0.05 ? "text-muted" : good ? "text-ok" : "text-err";
  return (
    <span className={cx("text-xs", tone)} title="Comparado ao período anterior de mesma duração">
      {pct > 0 ? "▲" : pct < 0 ? "▼" : "•"} {Math.abs(pct).toFixed(1)}%{big ? " vs período anterior" : ""}
    </span>
  );
}

function MetricCard({ m, prev, onOpen, hero }: { m: Metric; prev?: Metric; onOpen: () => void; hero?: boolean }) {
  const q = m.status === "ok" ? m.quality : undefined;
  const negative = m.status === "ok" && m.unit === "money" && (m.amount_minor ?? "").startsWith("-");
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx("flex flex-col gap-1 rounded-lg border border-border bg-surface text-left transition hover:border-primary", hero ? "p-4" : "p-3")}
      aria-label={`${m.label}: ${display(m)}. Abrir definição`}
    >
      <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted">
        <span className={hero ? "uppercase tracking-wide" : ""}>{m.label}</span>
        {q === "partial" && <Badge tone="warn" title="Faltam custos ou taxas para parte do período">parcial</Badge>}
        {q === "estimated" && <Badge tone="info">estimado</Badge>}
        {m.status === "unavailable" && <Badge>indisponível</Badge>}
      </span>
      <span className={cx("tabular font-semibold", hero ? "text-2xl" : "text-xl", negative && "text-err", hero && m.id === "contribution_after_media" && !negative && m.status === "ok" && "text-ok")}>{display(m)}</span>
      {m.status !== "ok" && <span className="text-xs text-muted">{m.reason}</span>}
      <Delta m={m} prev={prev} big={hero} />
    </button>
  );
}

interface CampaignRow {
  id: string | null;
  name: string | null;
  status: string | null;
  spend_minor: string | null;
  orders_credit: string;
  attributed_gross_minor: string;
  metrics: { roas: { status: string; value?: string }; profit: { status: string; value?: string } };
}

interface RecentOrder {
  id: string;
  external_order_id: string;
  currency: string;
  financial_status: string;
  approved_minor: string | null;
  first_approved_at: string | null;
  first_received_at: string;
  payment_method: string | null;
  products: string | null;
  utm_campaign: string | null;
  attribution_category: string | null;
}

function ago(iso: string) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return "agora";
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  return `há ${Math.floor(s / 86400)} d`;
}

const STATUS_TONE: Record<string, "ok" | "warn" | "err" | "neutral"> = { approved: "ok", pending: "warn", failed: "err", fully_reversed: "err", partially_reversed: "warn", reversal_pending_reconciliation: "warn" };

function RecentSales({ tz }: { tz: string }) {
  const { data, reload } = useApi<{ orders: RecentOrder[] }>("/v1/orders?limit=6&status=approved");
  useEffect(() => {
    const t = setInterval(() => document.visibilityState === "visible" && void reload(), 30_000);
    return () => clearInterval(t);
  }, [reload]);
  return (
    <Card title="Últimas vendas aprovadas" actions={<Link href="/vendas" className="text-sm text-primary underline">Ver todas</Link>}>
      {!data ? (
        <Skeleton className="h-40" />
      ) : !data.orders.length ? (
        <p className="text-sm text-muted">Nenhuma venda aprovada ainda. Conecte o checkout em Integrações.</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.orders.map((o) => (
            <li key={o.id} className="flex items-start justify-between gap-2 py-2 text-sm">
              <div className="min-w-0">
                <Link href={`/vendas/${o.id}`} className="block truncate font-medium hover:underline">
                  {o.products ?? o.external_order_id}
                </Link>
                <p className="truncate text-xs text-muted" title={dateTime(o.first_approved_at ?? o.first_received_at, tz)}>
                  {ago(o.first_approved_at ?? o.first_received_at)}
                  {o.utm_campaign ? ` · ${o.utm_campaign.split("|")[0]}` : o.attribution_category ? ` · ${ATTRIBUTION_LABELS[o.attribution_category] ?? o.attribution_category}` : ""}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="tabular font-medium">{o.approved_minor ? money(o.approved_minor, o.currency) : "—"}</p>
                <Badge tone={STATUS_TONE[o.financial_status] ?? "neutral"}>{STATUS_LABELS[o.financial_status] ?? o.financial_status}</Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function TopCampaigns({ from, to, projectId, currency }: { from: string; to: string; projectId: string; currency: string }) {
  const { data } = useApi<{ groups: { currency: string; rows: CampaignRow[] }[] }>(`/v1/media/entities?level=campaign&from=${from}&to=${to}${projectId ? `&project_id=${projectId}` : ""}`);
  const g = data?.groups.find((x) => x.currency === currency) ?? data?.groups[0];
  const rows = (g?.rows ?? [])
    .filter((r) => r.id && (r.spend_minor !== null || r.attributed_gross_minor !== "0"))
    .sort((a, b) => Number(b.attributed_gross_minor) - Number(a.attributed_gross_minor) || Number(b.spend_minor ?? 0) - Number(a.spend_minor ?? 0))
    .slice(0, 6);
  return (
    <Card title="Campanhas em destaque" actions={<Link href="/campanhas" className="text-sm text-primary underline">Gerenciar campanhas</Link>}>
      {!data ? (
        <Skeleton className="h-40" />
      ) : !rows.length ? (
        <p className="text-sm text-muted">
          Sem campanhas com gasto ou vendas no período. <Link className="underline" href="/integracoes/meta">Conecte a Meta</Link> e use os parâmetros de URL com IDs nos anúncios.
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <caption className="sr-only">Campanhas com mais faturamento no período</caption>
            <thead className="text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-1 pr-2 font-medium">Campanha</th>
                <th className="px-2 py-1 font-medium">Gasto</th>
                <th className="px-2 py-1 font-medium">Vendas</th>
                <th className="px-2 py-1 font-medium">Faturamento</th>
                <th className="px-2 py-1 font-medium">ROAS</th>
                <th className="py-1 pl-2 font-medium">Lucro</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="max-w-[220px] py-2 pr-2">
                    <div className="flex items-center gap-2">
                      <span className={cx("h-2 w-2 shrink-0 rounded-full", r.status === "ACTIVE" ? "bg-ok" : r.status ? "bg-muted" : "bg-border")} aria-label={r.status === "ACTIVE" ? "Ativa" : r.status ? "Pausada" : "Sem status"} />
                      <span className="truncate" title={r.name ?? r.id ?? ""}>
                        {r.name ?? `ID ${r.id}`}
                      </span>
                    </div>
                  </td>
                  <td className="tabular px-2 py-2">{r.spend_minor === null ? "—" : money(r.spend_minor, g!.currency)}</td>
                  <td className="tabular px-2 py-2">{ratio(r.orders_credit, Number.isInteger(Number(r.orders_credit)) ? 0 : 2)}</td>
                  <td className="tabular px-2 py-2">{money(r.attributed_gross_minor, g!.currency)}</td>
                  <td className="tabular px-2 py-2">{r.metrics.roas.status === "ok" ? `${ratio(r.metrics.roas.value)}x` : "—"}</td>
                  <td className={cx("tabular py-2 pl-2", r.metrics.profit.status === "ok" && (r.metrics.profit.value!.startsWith("-") ? "text-err" : "text-ok"))}>
                    {r.metrics.profit.status === "ok" ? money(r.metrics.profit.value, g!.currency) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function DashboardPage() {
  const { org } = useSession();
  const tz = org.organization.timezone;
  const today = todayIn(tz);
  const [preset, setPreset] = useState("7d");
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [basis, setBasis] = useState("approval");
  const [compare, setCompare] = useState(true);
  const [moreFilters, setMoreFilters] = useState(false);
  const [open, setOpen] = useState<Metric | null>(null);
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  const [projectId, setProjectId] = useState("");
  const [policy, setPolicy] = useState("default");
  const policies = useApi<{ policies: { policy_key: string; current: { name: string } | null }[] }>("/v1/attribution/policies");
  const qs = `from=${from}&to=${to}&basis=${basis}&compare=${compare}&policy=${policy}${projectId ? `&project_id=${projectId}` : ""}`;
  const summary = useApi<Summary>(`/v1/metrics/summary?${qs}`);
  const ts = useApi<Timeseries>(`/v1/metrics/timeseries?from=${from}&to=${to}${projectId ? `&project_id=${projectId}` : ""}`);

  const group = summary.data?.groups[0];
  const byId = useMemo(() => new Map(group?.metrics.map((m) => [m.id, m]) ?? []), [group]);
  const prevById = useMemo(() => new Map(group?.previous?.map((m) => [m.id, m]) ?? []), [group]);

  const days: string[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const cur = group?.currency ?? org.organization.currency;
  const grossByDay = days.map((d) => minorToChartNumber(ts.data?.days.find((x) => x.day === d && x.currency.trim() === cur)?.gross, cur));
  const netByDay = days.map((d) => minorToChartNumber(ts.data?.days.find((x) => x.day === d && x.currency.trim() === cur)?.net, cur));
  const spendByDay = days.map((d) => minorToChartNumber(ts.data?.spend.find((x) => x.day === d && x.currency.trim() === cur)?.spend, cur));
  const fmtMoneyAxis = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: cur, maximumFractionDigits: 0 });
  const choose = (p: string) => {
    const [f, t] = rangeFor(p, today);
    setPreset(p);
    setFrom(f!);
    setTo(t!);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Visão geral"
        description="Vendas confirmadas pelo checkout, gasto das contas de anúncios e lucro — conversões reportadas pelas redes ficam separadas."
        actions={
          <div className="text-right text-xs text-muted">
            <div>Fuso: {tz}</div>
            {summary.data && <div>Atualizado: {dateTime(summary.data.scope.as_of, tz)}</div>}
          </div>
        }
      />
      <SetupBanner />
      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map(([k, l]) => (
            <button
              key={k}
              type="button"
              aria-pressed={preset === k}
              onClick={() => choose(k)}
              className={cx("rounded-full border px-3 py-1 text-sm", preset === k ? "border-primary bg-primary text-primary-contrast" : "border-border hover:bg-surface-2")}
            >
              {l}
            </button>
          ))}
          <div className="flex items-center gap-1">
            <Input aria-label="De" type="date" className="w-auto py-1" value={from} max={to} onChange={(e) => (setPreset("custom"), setFrom(e.target.value))} />
            <span className="text-muted">–</span>
            <Input aria-label="Até" type="date" className="w-auto py-1" value={to} min={from} onChange={(e) => (setPreset("custom"), setTo(e.target.value))} />
          </div>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Comparar
          </label>
          <Button variant="ghost" aria-expanded={moreFilters} onClick={() => setMoreFilters((v) => !v)}>
            {moreFilters ? "Menos filtros" : "Mais filtros"}
          </Button>
        </div>
        {moreFilters && (
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Base temporal">
              {(id) => (
                <Select id={id} value={basis} onChange={(e) => setBasis(e.target.value)}>
                  <option value="approval">Por aprovação</option>
                  <option value="financial_movement">Por movimento financeiro</option>
                  <option value="acquisition_cohort">Por coorte de aquisição</option>
                </Select>
              )}
            </Field>
            <Field label="Projeto">
              {(id) => (
                <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                  <option value="">Todos autorizados</option>
                  {projects.data?.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Atribuição">
              {(id) => (
                <Select id={id} value={policy} onChange={(e) => setPolicy(e.target.value)}>
                  {(policies.data?.policies ?? [{ policy_key: "default", current: { name: "Principal" } }])
                    .filter((p) => p.current)
                    .map((p) => (
                      <option key={p.policy_key} value={p.policy_key}>
                        {p.policy_key === "default" ? `Principal — ${p.current!.name}` : p.current!.name}
                      </option>
                    ))}
                </Select>
              )}
            </Field>
          </div>
        )}
        {group?.policy_label && (
          <p className="mt-3 text-xs text-muted">
            Atribuição: <strong>{group.policy_label}</strong> (janela interna; não replica a configuração das redes). Base: {basis === "approval" ? "por aprovação" : basis === "financial_movement" ? "por movimento financeiro" : "por coorte"}.
          </p>
        )}
      </Card>

      {summary.data && (Number(summary.data.freshness.problem_receipts) > 0 || Number(summary.data.freshness.degraded_connections) > 0) && (
        <Card>
          <p className="text-sm">
            <Badge tone="warn">Atenção</Badge>{" "}
            {summary.data.freshness.problem_receipts} recebimento(s) com problema e {summary.data.freshness.degraded_connections} conexão(ões) degradada(s).{" "}
            <Link className="text-primary underline" href="/diagnostico">
              Ver diagnóstico
            </Link>
          </p>
        </Card>
      )}

      <ErrorBox error={summary.error} onRetry={summary.reload} />
      {summary.loading && !summary.data ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : group ? (
        <>
          {summary.data!.groups.length > 1 && (
            <p className="text-sm text-muted">Há vendas em {summary.data!.groups.length} moedas. Sem câmbio configurado, cada moeda é exibida separadamente (sem somar).</p>
          )}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {HERO.map((id) => byId.get(id))
              .filter((m): m is Metric => !!m)
              .map((m) => (
                <MetricCard key={m.id} m={m} prev={prevById.get(m.id)} onOpen={() => setOpen(m)} hero />
              ))}
          </div>
        </>
      ) : (
        <Empty title="Sem dados">Conecte um checkout em Integrações para começar a receber vendas.</Empty>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Faturamento, após estornos e investimento por dia" className="min-w-0 lg:col-span-2">
          {ts.data ? (
            <BarLineChart
              title="Receita e investimento por dia"
              labels={days.map((d) => d.slice(8, 10) + "/" + d.slice(5, 7))}
              series={[
                { label: "Receita bruta", color: "var(--primary)", values: grossByDay },
                { label: "Receita após estornos", color: "var(--ok)", values: netByDay },
                { label: "Investimento", color: "var(--warn)", values: spendByDay },
              ]}
              format={fmtMoneyAxis}
            />
          ) : (
            <Skeleton className="h-40" />
          )}
        </Card>
        <RecentSales tz={tz} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <TopCampaigns from={from} to={to} projectId={projectId} currency={cur} />
        </div>
        <Card title="Origem das vendas">
          {ts.data ? (
            <DistributionBar
              title="Categorias de atribuição"
              items={["paid", "organic", "direct", "recovery", "unattributed"].map((c, i) => ({
                label: ATTRIBUTION_LABELS[c]!,
                value: ts.data!.attribution_quality.filter((x) => x.category === c).reduce((a, x) => a + x.orders, 0),
                color: ["var(--primary)", "var(--ok)", "var(--muted)", "var(--warn)", "var(--err)"][i]!,
              }))}
            />
          ) : (
            <Skeleton className="h-10" />
          )}
          <p className="mt-3 text-xs text-muted">Conversões atribuídas pelas redes (Meta, Google…) não são somadas a estas métricas internas.</p>
        </Card>
      </div>

      {group && (
        <section aria-labelledby="mais-metricas" className="space-y-3">
          <h2 id="mais-metricas" className="text-base font-semibold">
            Mais métricas
          </h2>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {CARD_ORDER.filter((id) => basis === "acquisition_cohort" || !COHORT_ONLY.has(id))
              .map((id) => byId.get(id))
              .filter((m): m is Metric => !!m)
              .map((m) => (
                <MetricCard key={m.id} m={m} prev={prevById.get(m.id)} onOpen={() => setOpen(m)} />
              ))}
          </div>
          {group.notes.map((n) => (
            <p key={n} className="text-xs text-muted">
              {n}
            </p>
          ))}
        </section>
      )}

      <Card title="Vendas aprovadas por hora do dia">
        {ts.data ? (
          <BarLineChart
            title="Vendas por hora"
            labels={Array.from({ length: 24 }, (_, h) => `${h}h`)}
            series={[{ label: "Pedidos aprovados", color: "var(--primary)", values: Array.from({ length: 24 }, (_, h) => ts.data!.hours.find((x) => x.hour === h)?.orders ?? 0) }]}
            format={(v) => String(Math.round(v))}
          />
        ) : (
          <Skeleton className="h-40" />
        )}
      </Card>
      {summary.data && <p className="text-xs text-muted">{summary.data.disclaimer}</p>}

      {open && (
        <div role="dialog" aria-modal="true" aria-labelledby="metric-title" className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setOpen(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-surface p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-2">
              <h2 id="metric-title" className="text-lg font-semibold">
                {open.label}
              </h2>
              <Button variant="ghost" onClick={() => setOpen(null)} aria-label="Fechar">
                ×
              </Button>
            </div>
            <p className="tabular mt-2 text-2xl font-semibold">{display(open)}</p>
            {open.fraction && open.unit !== "count" && (
              <p className="text-xs text-muted">
                Valor exato: {open.fraction.num}/{open.fraction.den}
              </p>
            )}
            <dl className="mt-4 space-y-3 text-sm">
              <div>
                <dt className="font-medium">Fórmula</dt>
                <dd className="text-muted">{open.formula}</dd>
              </div>
              {open.denominator && (
                <div>
                  <dt className="font-medium">Denominador</dt>
                  <dd className="text-muted">{open.denominator}</dd>
                </div>
              )}
              <div>
                <dt className="font-medium">Fonte</dt>
                <dd className="text-muted">{open.source}</dd>
              </div>
              {open.status !== "ok" && (
                <div>
                  <dt className="font-medium">Por que “—”</dt>
                  <dd className="text-muted">{open.reason}</dd>
                </div>
              )}
              {open.notes.length > 0 && (
                <div>
                  <dt className="font-medium">Observações</dt>
                  <dd>
                    <ul className="list-disc pl-5 text-muted">
                      {open.notes.map((n) => (
                        <li key={n}>{n}</li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
            </dl>
            <Link className="mt-4 inline-block text-sm text-primary underline" href={`/vendas?from=${from}&to=${to}`}>
              Ver vendas que compõem o período
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
