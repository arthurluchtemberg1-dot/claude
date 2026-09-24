"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Table, Td } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime, money } from "@/lib/format";

interface Customer {
  customer_key: string;
  identified_by: "email_sha256" | "order";
  email: string | null;
  name: string | null;
  orders: number;
  recurring: boolean;
  first_purchase_at: string;
  last_purchase_at: string;
  totals: { currency: string; approved_minor: string; net_minor: string }[];
}

const PAGE = 50;

export default function CustomersPage() {
  const { org } = useSession();
  const tz = org.organization.timezone;
  const [q, setQ] = useState("");
  const [applied, setApplied] = useState("");
  const [recurring, setRecurring] = useState("");
  const [offset, setOffset] = useState(0);
  const qs = `limit=${PAGE}&offset=${offset}${applied ? `&q=${encodeURIComponent(applied)}` : ""}${recurring ? `&recurring=${recurring}` : ""}`;
  const { data, error, loading, reload } = useApi<{ customers: Customer[]; total: number; pii_masked: boolean; criterion: string }>(`/v1/customers?${qs}`);

  return (
    <div className="space-y-4">
      <PageHeader title="Clientes" description="Histórico de compras aprovadas por cliente, sem compartilhar dados entre organizações." />
      <Card>
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setApplied(q.trim());
          }}
        >
          <div className="md:col-span-2">
            <Field label="Buscar por e-mail completo ou ID do pedido">{(id) => <Input id={id} value={q} onChange={(e) => setQ(e.target.value)} />}</Field>
          </div>
          <Field label="Recorrência">
            {(id) => (
              <Select
                id={id}
                value={recurring}
                onChange={(e) => {
                  setOffset(0);
                  setRecurring(e.target.value);
                }}
              >
                <option value="">Todos</option>
                <option value="true">Mais de uma compra</option>
                <option value="false">Uma compra</option>
              </Select>
            )}
          </Field>
          <div className="flex items-end">
            <Button type="submit">Buscar</Button>
          </div>
        </form>
      </Card>
      {data?.pii_masked && <Alert tone="info" title="Dados pessoais mascarados pelo seu perfil de acesso" />}
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton className="h-64" />}
      {data && data.customers.length === 0 && <Empty title="Nenhum cliente encontrado">Clientes aparecem a partir de vendas aprovadas com e-mail informado pelo checkout.</Empty>}
      {data && data.customers.length > 0 && (
        <Card>
          <Table headers={["Cliente", "Compras", "Primeira compra", "Última compra", "Aprovado", "Líquido"]}>
            {data.customers.map((c) => (
              <tr key={c.customer_key}>
                <Td>
                  <Link className="text-primary underline" href={`/clientes/${encodeURIComponent(c.customer_key)}`}>
                    {c.name ?? c.email ?? (c.identified_by === "order" ? "Pedido sem e-mail" : "Cliente")}
                  </Link>
                  <div className="text-xs text-muted">{c.email}</div>
                </Td>
                <Td className="tabular">
                  {c.orders} {c.recurring && <Badge tone="info">recorrente</Badge>}
                </Td>
                <Td className="tabular text-xs">{dateTime(c.first_purchase_at, tz)}</Td>
                <Td className="tabular text-xs">{dateTime(c.last_purchase_at, tz)}</Td>
                <Td className="tabular">
                  {c.totals.map((t) => (
                    <div key={t.currency}>{money(t.approved_minor, t.currency)}</div>
                  ))}
                </Td>
                <Td className="tabular">
                  {c.totals.map((t) => (
                    <div key={t.currency}>{money(t.net_minor, t.currency)}</div>
                  ))}
                </Td>
              </tr>
            ))}
          </Table>
          <div className="mt-3 flex items-center justify-between text-sm">
            <span className="text-muted">
              {offset + 1}–{offset + data.customers.length} de {data.total}
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                Anterior
              </Button>
              <Button variant="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Próxima
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">{data.criterion}</p>
        </Card>
      )}
    </div>
  );
}
