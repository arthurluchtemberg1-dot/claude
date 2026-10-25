"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { DECISION_TONE, LEVEL_LABEL, RULE_STATUS as STATUS, RuleBuilder, SimulationResult, type Catalog } from "@/components/rule-builder";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, ErrorBox, PageHeader, Table, Td } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

function RunDetail({ id, tz }: { id: string; tz: string }) {
  const r = useApi<{ run: any; decisions: any[] }>(`/v1/rule-runs/${id}`);
  if (r.error) return <ErrorBox error={r.error} onRetry={r.reload} />;
  if (!r.data) return null;
  const run = r.data.run;
  return (
    <div className="mt-2 rounded-md border border-border p-3">
      <div className="mb-2 text-xs text-muted">
        {run.trigger === "simulation" ? "Simulação" : run.mode === "execute" ? "Execução" : "Avaliação sem execução"} · versão {run.version} · dados até {dateTime(run.as_of, tz)} · janela {run.window_from}–{run.window_to}
        {run.context?.freshness && !run.context.freshness.ok && <div className="text-warn">{run.context.freshness.reason}</div>}
      </div>
      <Table headers={["Entidade", "Decisão", "Explicação", "Ações"]}>
        {r.data.decisions.map((d, i) => (
          <tr key={i}>
            <Td>
              <div className="font-medium">{d.entity_name}</div>
              {d.entity_id && <div className="font-mono text-xs text-muted">{d.entity_id}</div>}
            </Td>
            <Td>
              <Badge tone={DECISION_TONE[d.decision] ?? "neutral"}>{d.decision_label}</Badge>
            </Td>
            <Td className="text-xs">{d.explanation}</Td>
            <Td className="text-xs">
              {(d.actions ?? []).map((a: any, j: number) => (
                <div key={j}>
                  {a.type}: {a.status === "executed" ? "executada" : a.status === "skipped_capability" ? "não executada (capacidade)" : a.status === "duplicate" ? "já executada" : "falhou"} {a.detail ? `— ${a.detail}` : ""}
                </div>
              ))}
            </Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}

export default function RulePage() {
  const { id } = useParams<{ id: string }>();
  const { can, org } = useSession();
  const tz = org.organization.timezone;
  // Endereço com ID inválido (link antigo ou digitado): não consulta a API.
  const valid = /^[0-9a-f-]{36}$/i.test(id ?? "");
  const rule = useApi<{ rule: any; definition: any; versions: any[]; last_simulation: any }>(valid ? `/v1/rules/${id}` : null);
  const runs = useApi<{ runs: any[]; actions: any[] }>(valid ? `/v1/rules/${id}/runs` : null);
  const catalog = useApi<Catalog>("/v1/rules/catalog");
  const [open, setOpen] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [sim, setSim] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!valid || rule.error?.status === 404)
    return (
      <Alert tone="warn" title="Regra não encontrada">
        <Link className="underline" href="/automacao">
          Voltar às regras
        </Link>
      </Alert>
    );
  if (rule.error) return <ErrorBox error={rule.error} onRetry={rule.reload} />;
  if (!rule.data) return null;
  const r = rule.data.rule;
  const reload = () => {
    rule.reload();
    runs.reload();
  };
  const call = async (path: string, body: any = {}) => {
    setErr(null);
    setBusy(true);
    try {
      const res = await api<any>(path, { method: "POST", body });
      if (res?.evaluations) setSim(res.evaluations);
      reload();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <PageHeader
        title={r.name}
        description={`${LEVEL_LABEL[rule.data.definition.level] ?? rule.data.definition.level} · versão ${r.current_version}${r.activated_at ? ` · ativada em ${dateTime(r.activated_at, tz)}` : ""}`}
        actions={<Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>}
      />
      {r.status_reason && <Alert tone={r.status === "suspended" ? "err" : "info"}>{r.status_reason}</Alert>}
      {err && <Alert tone="err">{err}</Alert>}
      {can("rules.activate") && (
        <div className="flex flex-wrap gap-2">
          <Button busy={busy} variant="secondary" onClick={() => void call(`/v1/rules/${id}/simulate`, { days: 3 })}>
            Simular (agora + 3 dias)
          </Button>
          {r.status !== "active" && (
            <Button busy={busy} onClick={() => void call(`/v1/rules/${id}/activate`)}>
              Ativar
            </Button>
          )}
          {(r.status === "active" || r.status === "simulate") && (
            <Button busy={busy} variant="ghost" onClick={() => void call(`/v1/rules/${id}/pause`)}>
              Pausar
            </Button>
          )}
          <Button variant="ghost" onClick={() => setEdit((e) => !e)}>
            {edit ? "Fechar edição" : "Editar"}
          </Button>
        </div>
      )}
      {!rule.data.last_simulation && r.status !== "active" && <p className="text-sm text-muted">Simule a versão atual antes de ativar.</p>}
      {sim && (
        <Card title="Resultado da simulação">
          <SimulationResult evaluations={sim} />
        </Card>
      )}
      {edit && catalog.data && (
        <RuleBuilder
          catalog={catalog.data}
          ruleId={id}
          initial={rule.data.definition}
          initialName={r.name}
          onSaved={() => {
            setEdit(false);
            reload();
          }}
        />
      )}
      <Card title="Histórico de execuções">
        {runs.data && runs.data.runs.length === 0 && <p className="text-sm text-muted">Nenhuma execução ainda.</p>}
        <ul className="divide-y divide-border">
          {(runs.data?.runs ?? []).map((x) => (
            <li key={x.id} className="py-2">
              <button className="flex w-full flex-wrap items-center justify-between gap-2 text-left text-sm" onClick={() => setOpen(open === x.id ? null : x.id)} aria-expanded={open === x.id}>
                <span>
                  {dateTime(x.started_at, tz)} · {x.trigger === "simulation" ? "simulação" : x.mode === "execute" ? "execução" : "avaliação sem execução"} · v{x.version}
                </span>
                <span className="flex flex-wrap gap-1">
                  {x.skip_reason ? (
                    <Badge tone="warn">{x.skip_reason}</Badge>
                  ) : (
                    Object.entries(x.summary ?? {}).map(([k, v]) => (
                      <Badge key={k} tone={DECISION_TONE[k] ?? "neutral"}>
                        {`${k}: ${v}`}
                      </Badge>
                    ))
                  )}
                </span>
              </button>
              {open === x.id && <RunDetail id={x.id} tz={tz} />}
            </li>
          ))}
        </ul>
      </Card>
      {runs.data && runs.data.actions.length > 0 && (
        <Card title="Ações executadas">
          <Table headers={["Quando", "Entidade", "Ação", "Resultado", ""]}>
            {runs.data.actions.map((a) => (
              <tr key={a.id}>
                <Td className="text-xs">{dateTime(a.executed_at, tz)}</Td>
                <Td className="font-mono text-xs">{a.entity_id ?? "—"}</Td>
                <Td>{a.action_type}</Td>
                <Td className="text-xs">
                  <Badge tone={a.status === "executed" ? "ok" : a.status === "failed" ? "err" : "neutral"}>{a.status}</Badge> {a.detail}
                </Td>
                <Td>
                  {a.action_type === "tag" && a.status === "executed" && !String(a.detail ?? "").includes("desfeita") && can("rules.activate") && (
                    <Button variant="ghost" onClick={() => void call(`/v1/rule-actions/${a.id}/undo`)}>
                      Desfazer
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <Card title="Versões (imutáveis)">
        <ul className="text-sm">
          {rule.data.versions.map((v) => (
            <li key={v.version}>
              v{v.version} · {dateTime(v.created_at, tz)}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
