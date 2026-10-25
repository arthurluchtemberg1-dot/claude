"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { currentPushState, disablePush, enablePush, notifyNotificationsChanged, playSaleSound, pushSupported, unlockAudio, type NotificationItem } from "@/lib/notifications";

/* eslint-disable @typescript-eslint/no-explicit-any */

type Channel = "in_app" | "email" | "push";
const CHANNEL_LABEL: Record<Channel, string> = { in_app: "Painel", email: "E-mail", push: "Push" };
const TONE = { success: "ok", warning: "warn", critical: "err", info: "info" } as const;

interface PrefsResponse {
  preferences: { kinds: Record<string, Partial<Record<Channel, boolean>>>; project_ids: string[]; quiet_start: string | null; quiet_end: string | null; sound_enabled: boolean; sound_volume: number; hide_amounts: boolean };
  timezone: string;
  channels: { in_app: { available: boolean }; email: { available: boolean; reason: string | null }; push: { available: boolean; public_key: string | null; reason: string | null } };
  kinds: { kind: string; label: string; description: string; severity: string; defaults: Record<Channel, boolean>; availability: "active" | "planned"; unavailable_reason: string | null; permitted: boolean }[];
}

function Feed({ tz }: { tz: string }) {
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [pages, setPages] = useState<NotificationItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const first = useApi<{ notifications: NotificationItem[]; unread_count: number }>(`/v1/notifications?limit=30${unreadOnly ? "&unread=true" : ""}`);
  const toast = useToast();
  useEffect(() => {
    setPages([]);
    setCursor(null);
  }, [unreadOnly]);
  if (first.error) return <ErrorBox error={first.error} onRetry={first.reload} />;
  const items = [...(first.data?.notifications ?? []), ...pages];
  const last = items.at(-1);
  const more = async () => {
    if (!last) return;
    const r = await api<{ notifications: NotificationItem[] }>(`/v1/notifications?limit=30&before=${encodeURIComponent(cursor ?? last.created_at)}${unreadOnly ? "&unread=true" : ""}`);
    setPages((p) => [...p, ...r.notifications]);
    setCursor(r.notifications.at(-1)?.created_at ?? cursor);
  };
  return (
    <Card
      title={`Notificações${first.data ? ` (${first.data.unread_count} não lidas)` : ""}`}
      actions={
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} /> Só não lidas
          </label>
          <Button
            variant="secondary"
            onClick={async () => {
              await api("/v1/notifications/read", { method: "POST", body: { all: true } });
              notifyNotificationsChanged();
              toast.toast({ tone: "ok", text: "Todas marcadas como lidas" });
              setPages([]);
              first.reload();
            }}
          >
            Marcar todas como lidas
          </Button>
        </div>
      }
    >
      {toast.toastNode}
      {!first.data ? null : items.length === 0 ? (
        <Empty title="Nenhuma notificação">Vendas aprovadas, estornos e alertas de integração aparecem aqui.</Empty>
      ) : (
        <>
          <ul className="divide-y divide-border" data-testid="notifications-list">
            {items.map((n) => (
              <li key={n.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    {!n.read_at && <span aria-label="não lida" className="inline-block h-2 w-2 rounded-full bg-primary" />}
                    <a className="font-medium hover:underline" href={n.link ?? "#"}>
                      {n.title}
                    </a>
                    {n.is_test && <Badge tone="warn">teste</Badge>}
                  </div>
                  {n.body && <div className="text-sm text-muted">{n.body}</div>}
                </div>
                <div className="text-right">
                  <Badge tone={TONE[n.severity]}>{n.label}</Badge>
                  <div className="text-xs text-muted">{dateTime(n.created_at, tz)}</div>
                </div>
              </li>
            ))}
          </ul>
          {items.length >= 30 && (
            <div className="mt-3 text-center">
              <Button variant="ghost" onClick={() => void more()}>
                Carregar mais
              </Button>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function ThisDevice({ prefs, onChanged }: { prefs: PrefsResponse; onChanged: () => void }) {
  const [state, setState] = useState<string>("…");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const subs = useApi<{ subscriptions: any[] }>("/v1/notifications/push/subscriptions");
  const toast = useToast();
  useEffect(() => {
    void currentPushState().then(setState);
  }, []);
  const push = prefs.channels.push;
  return (
    <Card title="Push neste dispositivo">
      {toast.toastNode}
      {!pushSupported() && <Alert tone="warn">Este navegador não oferece Web Push (ou a página não está em HTTPS). No iPhone, instale o painel na tela inicial primeiro.</Alert>}
      {!push.available && <Alert tone="info" title="Envio de push indisponível no servidor">{push.reason}</Alert>}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-sm">
          Estado:{" "}
          <Badge tone={state === "subscribed" ? "ok" : state === "denied" ? "err" : "neutral"}>
            {state === "subscribed" ? "inscrito" : state === "denied" ? "bloqueado no navegador" : state === "unsupported" ? "sem suporte" : "não inscrito"}
          </Badge>
        </span>
        {state !== "subscribed" ? (
          <Button
            busy={busy}
            disabled={!push.public_key || !pushSupported()}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              const r = await enablePush(push.public_key!);
              setBusy(false);
              if (!r.ok) setMsg(r.reason);
              setState(await currentPushState());
              subs.reload();
              onChanged();
            }}
          >
            Ativar push neste dispositivo
          </Button>
        ) : (
          <Button
            variant="secondary"
            busy={busy}
            onClick={async () => {
              setBusy(true);
              await disablePush();
              setBusy(false);
              setState(await currentPushState());
              subs.reload();
            }}
          >
            Desativar neste dispositivo
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            await api("/v1/notifications/test", { method: "POST", body: {} });
            toast.toast({ tone: "ok", text: "Teste enviado. Ele aparece no sino em alguns segundos e nos canais disponíveis." });
          }}
        >
          Enviar notificação de teste
        </Button>
      </div>
      {msg && <p className="mt-2 text-sm text-err">{msg}</p>}
      <p className="mt-2 text-xs text-muted">O push mostra só título e resumo (valor, produto, projeto) — nunca nome, e-mail ou telefone de comprador. A entrega depende do navegador e do sistema; não é garantida.</p>
      {subs.data && subs.data.subscriptions.length > 0 && (
        <div className="mt-3">
          <Table headers={["Dispositivo", "Criado", "Último envio", "Situação"]}>
            {subs.data.subscriptions.map((s) => (
              <tr key={s.id}>
                <Td>{s.label ?? "—"}</Td>
                <Td className="text-xs">{dateTime(s.created_at, prefs.timezone)}</Td>
                <Td className="text-xs">{s.last_success_at ? dateTime(s.last_success_at, prefs.timezone) : "—"}</Td>
                <Td>
                  {s.disabled_at ? <Badge tone="err">{s.disabled_reason ?? "desativado"}</Badge> : s.last_error ? <Badge tone="warn">{s.last_error}</Badge> : <Badge tone="ok">ativo</Badge>}
                  <Button
                    variant="ghost"
                    className="ml-2 text-xs"
                    onClick={async () => {
                      await api(`/v1/notifications/push/subscriptions/${s.id}`, { method: "DELETE" });
                      subs.reload();
                    }}
                  >
                    Remover
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </Card>
  );
}

function Preferences({ data, reload }: { data: PrefsResponse; reload: () => void }) {
  const [p, setP] = useState(data.preferences);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toast = useToast();
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  useEffect(() => setP(data.preferences), [data.preferences]);
  const value = (kind: string, ch: Channel, def: boolean) => p.kinds[kind]?.[ch] ?? def;
  const set = (kind: string, ch: Channel, v: boolean) => setP((x) => ({ ...x, kinds: { ...x.kinds, [kind]: { ...(x.kinds[kind] ?? {}), [ch]: v } } }));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/v1/notifications/preferences", { method: "PUT", body: { kinds: p.kinds, project_ids: p.project_ids, quiet_start: p.quiet_start || null, quiet_end: p.quiet_end || null, sound_enabled: p.sound_enabled, sound_volume: p.sound_volume, hide_amounts: p.hide_amounts } });
      toast.toast({ tone: "ok", text: "Preferências salvas" });
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha ao salvar");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Preferências" actions={<Button busy={busy} onClick={() => void save()}>Salvar</Button>}>
      {toast.toastNode}
      {err && <Alert tone="err">{err}</Alert>}
      <Table headers={["Tipo", ...(["in_app", "email", "push"] as Channel[]).map((c) => CHANNEL_LABEL[c])]}>
        {data.kinds.map((k) => (
          <tr key={k.kind}>
            <Td>
              <div className="font-medium">
                {k.label} {k.availability === "planned" && <Badge>planejado</Badge>} {!k.permitted && <Badge tone="neutral">não disponível no seu perfil</Badge>}
              </div>
              <div className="text-xs text-muted">{k.unavailable_reason ?? k.description}</div>
            </Td>
            {(["in_app", "email", "push"] as Channel[]).map((ch) => (
              <Td key={ch}>
                <input
                  type="checkbox"
                  aria-label={`${k.label}: ${CHANNEL_LABEL[ch]}`}
                  disabled={!k.permitted || k.availability === "planned"}
                  checked={value(k.kind, ch, k.defaults[ch])}
                  onChange={(e) => set(k.kind, ch, e.target.checked)}
                />
              </Td>
            ))}
          </tr>
        ))}
      </Table>
      {!data.channels.email.available && <p className="mt-2 text-xs text-muted">E-mail: {data.channels.email.reason}</p>}
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <Field label="Horário silencioso (sem e-mail/push; o painel continua registrando)" hint={`Fuso da organização: ${data.timezone}`}>
          {(id) => (
            <div className="flex items-center gap-2">
              <Input id={id} type="time" value={p.quiet_start ?? ""} onChange={(e) => setP({ ...p, quiet_start: e.target.value || null })} aria-label="Início" />
              <span className="text-sm">até</span>
              <Input type="time" value={p.quiet_end ?? ""} onChange={(e) => setP({ ...p, quiet_end: e.target.value || null })} aria-label="Fim" />
            </div>
          )}
        </Field>
        <Field label="Projetos de interesse" hint="Nenhum selecionado = todos os projetos que você acessa">
          {(id) => (
            <Select
              id={id}
              multiple
              value={p.project_ids}
              onChange={(e) => setP({ ...p, project_ids: Array.from(e.target.selectedOptions).map((o) => o.value) })}
              className="h-24"
            >
              {(projects.data?.projects ?? []).map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={p.sound_enabled} onChange={(e) => setP({ ...p, sound_enabled: e.target.checked })} /> Som de venda no painel (só vendas novas, nunca as antigas ao recarregar)
          </label>
          <div className="flex items-center gap-2">
            <label className="text-sm" htmlFor="vol">
              Volume
            </label>
            <input id="vol" type="range" min={0} max={100} value={p.sound_volume} onChange={(e) => setP({ ...p, sound_volume: Number(e.target.value) })} />
            <Button
              variant="ghost"
              onClick={() => {
                unlockAudio();
                setTimeout(() => {
                  if (!playSaleSound(p.sound_volume)) toast.toast({ tone: "err", text: "O navegador bloqueou o áudio; clique novamente." });
                }, 50);
              }}
            >
              Testar som
            </Button>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.hide_amounts} onChange={(e) => setP({ ...p, hide_amounts: e.target.checked })} /> Ocultar valores no push e no e-mail (tela bloqueada)
        </label>
      </div>
    </Card>
  );
}

function AlertSettings() {
  const { can } = useSession();
  const s = useApi<{ alerts: Record<string, number> }>("/v1/notifications/alert-settings");
  const [v, setV] = useState<Record<string, number>>({});
  const toast = useToast();
  useEffect(() => setV(s.data?.alerts ?? {}), [s.data]);
  const fields: [string, string, number][] = [
    ["connection_stale_hours", "Horas sem eventos para alertar integração parada", 24],
    ["connection_failures_per_hour", "Recebimentos com falha por hora para alertar", 3],
    ["queue_delay_minutes", "Minutos de atraso da fila para alertar", 15],
    ["destination_failures_per_hour", "Envios de conversão rejeitados por hora para alertar", 3],
  ];
  return (
    <Card
      title="Alertas da organização"
      actions={
        can("provider.connect") ? (
          <Button
            onClick={async () => {
              await api("/v1/notifications/alert-settings", { method: "PUT", body: Object.fromEntries(fields.map(([k, , d]) => [k, Number(v[k] ?? d)])) });
              toast.toast({ tone: "ok", text: "Limiares salvos" });
              s.reload();
            }}
          >
            Salvar
          </Button>
        ) : undefined
      }
    >
      {toast.toastNode}
      <p className="mb-2 text-sm text-muted">Verificados a cada 5 minutos pelo worker; alertam uma vez ao entrar em problema. Use 0 para desligar.</p>
      <div className="grid gap-3 md:grid-cols-2">
        {fields.map(([k, label, d]) => (
          <Field key={k} label={label}>
            {(id) => <Input id={id} type="number" min={0} disabled={!can("provider.connect")} value={v[k] ?? d} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} />}
          </Field>
        ))}
      </div>
    </Card>
  );
}

export default function NotificationsPage() {
  const { org } = useSession();
  const prefs = useApi<PrefsResponse>("/v1/notifications/preferences");
  return (
    <div className="space-y-4">
      <PageHeader title="Notificações" description="Vendas, estornos e alertas de operação no painel, por e-mail e push — com preferências por tipo e dispositivo." />
      <Feed tz={org.organization.timezone} />
      {prefs.error && <ErrorBox error={prefs.error} onRetry={prefs.reload} />}
      {prefs.data && (
        <>
          <ThisDevice prefs={prefs.data} onChanged={prefs.reload} />
          <Preferences data={prefs.data} reload={prefs.reload} />
        </>
      )}
      <AlertSettings />
    </div>
  );
}
