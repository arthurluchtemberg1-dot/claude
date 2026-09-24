"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Table, Td } from "@/components/ui";
import { useApi } from "@/lib/api";
import { addDays, money, ratio, todayIn } from "@/lib/format";

type Dimension = "campaign" | "adset" | "ad" | "network";
type Metric = { status: "ok"; value: string } | { status: "undefined" | "unavailable"; reason: string };

interface Row {
  id: string | null;
  network: string | null;
  name: string | null;
  previous_names: string[];
  known_entity: boolean | null;
  entity_source: string | null;
  spend_minor: string | null;
  impressions: string | null;
  link_clicks: string | null;
  orders: number;
  orders_credit: string;
  attributed_gross_minor: string;
  attributed_net_minor: string;
  roas_gross: Metric;
  cpa_minor: Metric;
}

interface Breakdown {
  scope: { dimension: Dimension; policy: string };
  groups: {
    currency: string;
    rows: Row[];
    truncated: boolean;
    totals: { spend_minor: string; allocated_spend_minor: string; approved_orders: number; gross_minor: string; net_minor: string; unattributed_orders: number; unattributed_gross_minor: string };
    notes: string[];
  }[];
  disclaimer: string;
}

const DIMENSIONS: Record<Dimension, string> = { campaign: "Campanha", adset: "Conjunto/grupo", ad: "Anúncio", network: "Rede" };

function metricText(m: Metric, fmt: (v: string) => string) {
  return m.status === "ok" ? fmt(m.value) : "—";
}

export default function CampaignsPage() {
  const { org } = useSession();
  const tz = org.organization.timezone;
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const [dimension, setDimension] = useState<Dimension>("campaign");
  const [basis, setBasis] = useState("approval");
  const [campaign, setCampaign] = useState<{ id: string; name: string | null } | null>(null);
  const qs = `dimension=${dimension}&from=${from}&to=${to}&basis=${basis}${campaign ? `&campaign_id=${encodeURIComponent(campaign.id)}` : ""}`;
  const { data, error, loading, reload } = useApi<Breakdown>(`/v1/reports/breakdown?${qs}`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Campanhas"
        description="Gasto importado/sincronizado e vendas confirmadas atribuídas, combinados por ID (renomear campanha não quebra o histórico). Nada é somado entre níveis."
      />
      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Field label="De">{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Até">{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          <Field label="Nível">
            {(id) => (
              <Select id={id} value={dimension} onChange={(e) => setDimension(e.target.value as Dimension)}>
                {Object.entries(DIMENSIONS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Base temporal">
            {(id) => (
              <Select id={id} value={basis} onChange={(e) => setBasis(e.target.value)}>
                <option value="approval">Por aprovação</option>
                <option value="financial_movement">Por movimento financeiro</option>
              </Select>
            )}
          </Field>
          {campaign && (
            <div className="flex items-end">
              <Button variant="secondary" onClick={() => { setCampaign(null); setDimension("campaign"); }}>
                Voltar às campanhas
              </Button>
            </div>
          )}
        </div>
        {campaign && (
          <p className="mt-2 text-sm">
            Detalhando a campanha <strong>{campaign.name ?? campaign.id}</strong> <span className="font-mono text-xs text-muted">({campaign.id})</span>
          </p>
        )}
      </Card>

      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton className="h-64" />}
      {data?.groups.map((g) => (
        <Card key={g.currency} title={`${DIMENSIONS[dimension]} · ${g.currency}`}>
          {g.rows.length === 0 ? (
            <Empty title="Sem gasto nem vendas atribuídas neste nível e período">Importe gastos em Custos e mídia ou confira a atribuição em Vendas.</Empty>
          ) : (
            <Table
              caption={`Desempenho por ${DIMENSIONS[dimension].toLowerCase()}`}
              headers={[DIMENSIONS[dimension], "Gasto", "Vendas atribuídas", "Receita atribuída", "ROAS", "CPA", "Impressões", ""]}
            >
              {g.rows.map((r) => (
                <tr key={`${r.network}-${r.id}`}>
                  <Td>
                    <div className="font-medium">{dimension === "network" ? (r.network ?? "Sem rede identificada") : (r.name ?? (r.id ? "Sem nome registrado" : "Sem ID de campanha"))}</div>
                    {r.id && dimension !== "network" && <div className="font-mono text-xs text-muted">ID {r.id}</div>}
                    {r.previous_names.length > 0 && <div className="text-xs text-muted">Nomes anteriores: {r.previous_names.join(", ")}</div>}
                    {r.known_entity === false && r.id && <Badge tone="warn" title="ID declarado na origem da venda sem gasto/entidade registrada nesta organização">ID não confirmado</Badge>}
                  </Td>
                  <Td className="tabular">{r.spend_minor === null ? <span title="Sem gasto importado/sincronizado para este ID">indisponível</span> : money(r.spend_minor, g.currency)}</Td>
                  <Td className="tabular">
                    {ratio(r.orders_credit, 2)}
                    {r.orders_credit !== String(r.orders) && <div className="text-xs text-muted">{r.orders} pedido(s) com crédito</div>}
                  </Td>
                  <Td className="tabular">{money(r.attributed_gross_minor, g.currency)}</Td>
                  <Td className="tabular">
                    <span title={r.roas_gross.status !== "ok" ? r.roas_gross.reason : undefined}>{metricText(r.roas_gross, (v) => ratio(v, 2))}</span>
                  </Td>
                  <Td className="tabular">
                    <span title={r.cpa_minor.status !== "ok" ? r.cpa_minor.reason : undefined}>{metricText(r.cpa_minor, (v) => money(v, g.currency))}</span>
                  </Td>
                  <Td className="tabular">{r.impressions === null ? "—" : Number(r.impressions).toLocaleString("pt-BR")}</Td>
                  <Td>
                    {dimension === "campaign" && r.id && (
                      <Button variant="ghost" onClick={() => { setCampaign({ id: r.id!, name: r.name }); setDimension("ad"); }}>
                        Anúncios
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          )}
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted">Gasto total (um nível por conta/dia)</dt>
              <dd className="tabular">{money(g.totals.spend_minor, g.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted">Gasto detalhado neste nível</dt>
              <dd className="tabular">{money(g.totals.allocated_spend_minor, g.currency)}</dd>
            </div>
            <div>
              <dt className="text-muted">Pedidos aprovados</dt>
              <dd className="tabular">
                {g.totals.approved_orders} · {money(g.totals.gross_minor, g.currency)}
              </dd>
            </div>
            <div>
              <dt className="text-muted">Sem atribuição</dt>
              <dd className="tabular">
                {g.totals.unattributed_orders} · {money(g.totals.unattributed_gross_minor, g.currency)}
              </dd>
            </div>
          </dl>
          {g.notes.map((n, i) => (
            <p key={i} className="mt-1 text-xs text-muted">
              {n}
            </p>
          ))}
          {g.truncated && <Alert tone="warn" title="Exibindo as 500 primeiras linhas" />}
        </Card>
      ))}
      {data && <p className="text-xs text-muted">{data.disclaimer}</p>}
      <Alert tone="info" title="Ações em campanhas (pausar, orçamento, duplicar) ainda não disponíveis">
        Dependem da conexão oficial com a Meta (app e permissões aprovadas). Até lá, esta tela é somente leitura.
      </Alert>
    </div>
  );
}
