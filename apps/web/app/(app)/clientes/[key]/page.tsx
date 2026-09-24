"use client";

import Link from "next/link";
import { use } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, ErrorBox, PageHeader, Skeleton, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { ATTRIBUTION_LABELS, STATUS_LABELS, dateTime, money } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function CustomerDetailPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = use(params);
  const decoded = decodeURIComponent(key);
  const { org, can } = useSession();
  const tz = org.organization.timezone;
  const { toast, toastNode } = useToast();
  const { data, error, loading, reload } = useApi<Record<string, any>>(`/v1/customers/${encodeURIComponent(decoded)}`);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast({ tone: "ok", text: ok });
      reload();
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
    }
  }

  if (loading && !data) return <Skeleton className="h-64" />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader
        title={data.name ?? data.email ?? "Cliente"}
        description={data.identified_by === "email_sha256" ? "Pedidos agrupados pelo e-mail informado no checkout (comparado por hash, somente nesta organização)." : "Pedido fora do agrupamento por e-mail."}
        actions={
          <Link className="self-center text-sm text-primary underline" href="/clientes">
            Voltar
          </Link>
        }
      />
      {data.pii_masked && <Alert tone="info" title="Dados pessoais mascarados pelo seu perfil de acesso" />}
      <Card title="Compras">
        <Table headers={["Pedido", "Status", "Aprovado", "Estornado", "Origem", "Produtos", "Data", ""]}>
          {data.orders.map((o: any) => (
            <tr key={o.id}>
              <Td>
                <Link className="font-mono text-xs text-primary underline" href={`/vendas/${o.id}`}>
                  {o.external_order_id}
                </Link>
                {o.excluded && (
                  <div>
                    <Badge tone="warn" title={o.exclusion_reason}>
                      fora do agrupamento
                    </Badge>
                  </div>
                )}
              </Td>
              <Td>{STATUS_LABELS[o.financial_status] ?? o.financial_status}</Td>
              <Td className="tabular">{money(o.approved_minor, o.currency)}</Td>
              <Td className="tabular">{money(o.reversed_minor, o.currency)}</Td>
              <Td className="text-xs">{o.attribution_category ? `${ATTRIBUTION_LABELS[o.attribution_category] ?? o.attribution_category}${o.utm_campaign ? ` · ${o.utm_campaign}` : ""}` : "—"}</Td>
              <Td className="text-xs">{o.products ?? "—"}</Td>
              <Td className="tabular text-xs">{dateTime(o.first_approved_at, tz)}</Td>
              <Td>
                {can("sales.write") &&
                  (o.excluded ? (
                    <Button variant="ghost" onClick={() => act(() => api(`/v1/customers/exclusions/${o.id}`, { method: "DELETE" }), "Pedido reagrupado")}>
                      Reagrupar
                    </Button>
                  ) : data.orders.length > 1 ? (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        const reason = prompt("Motivo para separar este pedido do cliente (auditado):");
                        if (reason && reason.trim().length >= 3) void act(() => api("/v1/customers/exclusions", { method: "POST", body: { order_id: o.id, reason } }), "Pedido separado do cliente");
                      }}
                    >
                      Separar
                    </Button>
                  ) : null)}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card title="Consentimentos observados">
        {data.consents.length === 0 ? (
          <p className="text-sm text-muted">Nenhum visitante do SDK vinculado por token a estes pedidos.</p>
        ) : (
          <Table headers={["Registro", "Analytics", "Publicidade", "Armazenamento", "Origem"]}>
            {data.consents.map((c: any) => (
              <tr key={c.visitor_id}>
                <Td className="tabular text-xs">{dateTime(c.recorded_at, tz)}</Td>
                <Td>{String(c.analytics ?? "—")}</Td>
                <Td>{String(c.advertising ?? "—")}</Td>
                <Td>{String(c.storage ?? "—")}</Td>
                <Td>{c.source}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
