"use client";

import { useMemo, useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, Empty, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = Record<string, any>;

const STATE_TONE: Record<string, "ok" | "warn" | "err" | "info" | "neutral"> = {
  validated_production: "ok",
  validated_sandbox: "ok",
  implemented_locally: "info",
  blocked_external: "warn",
  researching: "neutral",
  planned: "neutral",
  degraded: "err",
};

const CONN_LABEL: Record<string, string> = {
  disconnected: "Desconectada",
  awaiting_configuration: "Aguardando primeiro evento",
  awaiting_permission: "Aguardando permissão",
  connected: "Conectada",
  token_expired: "Token expirado",
  revoked: "Revogada",
  temporary_failure: "Falha temporária",
  sync_delayed: "Sincronização atrasada",
};

function NewConnection({ projects, onCreated }: { projects: { id: string; name: string }[]; onCreated: () => void }) {
  const [form, setForm] = useState({
    provider: "lowify",
    project_id: projects[0]?.id ?? "",
    name: "Lowify — conta principal",
    account_external_id: "",
    account_display_name: "",
    revenue_role: "producer",
    environment: "production",
    currency: "BRL",
    source_timezone: "America/Sao_Paulo",
    token_carrier: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Any | null>(null);

  if (created) {
    return (
      <div className="space-y-3">
        <Alert tone="warn" title="Copie agora — a URL e o segredo não serão exibidos novamente">
          Guarde em local seguro. Se a URL vazar, crie um novo endpoint e revogue o anterior.
        </Alert>
        <Field label="URL do webhook">
          {(id) => (
            <div className="flex gap-2">
              <Input id={id} readOnly value={created.webhook_url} className="font-mono" />
              <CopyButton value={created.webhook_url} />
            </div>
          )}
        </Field>
        {created.signing_secret && (
          <Field label="Segredo de assinatura (HMAC)">
            {(id) => (
              <div className="flex gap-2">
                <Input id={id} readOnly value={created.signing_secret} className="font-mono" />
                <CopyButton value={created.signing_secret} />
              </div>
            )}
          </Field>
        )}
        {form.provider === "lowify" && (
          <div className="text-sm text-muted">
            <p className="font-medium text-text">Configuração na Lowify (conforme documentação pública v1.0.0):</p>
            <ol className="list-decimal pl-5">
              <li>No painel Lowify: Integrações → Webhooks → cadastrar URL.</li>
              <li>Selecione os eventos Venda pendente, Venda aprovada e Venda reembolsada nos produtos desejados.</li>
              <li>Faça uma venda de teste autorizada. O estado da conexão muda para “Conectada” somente após receber um evento real.</li>
            </ol>
          </div>
        )}
        <Button
          onClick={() => {
            setCreated(null);
            onCreated();
          }}
        >
          Concluir
        </Button>
      </div>
    );
  }

  return (
    <form
      className="grid grid-cols-1 gap-3 md:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const config = form.provider === "lowify" ? { currency: form.currency, source_timezone: form.source_timezone, token_carrier: form.token_carrier || null } : {};
          const r = await api<Any>("/v1/connections", {
            method: "POST",
            body: {
              provider: form.provider,
              project_id: form.project_id,
              name: form.name,
              account_external_id: form.account_external_id,
              account_display_name: form.account_display_name || form.account_external_id,
              revenue_role: form.revenue_role,
              environment: form.environment,
              config,
            },
          });
          setCreated(r);
        } catch (err) {
          setError(err instanceof ApiError ? err.message : "Falha de rede");
        } finally {
          setBusy(false);
        }
      }}
    >
      {error && (
        <div className="md:col-span-2">
          <Alert tone="err" title={error} />
        </div>
      )}
      <Field label="Provedor">
        {(id) => (
          <Select id={id} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value, name: e.target.value === "lowify" ? "Lowify — conta principal" : "Sistema próprio" })}>
            <option value="lowify">Lowify (webhook nativo)</option>
            <option value="custom">Sistema próprio (webhook canônico assinado)</option>
          </Select>
        )}
      </Field>
      <Field label="Projeto">
        {(id) => (
          <Select id={id} value={form.project_id} onChange={(e) => setForm({ ...form, project_id: e.target.value })}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Nome da conexão">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
      <Field label="Identificador da conta no provedor" hint="Ex.: e-mail ou ID do vendedor na Lowify. Reconexões da mesma conta reutilizam o identificador e não duplicam vendas.">
        {(id) => <Input id={id} required value={form.account_external_id} onChange={(e) => setForm({ ...form, account_external_id: e.target.value })} />}
      </Field>
      <Field label="Seu papel nas vendas desta conta" hint="Afiliado/coprodutor: a receita da organização não é o valor pago pelo consumidor.">
        {(id) => (
          <Select id={id} value={form.revenue_role} onChange={(e) => setForm({ ...form, revenue_role: e.target.value })}>
            <option value="producer">Produtor</option>
            <option value="affiliate">Afiliado</option>
            <option value="coproducer">Coprodutor</option>
          </Select>
        )}
      </Field>
      <Field label="Ambiente">
        {(id) => (
          <Select id={id} value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })}>
            <option value="production">Produção</option>
            <option value="test">Teste (vendas marcadas como teste)</option>
          </Select>
        )}
      </Field>
      {form.provider === "lowify" && (
        <>
          <Field label="Moeda dos valores" hint="A Lowify não informa a moeda no webhook; esta é uma hipótese configurada.">
            {(id) => (
              <Select id={id} value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
                <option>BRL</option>
                <option>USD</option>
                <option>EUR</option>
              </Select>
            )}
          </Field>
          <Field label="Fuso do campo timestamp" hint="Não documentado pela Lowify; ajuste se o suporte indicar outro.">
            {(id) => <Input id={id} value={form.source_timezone} onChange={(e) => setForm({ ...form, source_timezone: e.target.value })} />}
          </Field>
          <Field label="Campo que transporta o token do SDK (opcional)" hint="Use somente um campo UTM que você não utiliza. Validar com venda de teste autorizada.">
            {(id) => (
              <Select id={id} value={form.token_carrier} onChange={(e) => setForm({ ...form, token_carrier: e.target.value })}>
                <option value="">Não transportar token (usar apenas UTMs)</option>
                {["utm_term", "utm_content", "utm_medium", "utm_campaign", "utm_source"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </Select>
            )}
          </Field>
        </>
      )}
      <div className="md:col-span-2">
        <Button type="submit" busy={busy}>
          Criar conexão
        </Button>
      </div>
    </form>
  );
}

