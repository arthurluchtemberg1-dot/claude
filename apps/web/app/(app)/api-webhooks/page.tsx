"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, Empty, ErrorBox, Field, Input, PageHeader, Select, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const SCOPE_LABELS: Record<string, string> = {
  "orders:read": "Ler pedidos",
  "orders:write": "Importar vendas",
  "metrics:read": "Ler métricas",
  "campaigns:read": "Ler campanhas",
  "products:read": "Ler produtos",
  "integrations:read": "Ler estado das integrações",
};
const EVENT_LABELS: Record<string, string> = {
  "order.approved": "Venda aprovada",
  "order.reversed": "Estorno/chargeback",
  "order.status_changed": "Mudança de status do pedido",
};
const DELIVERY_TONE: Record<string, "ok" | "warn" | "err" | "neutral"> = { succeeded: "ok", pending: "neutral", retry_scheduled: "warn", dead: "err", blocked: "err", skipped: "neutral" };

function Secret({ title, value, onClose }: { title: string; value: string; onClose: () => void }) {
  return (
    <Alert tone="warn" title={title}>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="break-all rounded bg-surface-2 px-2 py-1 font-mono text-xs">{value}</code>
        <CopyButton value={value} />
        <Button variant="ghost" onClick={onClose}>
          Já guardei
        </Button>
      </div>
    </Alert>
  );
}

