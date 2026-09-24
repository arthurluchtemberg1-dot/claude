"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, PageHeader, Select, Skeleton, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function DiagnosticsPage() {
  const { org, can } = useSession();
  const { toast, toastNode } = useToast();
  const tz = org.organization.timezone;
  const overview = useApi<any>("/v1/diagnostics/overview");
  const [status, setStatus] = useState("quarantined");
  const receipts = useApi<{ receipts: any[] }>(`/v1/diagnostics/receipts?status=${status}&limit=50`);
  const [body, setBody] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader title="Diagnóstico e qualidade" description="Recebimentos, quarentena, rejeições, fila de processamento, entregas e sinais de qualidade. Detalhes técnicos sem dados pessoais." actions={<Button variant="secondary" onClick={() => { overview.reload(); receipts.reload(); }}>Atualizar</Button>} />
      <ErrorBox error={overview.error} onRetry={overview.reload} />
      {!overview.data ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Card title="Alertas">
            {overview.data.alerts.length === 0 ? (
              <Alert tone="ok" title="Nenhum alerta calculável no momento" />
            ) : (
              <div className="space-y-2">
                {overview.data.alerts.map((a: any, i: number) => (
                  <Alert key={i} tone={a.severity === "error" ? "err" : a.severity === "warning" ? "warn" : "info"} title={a.message} />
                ))}
              </div>
            )}
          </Card>
          <div className="grid gap-4 md:grid-cols-3">
            <Card title="Recebimentos (7 dias)">
              {overview.data.receipts.length === 0 ? <p className="text-sm text-muted">Nenhum recebimento.</p> : (
                <ul className="space-y-1 text-sm">
                  {overview.data.receipts.map((r: any) => (
                    <li key={r.status} className="flex justify-between">
                      <span>{r.status}</span>
                      <span className="tabular">{r.n}</span>
                    </li>
                  ))}
                </ul>
              )}
              {overview.data.rejections.length > 0 && (
                <div className="mt-2 text-xs text-muted">
                  Rejeitados por autenticação: {overview.data.rejections.map((r: any) => `${r.reason} (${r.n})`).join("; ")}
                </div>
              )}
            </Card>
            <Card title="Fila (outbox)">
              {overview.data.outbox.length === 0 ? <p className="text-sm text-muted">Sem trabalho pendente.</p> : (
                <ul className="space-y-1 text-sm">
                  {overview.data.outbox.map((o: any) => (
                    <li key={o.status} className="flex justify-between">
                      <span>{o.status}</span>
                      <span className="tabular">
                        {o.n} · desde {dateTime(o.oldest, tz)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Atribuição (30 dias)">
              <ul className="space-y-1 text-sm">
                {overview.data.attribution_30d.map((a: any) => (
                  <li key={a.category} className="flex justify-between">
                    <span>{a.category}</span>
                    <span className="tabular">{a.n}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted">Conflitos abertos em pedidos: {overview.data.open_conflicts}</p>
            </Card>
          </div>
          <Card title="Conexões">
            <Table headers={["Conexão", "Estado", "Último sucesso", "Último erro"]}>
              {overview.data.connections.map((c: any) => (
                <tr key={c.id}>
                  <Td>
                    {c.name} <span className="text-xs text-muted">({c.provider})</span>
                  </Td>
                  <Td>
                    <Badge tone={c.status === "connected" ? "ok" : "warn"}>{c.status}</Badge>
                  </Td>
                  <Td className="text-xs">{dateTime(c.last_success_at, tz)}</Td>
                  <Td className="text-xs">{c.last_error ?? "—"}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
      <Card
        title="Recebimentos"
        actions={
          <Select aria-label="Filtrar por status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-auto">
            {["quarantined", "dead", "failed", "pending", "ignored", "processed"].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        }
      >
        {!receipts.data?.receipts.length ? (
          <Empty title="Nenhum recebimento neste estado" />
        ) : (
          <Table headers={["Recebido", "Provedor", "Evento", "Motivo", "Entregas", ""]}>
            {receipts.data.receipts.map((r) => (
              <tr key={r.id}>
                <Td className="tabular text-xs">{dateTime(r.received_at, tz)}</Td>
                <Td>{r.provider}</Td>
                <Td className="font-mono text-xs">{r.source_event_type ?? "—"}</Td>
                <Td className="text-xs">{r.status_reason ?? "—"}</Td>
                <Td className="tabular">{r.delivery_count}</Td>
                <Td>
                  <div className="flex gap-2">
                    {can("pii.read") && (
                      <Button variant="ghost" onClick={async () => { try { const b = await api<{ body: string }>(`/v1/diagnostics/receipts/${r.id}/body`); setBody(b.body); } catch (e) { toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" }); } }}>
                        Ver corpo (auditado)
                      </Button>
                    )}
                    {can("provider.connect") && ["quarantined", "dead", "failed", "ignored"].includes(r.status) && (
                      <Button variant="secondary" onClick={async () => { try { await api(`/v1/diagnostics/receipts/${r.id}/reprocess`, { method: "POST", body: {} }); toast({ tone: "ok", text: "Reprocessamento agendado (não reenvia conversões já enviadas)" }); receipts.reload(); } catch (e) { toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" }); } }}>
                        Reprocessar
                      </Button>
                    )}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {body && (
          <div className="mt-3">
            <pre className="max-h-80 overflow-auto rounded bg-surface-2 p-3 text-xs">{body}</pre>
            <Button variant="ghost" onClick={() => setBody(null)}>
              Fechar
            </Button>
          </div>
        )}
      </Card>
      <p className="text-xs text-muted">
        Diagnóstico da passagem de origem de um pedido específico: abra o pedido em <Link className="text-primary underline" href="/vendas">Vendas</Link>.
      </p>
    </div>
  );
}