export default function IntegrationsPage() {
  const { can } = useSession();
  const { toast, toastNode } = useToast();
  const catalog = useApi<{ connectors: Any[] }>("/v1/catalog");
  const conns = useApi<{ connections: Any[] }>("/v1/connections");
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  const [showNew, setShowNew] = useState(false);
  const [groupFilter, setGroupFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);

  const groups = useMemo(() => [...new Set(catalog.data?.connectors.map((c) => c.group) ?? [])], [catalog.data]);
  const filtered = (catalog.data?.connectors ?? []).filter((c) => (!groupFilter || c.group === groupFilter) && (!stateFilter || c.state === stateFilter));

  async function action(fn: () => Promise<unknown>, ok: string) {
    try {
      const r = await fn();
      toast({ tone: "ok", text: ok });
      conns.reload();
      return r;
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
    }
  }

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader
        title="Integrações"
        description="Conexões ativas e catálogo com o estado real de cada conector. Um card no catálogo não significa que a integração funciona."
        actions={can("provider.connect") ? <Button onClick={() => setShowNew((s) => !s)}>{showNew ? "Cancelar" : "Nova conexão"}</Button> : null}
      />
      {showNew && projects.data && (
        <Card title="Nova conexão de checkout">
          <NewConnection
            projects={projects.data.projects}
            onCreated={() => {
              setShowNew(false);
              conns.reload();
            }}
          />
        </Card>
      )}
      <Card title="Conexões">
        <ErrorBox error={conns.error} onRetry={conns.reload} />
        {conns.loading && !conns.data ? (
          <Skeleton className="h-24" />
        ) : !conns.data?.connections.length ? (
          <Empty title="Nenhuma conexão">Crie uma conexão para receber vendas confirmadas.</Empty>
        ) : (
          <Table headers={["Conexão", "Estado", "Recebimentos", "Endpoints", "Ações"]}>
            {conns.data.connections.map((c) => (
              <tr key={c.id}>
                <Td>
                  <div className="font-medium">{c.name}</div>
                  <div className="text-xs text-muted">
                    {c.provider} · conta {c.external_account_id ?? "—"} · {c.revenue_role ?? "—"} · {c.environment === "test" ? "teste" : "produção"}
                  </div>
                </Td>
                <Td>
                  <Badge tone={c.status === "connected" ? "ok" : c.status === "awaiting_configuration" ? "warn" : "err"}>{CONN_LABEL[c.status] ?? c.status}</Badge>
                  <div className="text-xs text-muted">Último evento: {dateTime(c.last_receipt_at)}</div>
                </Td>
                <Td className="tabular">{c.receipts}</Td>
                <Td className="text-xs">
                  {(c.endpoints ?? []).map((e: Any) => (
                    <div key={e.id} className="flex items-center gap-2">
                      <span className="font-mono">…{e.hint}</span>
                      <Badge tone={e.status === "active" ? "ok" : "neutral"}>{e.status === "active" ? "ativo" : "revogado"}</Badge>
                      {e.status === "active" && can("provider.connect") && (
                        <button className="text-err underline" onClick={() => action(() => api(`/v1/connections/${c.id}/endpoints/${e.id}`, { method: "DELETE" }), "Endpoint revogado")}>
                          revogar
                        </button>
                      )}
                    </div>
                  ))}
                </Td>
                <Td>
                  {can("provider.connect") && c.status !== "revoked" && (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        onClick={async () => {
                          const r = (await action(() => api<Any>(`/v1/connections/${c.id}/endpoints`, { method: "POST", body: {} }), "Novo endpoint criado")) as Any | undefined;
                          if (r?.webhook_url) window.prompt("Nova URL (copie agora; não será exibida novamente):", r.webhook_url);
                        }}
                      >
                        Novo endpoint
                      </Button>
                      <Button
                        variant="danger"
                        onClick={() => {
                          if (window.confirm("Revogar a conexão? Endpoints e credenciais serão revogados; vendas e evidências são preservadas.")) void action(() => api(`/v1/connections/${c.id}`, { method: "DELETE" }), "Conexão revogada");
                        }}
                      >
                        Revogar
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card
        title={`Catálogo (${catalog.data?.connectors.length ?? "…"} integrações)`}
        actions={
          <div className="flex gap-2">
            <Select aria-label="Grupo" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} className="w-auto">
              <option value="">Todos os grupos</option>
              {groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </Select>
            <Select aria-label="Estado" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} className="w-auto">
              <option value="">Todos os estados</option>
              <option value="implemented_locally">Implementado localmente</option>
              <option value="blocked_external">Bloqueado externamente</option>
              <option value="researching">Em pesquisa</option>
              <option value="planned">Planejado</option>
            </Select>
          </div>
        }
      >
        {catalog.loading && !catalog.data ? (
          <Skeleton className="h-24" />
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((c) => (
              <li key={c.id} className="py-2">
                <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left" onClick={() => setOpenId(openId === c.id ? null : c.id)} aria-expanded={openId === c.id}>
                  <span>
                    <span className="font-medium">{c.display_name}</span> <span className="text-xs text-muted">· {c.group}</span>
                  </span>
                  <Badge tone={STATE_TONE[c.state]}>{c.state_label}</Badge>
                </button>
                {openId === c.id && (
                  <div className="mt-2 space-y-2 rounded-md bg-surface-2 p-3 text-sm">
                    <p>{c.state_note}</p>
                    <dl className="grid grid-cols-1 gap-1 md:grid-cols-2">
                      <div><dt className="text-xs text-muted">Autenticação</dt><dd>{c.authentication}</dd></div>
                      <div><dt className="text-xs text-muted">Versão</dt><dd>{c.api_version ?? "—"}</dd></div>
                      <div><dt className="text-xs text-muted">Dinheiro</dt><dd>{c.money_field}</dd></div>
                      <div><dt className="text-xs text-muted">Fuso</dt><dd>{c.timezone}</dd></div>
                      <div><dt className="text-xs text-muted">UTMs/token</dt><dd>{c.utm_transport}</dd></div>
                      <div><dt className="text-xs text-muted">Limites</dt><dd>{c.limits}</dd></div>
                    </dl>
                    {Object.keys(c.capabilities).length > 0 && (
                      <div>
                        <p className="text-xs text-muted">Capacidades</p>
                        <ul className="grid grid-cols-1 gap-1 md:grid-cols-2">
                          {Object.entries(c.capabilities).map(([k, v]: [string, any]) => (
                            <li key={k} className="text-xs">
                              <Badge tone={v.status === "supported" ? "ok" : v.status === "not_supported" ? "err" : "neutral"}>{v.status}</Badge> {k} — {v.note}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.limitations.length > 0 && (
                      <ul className="list-disc pl-5 text-xs text-muted">
                        {c.limitations.map((l: string) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    )}
                    {c.docs.length > 0 && (
                      <ul className="text-xs">
                        {c.docs.map((d: Any) => (
                          <li key={d.url}>
                            {d.title} — consultado em {d.consultedAt ?? "—"} {d.version && `(versão ${d.version})`} {!d.accessible && <Badge tone="warn">inacessível neste ambiente</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