function Deliveries({ subscriptionId, tz, onResend }: { subscriptionId: string; tz: string; onResend: (id: string) => void }) {
  const { data, error, reload } = useApi<{ deliveries: any[] }>(`/v1/webhook-subscriptions/${subscriptionId}/deliveries?limit=30`);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return null;
  if (!data.deliveries.length) return <p className="text-sm text-muted">Nenhuma entrega ainda.</p>;
  return (
    <Table headers={["Evento", "Status", "Tentativas", "Resposta", "Criada", ""]}>
      {data.deliveries.map((d) => (
        <tr key={d.id}>
          <Td>
            <div>{EVENT_LABELS[d.event_type] ?? d.event_type}</div>
            <div className="font-mono text-xs text-muted">{d.id}</div>
          </Td>
          <Td>
            <Badge tone={DELIVERY_TONE[d.status] ?? "neutral"}>{d.status}</Badge>
            {d.next_attempt_at && <div className="text-xs text-muted">próxima: {dateTime(d.next_attempt_at, tz)}</div>}
          </Td>
          <Td className="tabular">{d.attempts}</Td>
          <Td className="text-xs">{d.last_error ?? (d.last_http_status ? `HTTP ${d.last_http_status}` : "—")}</Td>
          <Td className="tabular text-xs">{dateTime(d.created_at, tz)}</Td>
          <Td>
            {["dead", "blocked", "skipped"].includes(d.status) && d.event_type !== "test.ping" && (
              <Button variant="secondary" onClick={() => onResend(d.id)}>
                Reenviar
              </Button>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

export default function ApiWebhooksPage() {
  const { org, can } = useSession();
  const tz = org.organization.timezone;
  const { toast, toastNode } = useToast();
  const keys = useApi<{ api_keys: any[]; scopes: string[] }>(can("api.manage") ? "/v1/api-keys" : null);
  const subs = useApi<{ subscriptions: any[]; events: string[] }>(can("api.manage") ? "/v1/webhook-subscriptions" : null);
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  const [keyForm, setKeyForm] = useState({ name: "Integração ERP", environment: "production", project_id: "", scopes: ["orders:read"] as string[] });
  const [subForm, setSubForm] = useState({ name: "Meu sistema", url: "https://", events: ["order.approved"] as string[], include_test: false });
  const [secret, setSecret] = useState<{ title: string; value: string } | null>(null);
  const [openDeliveries, setOpenDeliveries] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function act<T>(fn: () => Promise<T>, ok: string): Promise<T | null> {
    try {
      const r = await fn();
      toast({ tone: "ok", text: ok });
      keys.reload();
      subs.reload();
      return r;
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
      return null;
    }
  }

  if (!can("api.manage")) {
    return (
      <div className="space-y-4">
        <PageHeader title="API e webhooks" />
        <Alert tone="info" title="Somente proprietários e administradores gerenciam chaves de API e webhooks de saída." />
      </div>
    );
  }

  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const sandbox = keyForm.environment === "sandbox";

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader
        title="API e webhooks"
        description={
          <>
            API REST versionada para sistemas próprios (documentação OpenAPI em <code className="font-mono">/public/v1/openapi.json</code>) e webhooks de saída assinados. Chaves e segredos aparecem uma única vez.
          </>
        }
      />
      {secret && <Secret title={secret.title} value={secret.value} onClose={() => setSecret(null)} />}

      <Card title="Chaves de API">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await act(
              () =>
                api<{ key: string }>("/v1/api-keys", {
                  method: "POST",
                  body: { name: keyForm.name, environment: keyForm.environment, scopes: keyForm.scopes, project_ids: keyForm.project_id ? [keyForm.project_id] : [] },
                }),
              "Chave criada",
            );
            if (r) setSecret({ title: "Copie a chave agora — ela não será exibida novamente", value: r.key });
            setBusy(false);
          }}
        >
          <Field label="Nome">{(id) => <Input id={id} required value={keyForm.name} onChange={(e) => setKeyForm({ ...keyForm, name: e.target.value })} />}</Field>
          <Field label="Ambiente" hint={sandbox ? "Sandbox: só lê e cria vendas de teste" : undefined}>
            {(id) => (
              <Select
                id={id}
                value={keyForm.environment}
                onChange={(e) => setKeyForm({ ...keyForm, environment: e.target.value, scopes: e.target.value === "sandbox" ? keyForm.scopes.filter((s) => s !== "metrics:read" && s !== "campaigns:read") : keyForm.scopes })}
              >
                <option value="production">Produção</option>
                <option value="sandbox">Sandbox (teste)</option>
              </Select>
            )}
          </Field>
          <Field label="Projeto">
            {(id) => (
              <Select id={id} value={keyForm.project_id} onChange={(e) => setKeyForm({ ...keyForm, project_id: e.target.value })}>
                <option value="">Todos os projetos</option>
                {projects.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <fieldset className="md:col-span-4">
            <legend className="mb-1 text-sm font-medium">Escopos</legend>
            <div className="flex flex-wrap gap-3">
              {(keys.data?.scopes ?? Object.keys(SCOPE_LABELS)).map((s) => {
                const disabled = sandbox && (s === "metrics:read" || s === "campaigns:read");
                return (
                  <label key={s} className={`flex items-center gap-1 text-sm ${disabled ? "opacity-50" : ""}`}>
                    <input type="checkbox" disabled={disabled} checked={keyForm.scopes.includes(s)} onChange={() => setKeyForm({ ...keyForm, scopes: toggle(keyForm.scopes, s) })} />
                    {SCOPE_LABELS[s] ?? s}
                  </label>
                );
              })}
            </div>
          </fieldset>
          <div className="md:col-span-4">
            <Button type="submit" busy={busy} disabled={!keyForm.scopes.length}>
              Criar chave
            </Button>
          </div>
        </form>
        {keys.error && <ErrorBox error={keys.error} onRetry={keys.reload} />}
        {keys.data && keys.data.api_keys.length === 0 && <Empty title="Nenhuma chave criada" />}
        {keys.data && keys.data.api_keys.length > 0 && (
          <div className="mt-4">
            <Table headers={["Chave", "Escopos", "Ambiente", "Último uso", "Requisições 24 h", ""]}>
              {keys.data.api_keys.map((k) => (
                <tr key={k.id}>
                  <Td>
                    <div>{k.name}</div>
                    <div className="font-mono text-xs text-muted">{k.prefix}_…</div>
                  </Td>
                  <Td className="text-xs">{k.scopes.map((s: string) => SCOPE_LABELS[s] ?? s).join(", ")}</Td>
                  <Td>{k.environment === "sandbox" ? <Badge tone="info">sandbox</Badge> : "produção"}</Td>
                  <Td className="tabular text-xs">{k.last_used_at ? dateTime(k.last_used_at, tz) : "nunca"}</Td>
                  <Td className="tabular">{k.requests_24h}</Td>
                  <Td>
                    {k.revoked_at ? (
                      <Badge tone="err">revogada</Badge>
                    ) : (
                      <Button variant="danger" onClick={() => confirm(`Revogar a chave ${k.prefix}? Integrações que a usam deixarão de funcionar.`) && act(() => api(`/v1/api-keys/${k.id}`, { method: "DELETE" }), "Chave revogada")}>
                        Revogar
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          </div>
        )}
      </Card>

      <Card title="Webhooks de saída">
        <p className="mb-3 text-sm text-muted">
          Cada entrega é assinada (<code className="font-mono">X-Tracker-Signature</code>, com timestamp e ID) e repetida com espera crescente em caso de falha. O destino precisa responder 2xx a um teste
          assinado antes de ser ativado. Endereços internos, de metadata ou do próprio sistema são recusados.
        </p>
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            const r = await act(() => api<{ signing_secret: string }>("/v1/webhook-subscriptions", { method: "POST", body: subForm }), "Webhook cadastrado (pausado até o teste)");
            if (r) setSecret({ title: "Copie o segredo de assinatura agora — ele não será exibido novamente", value: r.signing_secret });
            setBusy(false);
          }}
        >
          <Field label="Nome">{(id) => <Input id={id} required value={subForm.name} onChange={(e) => setSubForm({ ...subForm, name: e.target.value })} />}</Field>
          <div className="md:col-span-2">
            <Field label="URL de destino (https)">{(id) => <Input id={id} required type="url" value={subForm.url} onChange={(e) => setSubForm({ ...subForm, url: e.target.value })} />}</Field>
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" checked={subForm.include_test} onChange={(e) => setSubForm({ ...subForm, include_test: e.target.checked })} />
            Incluir vendas de teste
          </label>
          <fieldset className="md:col-span-4">
            <legend className="mb-1 text-sm font-medium">Eventos</legend>
            <div className="flex flex-wrap gap-3">
              {Object.entries(EVENT_LABELS).map(([k, v]) => (
                <label key={k} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={subForm.events.includes(k)} onChange={() => setSubForm({ ...subForm, events: toggle(subForm.events, k) })} />
                  {v}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="md:col-span-4">
            <Button type="submit" busy={busy} disabled={!subForm.events.length}>
              Cadastrar webhook
            </Button>
          </div>
        </form>
        {subs.error && <ErrorBox error={subs.error} onRetry={subs.reload} />}
        {subs.data && subs.data.subscriptions.length === 0 && <Empty title="Nenhum webhook de saída" />}
        <div className="mt-4 space-y-3">
          {subs.data?.subscriptions.map((s) => (
            <div key={s.id} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {s.name}{" "}
                    <Badge tone={s.status === "active" ? "ok" : "warn"}>{s.status === "active" ? "ativo" : "pausado"}</Badge>{" "}
                    {!s.verified_at && <Badge tone="warn">não verificado</Badge>}
                    {Number(s.dead_deliveries) > 0 && <Badge tone="err">{s.dead_deliveries} na fila de falhas</Badge>}
                  </div>
                  <div className="break-all font-mono text-xs text-muted">{s.url}</div>
                  <div className="text-xs text-muted">
                    {s.events.map((e: string) => EVENT_LABELS[e] ?? e).join(", ")} · último sucesso {s.last_success_at ? dateTime(s.last_success_at, tz) : "—"}
                    {s.last_error && ` · último erro: ${s.last_error}`}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const r = await act(() => api<{ ok: boolean; error: string | null }>(`/v1/webhook-subscriptions/${s.id}/test`, { method: "POST" }), "Teste enviado");
                      if (r && !r.ok) toast({ tone: "err", text: `Teste falhou: ${r.error}` });
                    }}
                  >
                    Enviar teste
                  </Button>
                  {s.status === "active" ? (
                    <Button variant="secondary" onClick={() => act(() => api(`/v1/webhook-subscriptions/${s.id}`, { method: "PATCH", body: { status: "paused" } }), "Webhook pausado")}>
                      Pausar
                    </Button>
                  ) : (
                    <Button disabled={!s.verified_at} onClick={() => act(() => api(`/v1/webhook-subscriptions/${s.id}`, { method: "PATCH", body: { status: "active" } }), "Webhook ativado")}>
                      Ativar
                    </Button>
                  )}
                  <Button
                    variant="secondary"
                    onClick={async () => {
                      const r = await act(() => api<{ signing_secret: string }>(`/v1/webhook-subscriptions/${s.id}/rotate-secret`, { method: "POST" }), "Segredo rotacionado");
                      if (r) setSecret({ title: "Novo segredo (o anterior continua válido por 24 h)", value: r.signing_secret });
                    }}
                  >
                    Rotacionar segredo
                  </Button>
                  <Button variant="ghost" onClick={() => setOpenDeliveries(openDeliveries === s.id ? null : s.id)}>
                    {openDeliveries === s.id ? "Ocultar entregas" : "Entregas"}
                  </Button>
                  <Button variant="danger" onClick={() => confirm("Desativar este webhook?") && act(() => api(`/v1/webhook-subscriptions/${s.id}`, { method: "DELETE" }), "Webhook desativado")}>
                    Desativar
                  </Button>
                </div>
              </div>
              {openDeliveries === s.id && (
                <div className="mt-3">
                  <Deliveries subscriptionId={s.id} tz={tz} onResend={(id) => act(() => api(`/v1/webhook-deliveries/${id}/resend`, { method: "POST" }), "Reenvio agendado")} />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
