"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, ErrorBox, Field, Input, MfaHint, PageHeader, Select, Skeleton, Switch, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime, money } from "@/lib/format";

/**
 * Conexão com a Meta: token de usuário do sistema do Business Manager (colado aqui, guardado cifrado, nunca exibido),
 * contas sincronizadas, pixels e páginas, e a trava de ações de gestão (só o proprietário libera).
 */

interface MetaState {
  connection: { id: string; name: string; status: string; permissions: string[]; meta_user: { id: string; name: string | null } | null; last_success_at: string | null; last_error: string | null; last_error_at: string | null } | null;
  accounts: {
    id: string;
    external_account_id: string;
    name: string | null;
    currency: string;
    timezone: string | null;
    account_status: number | null;
    amount_spent_minor: string | null;
    spend_cap_minor: string | null;
    business_name: string | null;
    sync_enabled: boolean;
    project_id: string | null;
    last_synced_at: string | null;
    synced_from: string | null;
    synced_to: string | null;
    last_sync_error: string | null;
  }[];
  pixels: { external_id: string; name: string | null; details: { last_fired_time?: string | null } | null }[];
  pages: { external_id: string; name: string | null }[];
  writes: { enabled: boolean; reasons: string[]; setting_on: boolean; can_toggle: boolean };
  graph_version: string;
}

const ACCOUNT_STATUS: Record<number, { label: string; tone: "ok" | "warn" | "err" | "neutral" }> = {
  1: { label: "Ativa", tone: "ok" },
  2: { label: "Desativada", tone: "err" },
  3: { label: "Pagamento pendente", tone: "err" },
  7: { label: "Em análise de risco", tone: "warn" },
  8: { label: "Liquidação pendente", tone: "warn" },
  9: { label: "Período de carência", tone: "warn" },
  100: { label: "Encerramento pendente", tone: "warn" },
  101: { label: "Encerrada", tone: "neutral" },
};

const UTM_TEMPLATE = "utm_source=facebook&utm_medium=paid_social&utm_campaign={{campaign.name}}|{{campaign.id}}&utm_term={{adset.name}}|{{adset.id}}&utm_content={{ad.name}}|{{ad.id}}";

