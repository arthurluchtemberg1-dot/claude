"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, Field, Input, PageHeader, Select, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROLE_LABEL: Record<string, string> = { owner: "Proprietário", admin: "Administrador", manager: "Gestor", analyst: "Analista", finance: "Financeiro", viewer: "Cliente/leitor" };

export default function SettingsPage() {
  const { org, me, can, reloadOrg } = useSession();
  const { toast, toastNode } = useToast();
  const tz = org.organization.timezone;
  const projects = useApi<{ projects: any[] }>("/v1/projects");
  const members = useApi<{ members: any[] }>(can("members.manage") ? "/v1/members" : null);
  const invites = useApi<{ invites: any[] }>(can("members.manage") ? "/v1/invites" : null);
  const sessions = useApi<{ sessions: any[] }>("/v1/auth/sessions");
  const audit = useApi<{ entries: any[] }>(can("members.manage") ? "/v1/audit-logs?limit=30" : null);
  const [orgForm, setOrgForm] = useState({ name: org.organization.name, timezone: org.organization.timezone, mfa_required: org.organization.mfa_required, internal_mode: org.organization.internal_mode });
  const [invite, setInvite] = useState({ email: "", role: "analyst" });
  const [mfa, setMfa] = useState<{ secret: string; otpauth_url: string } | null>(null);
  const [code, setCode] = useState("");
  const [newProject, setNewProject] = useState("");

  async function act(fn: () => Promise<unknown>, ok: string, after?: () => void) {
    try {
      await fn();
      toast({ tone: "ok", text: ok });
      after?.();
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
    }
  }

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader title="Configurações" description={`Seu perfil nesta organização: ${ROLE_LABEL[org.membership.role] ?? org.membership.role}.`} />
      <Card title="Organização">
        <form
          className="grid grid-cols-1 gap-3 md:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api("/v1/org", { method: "PATCH", body: orgForm }), "Organização atualizada", reloadOrg);
          }}
        >
          <Field label="Nome">{(id) => <Input id={id} value={orgForm.name} disabled={!can("org.manage")} onChange={(e) => setOrgForm({ ...orgForm, name: e.target.value })} />}</Field>
          <Field label="Fuso">{(id) => <Input id={id} value={orgForm.timezone} disabled={!can("org.manage")} onChange={(e) => setOrgForm({ ...orgForm, timezone: e.target.value })} />}</Field>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" disabled={!can("org.manage")} checked={orgForm.mfa_required} onChange={(e) => setOrgForm({ ...orgForm, mfa_required: e.target.checked })} /> Exigir MFA para perfis sensíveis
          </label>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input type="checkbox" disabled={!can("org.manage")} checked={orgForm.internal_mode} onChange={(e) => setOrgForm({ ...orgForm, internal_mode: e.target.checked })} /> Uso interno (sem cobrança)
          </label>
          {can("org.manage") && (
            <div className="md:col-span-4">
              <Button type="submit">Salvar</Button>
            </div>
          )}
        </form>
      </Card>

      <Card title="Projetos e chaves públicas do SDK">
        <Table headers={["Projeto", "Chave pública", "Origens permitidas"]}>
          {projects.data?.projects.map((p) => (
            <tr key={p.id}>
              <Td>{p.name}</Td>
              <Td>
                <span className="font-mono text-xs">{p.public_key}</span> <CopyButton value={p.public_key} />
              </Td>
              <Td className="text-xs">{p.allowed_origins.length ? p.allowed_origins.join(", ") : "qualquer origem (recomenda-se restringir)"}</Td>
            </tr>
          ))}
        </Table>
        {can("org.manage") && (
          <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => api("/v1/projects", { method: "POST", body: { name: newProject } }), "Projeto criado", () => { setNewProject(""); projects.reload(); }); }}>
            <Input aria-label="Nome do projeto" placeholder="Novo projeto" required value={newProject} onChange={(e) => setNewProject(e.target.value)} />
            <Button type="submit">Criar</Button>
          </form>
        )}
      </Card>

      {can("members.manage") && (
        <Card title="Membros e convites">
          <Table headers={["Membro", "Perfil", "Status", ""]}>
            {members.data?.members.map((m) => (
              <tr key={m.id}>
                <Td>
                  {m.display_name} <span className="text-xs text-muted">{m.email}</span>
                </Td>
                <Td>
                  <Select aria-label="Perfil" value={m.role} onChange={(e) => act(() => api(`/v1/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }), "Perfil alterado", members.reload)} className="w-auto">
                    {Object.entries(ROLE_LABEL).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                </Td>
                <Td>
                  <Badge tone={m.status === "active" ? "ok" : "warn"}>{m.status}</Badge>
                </Td>
                <Td>
                  {m.user_id !== me.user.id && (
                    <Button variant="danger" onClick={() => act(() => api(`/v1/members/${m.id}`, { method: "PATCH", body: { status: "removed" } }), "Membro removido (acesso revogado imediatamente)", members.reload)}>
                      Remover
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
          <form className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void act(() => api("/v1/invites", { method: "POST", body: invite }), "Convite enviado (uso único, expira em 7 dias)", () => { setInvite({ ...invite, email: "" }); invites.reload(); }); }}>
            <Input aria-label="E-mail" type="email" placeholder="e-mail do convidado" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} className="md:col-span-2" />
            <Select aria-label="Perfil" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              {["admin", "manager", "analyst", "finance", "viewer"].map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
            <Button type="submit">Convidar</Button>
          </form>
          {invites.data && invites.data.invites.length > 0 && (
            <ul className="mt-3 space-y-1 text-sm">
              {invites.data.invites.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  {i.email} · {ROLE_LABEL[i.role]} · {i.accepted_at ? <Badge tone="ok">aceito</Badge> : i.revoked_at ? <Badge>revogado</Badge> : <Badge tone="warn">pendente até {dateTime(i.expires_at, tz)}</Badge>}
                  {!i.accepted_at && !i.revoked_at && (
                    <Button variant="ghost" onClick={() => act(() => api(`/v1/invites/${i.id}`, { method: "DELETE" }), "Convite revogado", invites.reload)}>
                      revogar
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card title="Segurança da conta">
        {me.user.mfa_enabled ? (
          <Alert tone="ok" title="Autenticação multifator ativa" />
        ) : mfa ? (
          <div className="space-y-2 text-sm">
            <p>Adicione no aplicativo autenticador (URI otpauth) ou digite o segredo manualmente:</p>
            <div className="flex flex-wrap gap-2">
              <Input readOnly value={mfa.secret} className="max-w-xs font-mono" aria-label="Segredo" />
              <CopyButton value={mfa.otpauth_url} label="Copiar URI otpauth" />
            </div>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void act(() => api("/v1/auth/mfa/confirm", { method: "POST", body: { code } }), "MFA ativado", () => window.location.reload()); }}>
              <Input aria-label="Código" inputMode="numeric" maxLength={6} placeholder="Código de 6 dígitos" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} className="max-w-[12rem]" />
              <Button type="submit">Confirmar</Button>
            </form>
          </div>
        ) : (
          <Button onClick={async () => { try { setMfa(await api("/v1/auth/mfa/setup", { method: "POST", body: {} })); } catch (e) { toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" }); } }}>
            Ativar MFA (TOTP)
          </Button>
        )}
        {!me.user.email_verified && (
          <div className="mt-3">
            <Button variant="secondary" onClick={() => act(() => api("/v1/auth/resend-verification", { method: "POST", body: {} }), "Link de verificação reenviado")}>
              Reenviar verificação de e-mail
            </Button>
          </div>
        )}
        <h3 className="mb-2 mt-4 text-sm font-semibold">Sessões ativas</h3>
        <ul className="space-y-1 text-sm">
          {sessions.data?.sessions.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{s.user_agent ?? "—"}</span> · último uso {dateTime(s.last_seen_at, tz)} {s.current && <Badge tone="info">esta sessão</Badge>}
              {!s.current && (
                <Button variant="ghost" onClick={() => act(() => api(`/v1/auth/sessions/${s.id}`, { method: "DELETE" }), "Sessão encerrada", sessions.reload)}>
                  encerrar
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Button variant="danger" className="mt-2" onClick={() => act(() => api("/v1/auth/logout", { method: "POST", body: { all: true } }), "Todas as sessões encerradas", () => (window.location.href = "/entrar"))}>
          Encerrar todas as sessões
        </Button>
      </Card>

      {audit.data && (
        <Card title="Auditoria (recente)">
          <Table headers={["Quando", "Ação", "Alvo", "Ator"]}>
            {audit.data.entries.map((a) => (
              <tr key={a.id}>
                <Td className="tabular text-xs">{dateTime(a.created_at, tz)}</Td>
                <Td className="font-mono text-xs">{a.action}</Td>
                <Td className="text-xs">{a.target_type ?? "—"}</Td>
                <Td className="text-xs">{a.actor_type}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}
