"use client";

import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Table, Td, Textarea, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const EXAMPLES = [
  "Quais campanhas tiveram contribuição negativa nesta semana?",
  "Por que o ROAS mudou em relação à semana passada? Separe observações de hipóteses.",
  "Quais vendas ficaram sem origem e o que posso verificar?",
  "Compare os anúncios dos últimos 7 dias mostrando a amostra de vendas.",
  "Sugira uma regra para campanhas que gastarem R$ 150 sem vender, sem ativá-la.",
];
const TOOL_LABEL: Record<string, string> = {
  get_metrics_summary: "Resumo de métricas",
  compare_periods: "Comparação de períodos",
  get_breakdown: "Detalhamento por campanha/anúncio",
  list_unattributed_orders: "Vendas sem origem",
  get_data_quality: "Qualidade dos dados",
  suggest_rule: "Simulação de regra",
};

/** Negrito com **texto** e quebras de linha, sem HTML vindo do modelo (texto sempre escapado pelo React). */
function RichText({ text }: { text: string }) {
  return (
    <div className="space-y-1 text-sm">
      {text.split("\n").map((line, i) => {
        const parts = line.split(/(\*\*[^*]+\*\*)/g).map((p, j): ReactNode => (p.startsWith("**") && p.endsWith("**") ? <strong key={j}>{p.slice(2, -2)}</strong> : <Fragment key={j}>{p}</Fragment>));
        return line.trim() === "" ? <div key={i} className="h-2" /> : <p key={i} className={line.trimStart().startsWith("- ") ? "pl-3" : undefined}>{parts}</p>;
      })}
    </div>
  );
}

