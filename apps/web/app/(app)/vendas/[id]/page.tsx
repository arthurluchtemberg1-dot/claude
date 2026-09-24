"use client";

import Link from "next/link";
import { use, useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, ErrorBox, PageHeader, Skeleton, Table, Td } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { ATTRIBUTION_LABELS, STATUS_LABELS, dateTime, money } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Detail = Record<string, any>;

const ENTRY_LABELS: Record<string, string> = {
  approval: "Aprovação",
  refund: "Reembolso",
  chargeback: "Chargeback",
  chargeback_reversal: "Disputa ganha",
  fee: "Taxa",
  org_share: "Receita da organização",
  org_share_reversal: "Ajuste da receita da organização",
};

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { org, can } = useSession();
  const tz = org.organization.timezone;
  const { data, error, loading, reload } = useApi<Detail>(`/v1/orders/${id}`);
  const diag = useApi<Detail>(`/v1/diagnostics/tracking/orders/${id}`);
  const [revealed, setRevealed] = useState<Detail | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  if (loading && !data) return <Skeleton className="h-64" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  const o = data.order;
  const cur = String(o.currency ?? "").trim();
  const customer = revealed?.customer ?? data.customer;
  const current = data.attributions.find((a: Detail) => a.is_current && a.policy_key === "default") ?? data.attributions.find((a: Detail) => a.is_current);

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Pedido ${o.external_order_id}`}
        description={`${o.provider === "manual" ? "Venda manual (confirmação manual, não do checkout)" : `Checkout: ${o.provider}`}${o.is_test ? " · venda de teste" : ""}`}
        actions={
          <div className="flex gap-2">
            <CopyButton value={o.external_order_id} label="Copiar ID do pedido" />
            <Link className="self-center text-sm text-primary underline" href="/vendas">
              Voltar
            </Link>
          </div>
        }
      />
      <div className="grid gap-4 md:grid-cols-4">
        <Card title="Status">
          <Badge tone={o.financial_status === "approved" ? "ok" : "warn"}>{STATUS_LABELS[o.financial_status] ?? o.financial_status}</Badge>
          <p className="mt-2 text-xs text-muted">Primeira aprovação: {dateTime(o.first_approved_at, tz)}</p>
          <p className="text-xs text-muted">Primeiro recebimento: {dateTime(o.first_received_at, tz)}</p>
        </Card>
        <Card title="Aprovado">
          <p className="tabular text-xl font-semibold">{money(o.approved_minor, cur)}</p>
        </Card>
        <Card title="Estornado">
          <p className="tabular text-xl font-semibold">{money(o.reversed_minor, cur)}</p>
        </Card>
        <Card title="Líquido">
          <p className="tabular text-xl font-semibold">{money(BigInt(o.approved_minor) - BigInt(o.reversed_minor), cur)}</p>
        </Card>
      </div>

      {data.conflicts.length > 0 && (
        <Alert tone="warn" title="Conflitos registrados (nenhum valor foi alterado automaticamente)">
          <ul className="list-disc pl-5">
            {data.conflicts.map((c: Detail, i: number) => (
              <li key={i}>
                {c.message} <span className="text-xs">({dateTime(c.created_at, tz)})</span>
              </li>
            ))}
          </ul>
        </Alert>
      )}

      <Card title="Atribuição">
        {current ? (
          <div className="space-y-2 text-sm">
            <p>
              <Badge tone={current.category === "paid" ? "info" : current.category === "unattributed" ? "warn" : "neutral"}>{ATTRIBUTION_LABELS[current.category]}</Badge>{" "}
              <span className="text-muted">
                Modelo {current.model} · janela {current.window_days} dias · v{current.policy_version} · evidência {current.evidence ?? "—"} · qualidade {current.quality}
              </span>
            </p>
            <p className="text-muted">{current.reason}</p>
            {(current.campaign_id || current.utm_campaign) && (
              <p>
                Campanha: <span className="font-mono">{current.utm_campaign ?? "—"}</span> {current.campaign_id && <span className="font-mono text-xs">(ID {current.campaign_id})</span>}
              </p>
            )}
            {current.path?.length > 0 && (
              <details>
                <summary className="cursor-pointer text-primary">Caminho observado ({current.path.length} toque(s))</summary>
                <ol className="mt-2 list-decimal pl-5 font-mono text-xs">
                  {current.path.map((p: string, i: number) => (
                    <li key={i}>{p}</li>
                  ))}
                </ol>
              </details>
            )}
            {data.attributions.length > 1 && <p className="text-xs text-muted">{data.attributions.length} cálculos registrados (recálculos preservam o histórico).</p>}
          </div>
        ) : (
          <p className="text-sm text-muted">Atribuição ainda não calculada.</p>
        )}
        {diag.data && (
          <div className="mt-4">
            <h3 className="mb-2 text-sm font-semibold">Diagnóstico da passagem de origem</h3>
            <ol className="space-y-1 text-sm">
              {diag.data.steps.map((s: Detail) => (
                <li key={s.step} className="flex gap-2">
                  <Badge tone={s.ok ? "ok" : "warn"}>{s.ok ? "ok" : "falhou"}</Badge>
                  <span>{s.detail}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
      </Card>

      <Card title="Itens">
        <Table headers={["Produto", "Tipo", "Valor unitário", "Qtd."]}>
          {data.items.map((i: Detail) => (
            <tr key={i.item_key}>
              <Td>
                {i.name ?? i.external_product_id} <span className="font-mono text-xs text-muted">({i.external_product_id})</span>
              </Td>
              <Td>{i.item_type ?? "—"}</Td>
              <Td className="tabular">{money(i.unit_amount_minor, i.currency)}</Td>
              <Td className="tabular">{i.quantity}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Transações de pagamento">
          <Table headers={["Transação", "Status", "Valor", "Método", "Data"]}>
            {data.transactions.map((t: Detail) => (
              <tr key={t.transaction_key}>
                <Td className="font-mono text-xs">{t.transaction_key}</Td>
                <Td>
                  {t.status} {t.kind !== "initial" && <Badge>{t.kind}</Badge>}
                </Td>
                <Td className="tabular">{money(t.amount_minor, t.currency)}</Td>
                <Td>{t.method}</Td>
                <Td className="tabular text-xs">{dateTime(t.approved_at ?? t.status_occurred_at, tz)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Lançamentos financeiros (razão)">
          <Table headers={["Tipo", "Valor", "Ocorrido em", "Registro"]}>
            {data.ledger.map((l: Detail) => (
              <tr key={l.semantic_key}>
                <Td>
                  {ENTRY_LABELS[l.entry_type] ?? l.entry_type} {l.estimated && <Badge tone="info">estimado</Badge>}
                </Td>
                <Td className="tabular">{money(l.amount_minor, l.currency)}</Td>
                <Td className="tabular text-xs">{dateTime(l.occurred_at, tz)}</Td>
                <Td className="tabular text-xs">{dateTime(l.recorded_at, tz)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Linha do tempo de recebimentos e eventos">
        <ol className="space-y-2 text-sm">
          {data.events.map((e: Detail, i: number) => (
            <li key={i} className="border-l-2 border-border pl-3">
              <span className="font-medium">{e.event_type}</span> <span className="text-muted">({e.payload.source_event_type})</span> — {dateTime(e.occurred_at, tz)}
              {e.payload.notes?.length > 0 && <div className="text-xs text-muted">{e.payload.notes.join(" · ")}</div>}
            </li>
          ))}
        </ol>
        <p className="mt-3 text-xs text-muted">
          {data.receipts.length} recebimento(s); reentregas contadas: {data.receipts.reduce((a: number, r: Detail) => a + (r.delivery_count - 1), 0)}.
        </p>
      </Card>

      <Card title="Destinos de conversão">
        {data.deliveries.length === 0 ? (
          <p className="text-sm text-muted">Nenhuma entrega (destinos desligados ou venda não elegível).</p>
        ) : (
          <Table headers={["Destino", "Evento", "Status", "Tentativas", "Resposta"]}>
            {data.deliveries.map((d: Detail) => (
              <tr key={d.id}>
                <Td>{d.destination}</Td>
                <Td className="font-mono text-xs">
                  {d.event_name} · {d.event_id}
                </Td>
                <Td>
                  <Badge tone={d.status === "accepted" ? "ok" : d.status === "rejected" ? "err" : "warn"}>{d.status}</Badge>
                  {d.not_eligible_reason && <div className="text-xs text-muted">{d.not_eligible_reason}</div>}
                </Td>
                <Td className="tabular">{d.attempts}</Td>
                <Td className="text-xs">
                  {d.last_http_status ?? "—"} {d.last_trace_id && `· trace ${d.last_trace_id}`} {d.last_error && `· ${d.last_error}`}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">Aceito pela API não significa correspondência com usuário nem atribuição ao anúncio.</p>
      </Card>

      {customer && (
        <Card
          title="Cliente"
          actions={
            customer.masked && can("pii.read") ? (
              <Button
                variant="secondary"
                onClick={async () => {
                  try {
                    setRevealed(await api<Detail>(`/v1/orders/${id}?reveal=true`));
                  } catch (e) {
                    setRevealError(e instanceof ApiError ? e.message : "Falha");
                  }
                }}
              >
                Revelar dados pessoais (auditado)
              </Button>
            ) : null
          }
        >
          {revealError && <Alert tone="err" title={revealError} />}
          <dl className="grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
            <div>
              <dt className="text-muted">Nome</dt>
              <dd>{customer.name ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">E-mail</dt>
              <dd>{customer.email ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-muted">Telefone</dt>
              <dd>{customer.phone ?? "—"}</dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-muted">Origem: {customer.source}. Retenção até {dateTime(customer.retention_until, tz)}.</p>
        </Card>
      )}
    </div>
  );
}
