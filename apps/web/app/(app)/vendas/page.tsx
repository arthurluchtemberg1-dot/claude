"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession } from "@/components/shell";
import { Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Table, Td } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { ATTRIBUTION_LABELS, STATUS_LABELS, dateTime, money } from "@/lib/format";

interface OrderRow {
  id: string;
  provider: string;
  external_order_id: string;
  currency: string;
  financial_status: string;
  approved_minor: string;
  reversed_minor: string;
  first_approved_at: string | null;
  first_received_at: string;
  is_test: boolean;
  attribution_category: string | null;
  utm_source: string | null;
  utm_campaign: string | null;
  campaign_id: string | null;
  unattributed_reason: string | null;
  products: string | null;
  customer: { email: string | null; name: string | null };
}

const statusTone = (s: string) => (s === "approved" ? "ok" : s.includes("reversed") || s === "failed" ? "err" : "warn");

export default function SalesPage() {
  const { org, can } = useSession();
  const [filters, setFilters] = useState({ q: "", status: "", attribution: "", include_test: false });
  const [rows, setRows] = useState<OrderRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [masked, setMasked] = useState(true);

  async function load(reset: boolean) {
    setLoading(true);
    setError(null);
    const p = new URLSearchParams();
    if (filters.q) p.set("q", filters.q);
    if (filters.status) p.set("status", filters.status);
    if (filters.attribution) p.set("attribution", filters.attribution);
    if (filters.include_test) p.set("include_test", "true");
    if (!reset && cursor) p.set("cursor", cursor);
    p.set("limit", "50");
    try {
      const r = await api<{ orders: OrderRow[]; next_cursor: string | null; pii_masked: boolean }>(`/v1/orders?${p}`);
      setRows((prev) => (reset ? r.orders : [...prev, ...r.orders]));
      setCursor(r.next_cursor);
      setMasked(r.pii_masked);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "network", "Falha de rede"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(true);
  }, [filters.status, filters.attribution, filters.include_test]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Vendas"
        description="Pedidos confirmados pelo checkout, com status financeiro e atribuição pela política padrão. Paginação no servidor."
        actions={
          can("data.export") ? (
            <a
              className="text-sm text-primary underline"
              href={`/api/v1/exports/orders.csv?from=${encodeURIComponent(new Date(Date.now() - 30 * 86400000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 86400000).toISOString())}`}
              onClick={(e) => {
                e.preventDefault();
                void api<Response>(e.currentTarget.getAttribute("href")!.replace("/api", ""), { raw: true }).then(async (r) => {
                  const blob = await r.blob();
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = "pedidos-30-dias.csv";
                  a.click();
                });
              }}
            >
              Exportar CSV (30 dias)
            </a>
          ) : null
        }
      />
      <Card>
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-5"
          onSubmit={(e) => {
            e.preventDefault();
            void load(true);
          }}
        >
          <Field label="Buscar pedido">{(id) => <Input id={id} placeholder="ID do pedido" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />}</Field>
          <Field label="Status">
            {(id) => (
              <Select id={id} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
                <option value="">Todos</option>
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Atribuição">
            {(id) => (
              <Select id={id} value={filters.attribution} onChange={(e) => setFilters({ ...filters, attribution: e.target.value })}>
                <option value="">Todas</option>
                {Object.entries(ATTRIBUTION_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={filters.include_test} onChange={(e) => setFilters({ ...filters, include_test: e.target.checked })} /> Incluir vendas de teste
          </label>
          <div className="flex items-end">
            <Button type="submit">Filtrar</Button>
          </div>
        </form>
      </Card>
      <ErrorBox error={error} onRetry={() => load(true)} />
      {masked && <p className="text-xs text-muted">Dados pessoais mascarados (seu perfil não possui permissão de leitura de dados pessoais).</p>}
      {loading && !rows.length ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <Empty title="Nenhuma venda encontrada">Vendas aparecem aqui após o checkout enviar eventos autenticados.</Empty>
      ) : (
        <Table caption="Lista de vendas" headers={["Pedido", "Aprovada em", "Status", "Valor", "Estornado", "Produtos", "Origem", "Cliente"]}>
          {rows.map((o) => (
            <tr key={o.id} className="hover:bg-surface-2">
              <Td>
                <Link className="font-mono text-primary underline" href={`/vendas/${o.id}`}>
                  {o.external_order_id}
                </Link>
                <div className="text-xs text-muted">
                  {o.provider}
                  {o.is_test && " · teste"}
                </div>
              </Td>
              <Td className="tabular whitespace-nowrap">{dateTime(o.first_approved_at ?? o.first_received_at, org.organization.timezone)}</Td>
              <Td>
                <Badge tone={statusTone(o.financial_status)}>{STATUS_LABELS[o.financial_status] ?? o.financial_status}</Badge>
              </Td>
              <Td className="tabular whitespace-nowrap">{money(o.approved_minor, o.currency)}</Td>
              <Td className="tabular whitespace-nowrap">{o.reversed_minor !== "0" ? money(o.reversed_minor, o.currency) : "—"}</Td>
              <Td className="max-w-[14rem] truncate">{o.products ?? "—"}</Td>
              <Td>
                <Badge tone={o.attribution_category === "paid" ? "info" : o.attribution_category === "unattributed" || !o.attribution_category ? "warn" : "neutral"}>
                  {ATTRIBUTION_LABELS[o.attribution_category ?? "unattributed"]}
                </Badge>
                <div className="text-xs text-muted">{[o.utm_source, o.utm_campaign].filter(Boolean).join(" / ") || o.unattributed_reason || ""}</div>
              </Td>
              <Td className="text-xs">{o.customer.email ?? "—"}</Td>
            </tr>
          ))}
        </Table>
      )}
      {cursor && (
        <Button variant="secondary" busy={loading} onClick={() => load(false)}>
          Carregar mais
        </Button>
      )}
    </div>
  );
}