function Settings({ status, reload }: { status: any; reload: () => void }) {
  const [key, setKey] = useState("");
  const [model, setModel] = useState(status.model ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toast = useToast();
  const save = async (enabled: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      await api("/v1/ai/settings", { method: "PUT", body: { enabled, provider: "anthropic", model: model.trim() || null } });
      if (key.trim()) {
        await api("/v1/ai/key", { method: "PUT", body: { api_key: key.trim() } });
        setKey("");
      }
      toast.toast({ tone: "ok", text: enabled ? "Gestor IA ligado" : "Gestor IA desligado" });
      reload();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : "Falha");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Configuração da IA (proprietário)">
      {toast.toastNode}
      {msg && <Alert tone="err">{msg}</Alert>}
      <p className="mb-2 text-sm text-muted">{status.privacy}</p>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Provedor">
          {(id) => (
            <select id={id} className="w-full rounded-md border border-border bg-surface px-3 py-2 text-sm" value="anthropic" disabled>
              {status.providers.map((p: any) => (
                <option key={p.id} value={p.id} disabled={p.availability !== "active"}>
                  {p.label}
                  {p.availability !== "active" ? " (planejado)" : ""}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field label="Modelo" hint="Vazio = padrão do servidor (AI_MODEL)">{(id) => <Input id={id} value={model} onChange={(e) => setModel(e.target.value)} />}</Field>
        <Field label={status.has_org_key ? "Chave própria (cadastrada — informe outra para trocar)" : "Chave própria (opcional)"} hint="Guardada cifrada; nunca é exibida de novo">
          {(id) => <Input id={id} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />}
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button busy={busy} onClick={() => void save(true)}>
          {status.enabled ? "Salvar" : "Ligar Gestor IA"}
        </Button>
        {status.enabled && (
          <Button variant="secondary" busy={busy} onClick={() => void save(false)}>
            Desligar
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={async () => {
            const r = await api<any>("/v1/ai/test", { method: "POST", body: {} });
            toast.toast(r.ok ? { tone: "ok", text: `Conexão ok: ${r.displayName ?? r.model}` } : { tone: "err", text: r.error });
          }}
        >
          Testar chave e modelo
        </Button>
        {status.has_org_key && (
          <Button
            variant="ghost"
            onClick={async () => {
              await api("/v1/ai/key", { method: "DELETE" });
              reload();
            }}
          >
            Remover chave própria
          </Button>
        )}
      </div>
    </Card>
  );
}

function Conversation({ id, onChanged }: { id: string; onChanged: () => void }) {
  const router = useRouter();
  const { org } = useSession();
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await api<any>(`/v1/ai/conversations/${id}`);
      setData(d);
      setError(null);
      if (d.conversation.status === "running") timer.current = setTimeout(() => void load(), 2000);
      else onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  }, [id, onChanged]);
  useEffect(() => {
    void load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);
  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return null;
  const running = data.conversation.status === "running";
  return (
    <Card title={data.conversation.title} actions={running ? <Button variant="ghost" onClick={() => void api(`/v1/ai/conversations/${id}/cancel`, { method: "POST", body: {} })}>Cancelar</Button> : undefined}>
      <ul className="space-y-3" data-testid="ai-messages">
        {data.messages.map((m: any) => (
          <li key={m.id} className={m.role === "user" ? "rounded-md bg-surface-2 p-3" : "rounded-md border border-border p-3"}>
            <div className="mb-1 flex items-center justify-between gap-2 text-xs text-muted">
              <span>{m.role === "user" ? "Você" : `Gestor IA${m.model ? ` · ${m.model}` : ""}`}</span>
              <span>{dateTime(m.created_at, org.organization.timezone)}</span>
            </div>
            {m.role === "user" ? <p className="text-sm">{m.content}</p> : <RichText text={m.content} />}
            {m.status === "pending" || m.status === "running" ? <p className="mt-1 text-xs text-muted">Analisando com as ferramentas de métricas…</p> : null}
            {["failed", "refused", "canceled"].includes(m.status) && <Alert tone={m.status === "canceled" ? "info" : "warn"}>{m.error}</Alert>}
            {m.role === "assistant" && m.sources?.length > 0 && (
              <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-muted">Fontes consultadas ({m.sources.length})</summary>
                <ul className="mt-1 space-y-1">
                  {m.sources.map((s: any, i: number) => (
                    <li key={i}>
                      {TOOL_LABEL[s.tool] ?? s.tool} {s.ok ? "" : "(falhou)"} <code className="text-muted">{JSON.stringify(s.input)}</code>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {m.attachments?.context_reset && <p className="mt-1 text-xs text-muted">Provedor ou modelo mudou: esta resposta não usou o contexto anterior.</p>}
            {(m.attachments?.rule_drafts ?? []).map((d: any, i: number) => (
              <div key={i} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={d.valid ? "info" : "warn"}>Regra sugerida: {d.name}</Badge>
                <Button
                  variant="secondary"
                  onClick={() => {
                    try {
                      sessionStorage.setItem("trk_rule_draft", JSON.stringify(d));
                    } catch {
                      /* ignorar */
                    }
                    router.push("/automacao?rascunho=1");
                  }}
                >
                  Abrir no construtor (não ativa)
                </Button>
              </div>
            ))}
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!q.trim()) return;
          setBusy(true);
          try {
            await api(`/v1/ai/conversations/${id}/messages`, { method: "POST", body: { question: q.trim() } });
            setQ("");
            void load();
          } catch (err) {
            setError(err instanceof ApiError ? err : null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Textarea aria-label="Continuar a conversa" rows={2} value={q} onChange={(e) => setQ(e.target.value)} disabled={running} placeholder="Pergunte algo sobre esta análise" />
        <div>
          <Button type="submit" busy={busy} disabled={running}>
            Enviar
          </Button>
        </div>
      </form>
    </Card>
  );
}

export default function AiManagerPage() {
  const { can } = useSession();
  const status = useApi<any>("/v1/ai/status");
  const list = useApi<{ conversations: any[] }>("/v1/ai/conversations");
  const [current, setCurrent] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const audit = useApi<{ tool_calls: any[] }>(showAudit ? "/v1/ai/audit" : null);
  const reloadList = list.reload;
  const start = async (question: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ conversation_id: string }>("/v1/ai/conversations", { method: "POST", body: { question } });
      setCurrent(r.conversation_id);
      setQ("");
      reloadList();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha");
    } finally {
      setBusy(false);
    }
  };
  if (status.error) return <ErrorBox error={status.error} onRetry={status.reload} />;
  if (!status.data) return null;
  const s = status.data;
  return (
    <div className="space-y-4">
      <PageHeader
        title="Gestor IA"
        description="Pergunte sobre vendas, campanhas e qualidade dos dados. As respostas usam só as consultas do sistema, separam fatos de hipóteses e não executam ações."
        actions={s.available ? <Badge tone="ok">disponível · {s.model}</Badge> : <Badge tone="warn">indisponível</Badge>}
      />
      {!s.available && <Alert tone="info" title="Gestor IA indisponível">{s.reason}</Alert>}
      {s.available && (
        <p className="text-xs text-muted">
          Hoje: {s.usage_today.requests} de {s.limits.dailyRequests} perguntas · {s.privacy}
        </p>
      )}
      {can("org.manage") && <Settings status={s} reload={status.reload} />}
      {err && <Alert tone="err">{err}</Alert>}
      {s.available && (
        <Card title="Nova análise">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim()) void start(q.trim());
            }}
            className="space-y-2"
          >
            <Textarea aria-label="Pergunta para o Gestor IA" rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ex.: Quais campanhas tiveram contribuição negativa nesta semana?" />
            <Button type="submit" busy={busy}>
              Perguntar
            </Button>
          </form>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((x) => (
              <Button key={x} variant="ghost" className="text-left text-xs" onClick={() => void start(x)}>
                {x}
              </Button>
            ))}
          </div>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card title="Conversas">
          {(list.data?.conversations ?? []).length === 0 ? (
            <p className="text-sm text-muted">Nenhuma conversa.</p>
          ) : (
            <ul className="space-y-1">
              {list.data!.conversations.map((c) => (
                <li key={c.id}>
                  <button className={`w-full truncate rounded px-2 py-1 text-left text-sm ${current === c.id ? "bg-surface-2 font-medium" : "hover:bg-surface-2"}`} onClick={() => setCurrent(c.id)} title={c.title}>
                    {c.title}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {current ? <Conversation key={current} id={current} onChanged={reloadList} /> : <div />}
      </div>
      <Card title="Auditoria das consultas" actions={<Button variant="ghost" onClick={() => setShowAudit((v) => !v)}>{showAudit ? "Ocultar" : "Mostrar"}</Button>}>
        {showAudit && audit.data && (
          <Table headers={["Quando", "Ferramenta", "Parâmetros", "Resultado", "Quem"]}>
            {audit.data.tool_calls.map((t) => (
              <tr key={t.id}>
                <Td className="text-xs">{dateTime(t.created_at)}</Td>
                <Td>{TOOL_LABEL[t.tool] ?? t.tool}</Td>
                <Td className="font-mono text-xs">{JSON.stringify(t.input)}</Td>
                <Td className="text-xs">{t.ok ? "ok" : "erro"} · {t.result_bytes} bytes · {t.duration_ms} ms</Td>
                <Td className="text-xs">{t.user_email}</Td>
              </tr>
            ))}
          </Table>
        )}
        {!showAudit && <p className="text-sm text-muted">Cada consulta da IA fica registrada (ferramenta, parâmetros, tamanho e duração) por 180 dias.</p>}
      </Card>
    </div>
  );
}
