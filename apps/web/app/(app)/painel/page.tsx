"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BarLineChart, DistributionBar } from "@/components/charts";
import { useSession } from "@/components/shell";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/api";
import { addDays, dateTime, minorToChartNumber, money, ratio, todayIn } from "@/lib/format";

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

const CARD_ORDER = [
  "customers_acquired",
  "ltv_observed",
  "gross_approved_revenue",
  "revenue_after_reversals",
  "financial_reversals",
  "media_spend",
  "approved_orders_gross",
  "retained_orders",
  "cpa_approved",
  "cpa_retained",
  "roas_gross",
  "roas_after_reversals",
  "avg_ticket_gross",
  "fees",
  "contribution_after_media",
  "org_revenue",
  "mer",
  "unattributed_orders",
  "orders_generated",
  "payment_approval_rate",
  "cpl",
  "breakeven_roas",
];

function display(m: Metric): string {
  if (m.status !== "ok") return "—";
  if (m.unit === "money") return money(m.amount_minor, m.currency);
  if (m.unit === "percent") return `${ratio(m.value, 1)}%`;
  if (m.unit === "ratio") return ratio(m.value, 2);
  return m.fractional ? ratio(m.value, 2) : Number(m.value).toLocaleString("pt-BR");
}

function delta(cur: Metric, prev: Metric | undefined): string | null {
  if (!prev || cur.status !== "ok" || prev.status !== "ok") return null;
  const a = Number(cur.unit === "money" ? cur.amount_minor : cur.value);
  const b = Number(prev.unit === "money" ? prev.amount_minor : prev.value);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const pct = ((a - b) / Math.abs(b)) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs período anterior`;
}

function MetricCard({ m, prev, onOpen }: { m: Metric; prev?: Metric; onOpen: () => void }) {
  const q = m.status === "ok" ? m.quality : undefined;
  const d = delta(m, prev);
  return (
    <button type="button" onClick={onOpen} className="flex flex-col gap-1 rounded-lg border border-border bg-surface p-3 text-left hover:border-primary" aria-label={`${m.label}: ${display(m)}. Abrir definição`}>
      <span className="flex items-center justify-between gap-2 text-xs text-muted">
        {m.label}
        {q === "partial" && <Badge tone="warn">parcial</Badge>}
        {q === "estimated" && <Badge tone="info">estimado</Badge>}
        {m.status === "unavailable" && <Badge>indisponível</Badge>}
      </span>
      <span className="tabular text-xl font-semibold">{display(m)}</span>
      {m.status !== "ok" && <span className="text-xs text-muted">{m.reason}</span>}
      {d && <span className="text-xs text-muted">{d}</span>}
    </button>
  );
}

export default function DashboardPage() {
  const { org } = useSession();
  const tz = org.organization.timezone;
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [basis, setBasis] = useState("approval");
  const [compare, setCompare] = useState(true);
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Visão geral"
        description={summary.data?.disclaimer ?? "Métricas internas calculadas a partir de vendas confirmadas pelo checkout."}
        actions={
          <div className="text-right text-xs text-muted">
            <div>Fuso: {tz}</div>
            {summary.data && <div>Atualizado: {dateTime(summary.data.scope.as_of, tz)}</div>}
          </div>
        }
      />
      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-7">
          <Field label="De">{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Até">{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
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
          <div className="col-span-2 flex flex-wrap items-end gap-2">
            {[
              ["Hoje", 0],
              ["7 dias", 6],
              ["30 dias", 29],
            ].map(([l, n]) => (
              <Button key={String(l)} variant="secondary" onClick={() => { setTo(today); setFrom(addDays(today, -Number(n))); }}>
                {l}
              </Button>
            ))}
            <label className="flex items-center gap-1 text-sm">
              <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Comparar
            </label>
          </div>
        </div>
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
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : group ? (
        <>
          {summary.data!.groups.length > 1 && (
            <p className="text-sm text-muted">Há vendas em {summary.data!.groups.length} moedas. Sem câmbio configurado, cada moeda é exibida separadamente (sem somar).</p>
          )}
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
        </>
      ) : (
        <Empty title="Sem dados">Conecte um checkout em Integrações para começar a receber vendas.</Empty>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Receita bruta, após estornos e investimento por dia" className="lg:col-span-2">
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
        <Card title="Qualidade da atribuição (pedidos)">
          {ts.data ? (
            <DistributionBar
              title="Categorias de atribuição"
              items={["paid", "organic", "direct", "recovery", "unattributed"].map((c, i) => ({
                label: { paid: "Mídia paga", organic: "Orgânico", direct: "Direto", recovery: "Recuperação", unattributed: "Sem atribuição" }[c]!,
                value: ts.data!.attribution_quality.filter((x) => x.category === c).reduce((a, x) => a + x.orders, 0),
                color: ["var(--primary)", "var(--ok)", "var(--muted)", "var(--warn)", "var(--err)"][i]!,
              }))}
            />
          ) : (
            <Skeleton className="h-10" />
          )}
          <p className="mt-3 text-xs text-muted">Conversões atribuídas pelas redes (Meta, Google…) não são somadas a estas métricas internas.</p>
        </Card>
        <Card title="Vendas aprovadas por hora do dia" className="lg:col-span-3">
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
      </div>

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