export default function MetaPage() {
  const { can, org } = useSession();
  const { data, error, loading, reload } = useApi<MetaState>("/v1/meta");
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  const [token, setToken] = useState("");
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formCode, setFormCode] = useState<string | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; error?: string; permissions?: string[] } | null>(null);
  const { toast, toastNode } = useToast();
  const tz = org.organization.timezone;
  const conn = data?.connection;
  const needsToken = !conn || conn.status !== "connected";

  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast({ tone: "ok", text: ok });
      await reload();
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
    } finally {
      setBusy(null);
    }
  };

  const connect = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setBusy("connect");
    try {
      const r = await api<{ accounts: unknown[] }>("/v1/meta/connect", { method: "POST", body: { access_token: token.trim(), ...(projectId ? { project_id: projectId } : {}) } });
      setToken("");
      toast({ tone: "ok", text: `Conectado: ${r.accounts.length} conta(s) encontrada(s). A primeira sincronização (30 dias) começou.` });
      await reload();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Falha ao conectar");
      setFormCode(err instanceof ApiError ? err.code : null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Meta Ads"
        description="Conecte suas contas de anúncios do Facebook e Instagram para trazer campanhas, gasto e compras reportadas, e controlar anúncios pelo painel."
        actions={
          <Link href="/integracoes" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2">
            Todas as integrações
          </Link>
        }
      />
      {error && <ErrorBox error={error} onRetry={reload} />}
      {loading && !data && <Skeleton className="h-40" />}

      {data && conn && (
        <Card
          title="Conexão"
          actions={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                busy={busy === "check"}
                onClick={async () => {
                  setBusy("check");
                  try {
                    setCheck(await api("/v1/meta/check", { method: "POST", body: {} }));
                  } catch (e) {
                    setCheck({ ok: false, error: e instanceof ApiError ? e.message : "Falha" });
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Testar conexão
              </Button>
              <Button variant="secondary" busy={busy === "sync"} onClick={() => void run("sync", () => api("/v1/meta/sync", { method: "POST", body: {} }), "Sincronização na fila")}>
                Sincronizar agora
              </Button>
              {can("provider.connect") && (
                <Button
                  variant="danger"
                  busy={busy === "disconnect"}
                  onClick={() => window.confirm("Desconectar a Meta? O token é apagado e a sincronização para; o histórico de gasto é mantido.") && void run("disconnect", () => api("/v1/meta", { method: "DELETE" }), "Meta desconectada")}
                >
                  Desconectar
                </Button>
              )}
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={conn.status === "connected" ? "ok" : "err"}>{conn.status === "connected" ? "Conectada" : conn.status === "token_expired" ? "Token inválido ou expirado" : conn.status}</Badge>
            {conn.meta_user && <span>Usuário: {conn.meta_user.name ?? conn.meta_user.id}</span>}
            <span className="text-muted">Graph API {data.graph_version}</span>
            {conn.last_success_at && <span className="text-muted">Última sincronização: {dateTime(conn.last_success_at, tz)}</span>}
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {conn.permissions.map((p) => (
              <Badge key={p} tone={p === "ads_management" || p === "ads_read" ? "info" : "neutral"}>
                {p}
              </Badge>
            ))}
          </div>
          {conn.last_error && conn.status !== "connected" && (
            <div className="mt-3">
              <Alert tone="err" title="A Meta recusou o acesso">
                {conn.last_error} — gere um novo token (passo 4 abaixo) e cole para reconectar. Contas e histórico são mantidos.
              </Alert>
            </div>
          )}
          {check && (
            <div className="mt-3">
              <Alert tone={check.ok ? "ok" : "err"} title={check.ok ? "Token válido" : "Falha no teste"}>
                {check.ok ? `Permissões: ${(check.permissions ?? []).join(", ")}` : check.error}
              </Alert>
            </div>
          )}
        </Card>
      )}

      {data && needsToken && can("provider.connect") && (
        <Card title={conn ? "Reconectar com um novo token" : "Conectar em 5 passos"}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              Abra o <strong>Business Manager</strong> (business.facebook.com) → <strong>Configurações do negócio</strong>.
            </li>
            <li>
              Se ainda não houver, crie um app do tipo <strong>Empresa</strong> em developers.facebook.com → Meus apps, e vincule-o ao seu negócio (o token é gerado por meio de um app).
            </li>
            <li>
              Em <strong>Usuários → Usuários do sistema</strong>, adicione um usuário (ex.: “Tracker”) e use <strong>Atribuir ativos</strong> para dar acesso às contas de anúncios — com controle total se quiser pausar e ajustar orçamento por aqui. Pixels e páginas são opcionais.
            </li>
            <li>
              Clique em <strong>Gerar novo token</strong>, escolha o app e marque as permissões <code>ads_read</code> e <code>ads_management</code> (e <code>business_management</code> se as contas forem do negócio). Prefira validade sem expiração quando disponível.
            </li>
            <li>Copie o token e cole abaixo. Ele é validado na hora junto à Meta, guardado cifrado e nunca mais exibido.</li>
          </ol>
          <p className="mt-2 text-xs text-muted">Os nomes dos menus podem variar conforme a versão do Business Manager. Nunca envie o token por mensagem ou e-mail.</p>
          <form className="mt-4 space-y-3" onSubmit={connect} autoComplete="off">
            <Field label="Token de acesso" error={formError}>
              {(id) => <Input id={id} type="password" autoComplete="off" spellCheck={false} placeholder="EAA…" value={token} onChange={(e) => setToken(e.target.value)} required minLength={20} />}
            </Field>
            {(projects.data?.projects.length ?? 0) > 1 && (
              <Field label="Projeto das contas" hint="Em qual projeto o gasto destas contas entra">
                {(id) => (
                  <Select id={id} value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                    <option value="">Primeiro projeto</option>
                    {projects.data!.projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <MfaHint code={formCode} />
            <Button type="submit" busy={busy === "connect"} disabled={token.trim().length < 20}>
              {conn ? "Reconectar" : "Conectar Meta"}
            </Button>
          </form>
        </Card>
      )}
      {data && needsToken && !can("provider.connect") && <Alert tone="info" title="Peça ao proprietário ou administrador para conectar a Meta" />}

      {data && conn && (
        <Card title={`Contas de anúncios (${data.accounts.length})`}>
          {data.accounts.length === 0 ? (
            <p className="text-sm text-muted">Nenhuma conta acessível com este token. No Business Manager, atribua as contas ao usuário do sistema e reconecte.</p>
          ) : (
            <ul className="divide-y divide-border">
              {data.accounts.map((a) => {
                const st = a.account_status !== null ? ACCOUNT_STATUS[a.account_status] : null;
                const capLeft = a.spend_cap_minor && a.amount_spent_minor ? BigInt(a.spend_cap_minor) - BigInt(a.amount_spent_minor) : null;
                return (
                  <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="font-medium">
                        {a.name ?? a.external_account_id} {st && <Badge tone={st.tone}>{st.label}</Badge>}
                      </p>
                      <p className="font-mono text-xs text-muted">
                        {a.external_account_id} · {a.currency.trim()} · {a.timezone ?? "fuso desconhecido"}
                        {a.business_name ? ` · ${a.business_name}` : ""}
                      </p>
                      <p className="text-xs text-muted">
                        {a.last_synced_at ? `Sincronizada ${dateTime(a.last_synced_at, tz)} (${a.synced_from ?? "?"} a ${a.synced_to ?? "?"})` : a.sync_enabled ? "Aguardando primeira sincronização" : "Sincronização desligada"}
                        {capLeft !== null && ` · Limite de gasto: resta ${money(capLeft.toString(), a.currency)} de ${money(a.spend_cap_minor, a.currency)}`}
                      </p>
                      {a.last_sync_error && <p className="text-xs text-err">{a.last_sync_error}</p>}
                    </div>
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted">Sincronizar</span>
                      <Switch
                        label={`Sincronizar ${a.name ?? a.external_account_id}`}
                        checked={a.sync_enabled}
                        disabled={!can("provider.connect")}
                        busy={busy === `acc:${a.id}`}
                        onChange={(on) => void run(`acc:${a.id}`, () => api(`/v1/meta/accounts/${a.id}`, { method: "PUT", body: { sync_enabled: on } }), on ? "Conta incluída; sincronizando" : "Conta pausada na sincronização")}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      )}

      {data && conn && (
        <Card title="Ações de gestão pelo painel">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm text-muted">
              Permite pausar, ativar, ajustar orçamento diário, renomear e duplicar campanhas, conjuntos e anúncios pela tela de Campanhas e pelas regras de automação. Cada alteração fica registrada com quem fez, valor anterior e confirmação da Meta.
            </p>
            {data.writes.can_toggle ? (
              <div className="flex items-center gap-2 text-sm">
                <span>{data.writes.setting_on ? "Ligado" : "Desligado"}</span>
                <Switch
                  label="Permitir ações de gestão"
                  checked={data.writes.setting_on}
                  busy={busy === "writes"}
                  onChange={(on) =>
                    (!on || window.confirm("Liberar ações reais na Meta? Pessoas com permissão de gestão e regras ativas poderão pausar e alterar orçamento.")) &&
                    void run("writes", () => api("/v1/meta/settings", { method: "PUT", body: { media_writes: on } }), on ? "Ações liberadas" : "Ações desligadas")
                  }
                />
              </div>
            ) : (
              <Badge tone={data.writes.enabled ? "ok" : "neutral"}>{data.writes.enabled ? "Liberadas" : "Desligadas"}</Badge>
            )}
          </div>
          {!data.writes.enabled && data.writes.reasons.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs text-muted">
              {data.writes.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {data && conn && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card title={`Pixels (${data.pixels.length})`}>
            {data.pixels.length ? (
              <ul className="space-y-1 text-sm">
                {data.pixels.map((p) => (
                  <li key={p.external_id}>
                    {p.name ?? "Pixel"} <span className="font-mono text-xs text-muted">{p.external_id}</span>
                    {p.details?.last_fired_time && <span className="text-xs text-muted"> · último disparo {dateTime(p.details.last_fired_time, tz)}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nenhum pixel visível para este token.</p>
            )}
            <p className="mt-2 text-xs text-muted">
              Para enviar vendas confirmadas à Meta (API de Conversões), configure em <Link className="underline" href="/pixels">Pixels e conversões</Link>.
            </p>
          </Card>
          <Card title={`Páginas (${data.pages.length})`}>
            {data.pages.length ? (
              <ul className="space-y-1 text-sm">
                {data.pages.map((p) => (
                  <li key={p.external_id}>
                    {p.name ?? "Página"} <span className="font-mono text-xs text-muted">{p.external_id}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">Nenhuma página promovível visível para este token.</p>
            )}
          </Card>
        </div>
      )}

      <Card title="Parâmetros de URL dos anúncios">
        <p className="text-sm text-muted">
          Cole no campo <strong>Parâmetros de URL</strong> de cada anúncio (ou no nível da campanha). Assim cada venda chega com o ID da campanha, do conjunto e do anúncio, e o painel junta venda e gasto pelo ID — renomear não quebra nada.
        </p>
        <div className="mt-2 flex gap-2">
          <Input readOnly value={UTM_TEMPLATE} className="font-mono text-xs" aria-label="Parâmetros de URL" />
          <CopyButton value={UTM_TEMPLATE} />
        </div>
        <p className="mt-1 text-xs text-muted">
          As macros entre chaves são substituídas pela Meta na hora do clique. Mais opções em <Link className="underline" href="/origem">Origem e UTMs</Link>.
        </p>
      </Card>
      {toastNode}
    </div>
  );
}
