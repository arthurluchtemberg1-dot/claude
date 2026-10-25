"use client";

import { useEffect, useMemo, useState } from "react";
import { Alert, Badge, Button, Card, Field, Input, Select, Table, Td } from "./ui";
import { api, ApiError, useApi } from "@/lib/api";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Construtor de regras (R26-01): formulário declarativo — métrica, comparação e valor — sem código. Ações de mídia
 * aparecem desabilitadas com o motivo enquanto não houver conector de gestão. Simulação antes de salvar/ativar.
 */

export interface Catalog {
  metrics: { key: string; label: string; unit: string; levels: string[]; description: string; availability: string; unavailableReason?: string }[];
  actions: { type: string; label: string; availability: string; unavailable_reason: string | null }[];
  periods: { key: string; label: string }[];
  schedules: number[];
  levels: string[];
  presets: { key: string; name: string; description: string; required: string[]; definition: any }[];
  notes: string[];
}

export const RULE_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "err" | "neutral" | "info" }> = {
  draft: { label: "Rascunho", tone: "neutral" },
  simulate: { label: "Só simulando", tone: "info" },
  active: { label: "Ativa", tone: "ok" },
  paused: { label: "Pausada", tone: "neutral" },
  suspended: { label: "Suspensa", tone: "err" },
};

export const LEVEL_LABEL: Record<string, string> = { campaign: "Campanha", adset: "Conjunto", ad: "Anúncio", project: "Projeto (metas)" };
const OPS: [string, string][] = [
  ["gt", ">"],
  ["gte", "≥"],
  ["lt", "<"],
  ["lte", "≤"],
  ["eq", "="],
  ["neq", "≠"],
];
const UNIT_HINT: Record<string, string> = { money: "valor em reais, ex.: 100.00", percent: "em %, ex.: 1.5", ratio: "ex.: 2.5", count: "número", days: "dias", status: "ex.: ACTIVE" };
export const DECISION_TONE: Record<string, "ok" | "warn" | "err" | "neutral" | "info"> = {
  execute: "ok",
  would_execute: "info",
  no_match: "neutral",
  skip_stale: "warn",
  skip_learning: "neutral",
  skip_sample: "neutral",
  skip_missing_data: "warn",
  skip_cooldown: "neutral",
  skip_daily_cap: "warn",
  skip_conflict: "warn",
};

export function SimulationResult({ evaluations }: { evaluations: any[] }) {
  return (
    <div className="space-y-3" data-testid="simulation-result">
      {evaluations.map((ev, i) => (
        <div key={i}>
          <div className="mb-1 text-sm">
            <span className="font-medium">{i === 0 ? "Agora" : `Fim do dia ${ev.window.to.split("-").reverse().join("/")}`}</span> · janela {ev.window.from.split("-").reverse().join("/")}–{ev.window.to.split("-").reverse().join("/")}{" "}
            {!ev.freshness.ok && <Badge tone="warn">dados de gasto atrasados</Badge>}
          </div>
          {!ev.freshness.ok && <p className="mb-1 text-xs text-warn">{ev.freshness.reason}</p>}
          {ev.entities.length === 0 ? (
            <p className="text-sm text-muted">Nenhuma entidade no escopo com dados no período.</p>
          ) : (
            <Table headers={["Entidade", "Decisão", "Explicação"]}>
              {ev.entities.map((e: any) => (
                <tr key={`${e.level}:${e.id}`}>
                  <Td>
                    <div className="font-medium">{e.name}</div>
                    {e.id && <div className="font-mono text-xs text-muted">{e.id}</div>}
                  </Td>
                  <Td>
                    <Badge tone={DECISION_TONE[e.decision] ?? "neutral"}>{e.decision_label}</Badge>
                  </Td>
                  <Td className="text-xs">{e.explanation}</Td>
                </tr>
              ))}
            </Table>
          )}
        </div>
      ))}
    </div>
  );
}

export function RuleBuilder({ catalog, initial, initialName, onSaved, ruleId }: { catalog: Catalog; initial: any; initialName: string; onSaved: (id: string) => void; ruleId?: string }) {
  const [name, setName] = useState(initialName);
  const [def, setDef] = useState<any>(initial);
  const [busy, setBusy] = useState<"sim" | "save" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sim, setSim] = useState<any[] | null>(null);
  const [days, setDays] = useState(0);
  const projects = useApi<{ projects: { id: string; name: string }[] }>("/v1/projects");
  const subs = useApi<{ subscriptions: { id: string; name: string; events: string[]; status: string }[] }>("/v1/webhook-subscriptions");
  useEffect(() => {
    setDef(initial);
    setName(initialName);
    setSim(null);
  }, [initial, initialName]);
  const metrics = useMemo(() => catalog.metrics.filter((m) => m.levels.includes(def.level)), [catalog.metrics, def.level]);
  const set = (path: string[], v: any) =>
    setDef((d: any) => {
      const copy = structuredClone(d);
      let o = copy;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path.at(-1)!] = v;
      return copy;
    });
  const items: any[] = def.condition.items;
  const hasAction = (t: string) => def.actions.some((a: any) => a.type === t);
  const toggleAction = (t: string, on: boolean, extra: any = {}) => set(["actions"], on ? [...def.actions.filter((a: any) => a.type !== t), { type: t, ...extra }] : def.actions.filter((a: any) => a.type !== t));

  const run = async (kind: "sim" | "save") => {
    setBusy(kind);
    setErr(null);
    try {
      if (kind === "sim") {
        const r = await api<{ evaluations: any[] }>("/v1/rules/simulate", { method: "POST", body: { definition: def, days } });
        setSim(r.evaluations);
      } else if (ruleId) {
        await api(`/v1/rules/${ruleId}`, { method: "PUT", body: { name, definition: def } });
        onSaved(ruleId);
      } else {
        const r = await api<{ id: string }>("/v1/rules", { method: "POST", body: { name, definition: def } });
        onSaved(r.id);
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card title={ruleId ? "Editar regra (cria nova versão)" : "Nova regra"}>
      {err && <Alert tone="err">{err}</Alert>}
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Nome">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />}</Field>
        <Field label="Avaliar por">
          {(id) => (
            <Select id={id} value={def.level} onChange={(e) => set(["level"], e.target.value)}>
              {catalog.levels.map((l) => (
                <option key={l} value={l}>
                  {LEVEL_LABEL[l] ?? l}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Período avaliado">
          {(id) => (
            <Select id={id} value={def.evaluation.period} onChange={(e) => set(["evaluation", "period"], e.target.value)}>
              {catalog.periods.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <h3 className="mt-4 text-sm font-semibold">Condições</h3>
      <div className="mt-1 flex items-center gap-2 text-sm">
        <span>Disparar quando</span>
        <Select aria-label="Combinação das condições" value={def.condition.op} onChange={(e) => set(["condition", "op"], e.target.value)} className="w-auto py-1">
          <option value="and">todas</option>
          <option value="or">qualquer uma</option>
        </Select>
        <span>das condições forem verdadeiras. Dado ausente nunca conta como zero.</span>
      </div>
      <ul className="mt-2 space-y-2">
        {items.map((it, i) => {
          const m = catalog.metrics.find((x) => x.key === it.metric);
          return (
            <li key={i} className="flex flex-wrap items-center gap-2">
              <Select aria-label={`Métrica ${i + 1}`} value={it.metric} onChange={(e) => set(["condition", "items", String(i), "metric"], e.target.value)} className="w-auto">
                {metrics.map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                    {x.availability === "planned" ? " (indisponível)" : ""}
                  </option>
                ))}
              </Select>
              <Select aria-label={`Comparação ${i + 1}`} value={it.op} onChange={(e) => set(["condition", "items", String(i), "op"], e.target.value)} className="w-auto">
                {OPS.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </Select>
              <Input aria-label={`Valor ${i + 1}`} value={it.value} placeholder={UNIT_HINT[m?.unit ?? "count"]} onChange={(e) => set(["condition", "items", String(i), "value"], e.target.value)} className="w-40" />
              {m?.availability === "planned" && <span className="text-xs text-warn">{m.unavailableReason}</span>}
              <Button variant="ghost" aria-label={`Remover condição ${i + 1}`} onClick={() => set(["condition", "items"], items.filter((_, j) => j !== i))}>
                ×
              </Button>
            </li>
          );
        })}
      </ul>
      <Button variant="secondary" className="mt-2" disabled={items.length >= 10} onClick={() => set(["condition", "items"], [...items, { metric: metrics[0]?.key ?? "spend", op: "gte", value: "" }])}>
        Adicionar condição
      </Button>

      <h3 className="mt-4 text-sm font-semibold">Amostra mínima e proteção</h3>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Investimento mínimo (R$)">{(id) => <Input id={id} value={def.evaluation.min_spend ?? ""} onChange={(e) => set(["evaluation", "min_spend"], e.target.value || null)} />}</Field>
        <Field label="Vendas mínimas">{(id) => <Input id={id} value={def.evaluation.min_orders ?? ""} onChange={(e) => set(["evaluation", "min_orders"], e.target.value || null)} />}</Field>
        <Field label="Fase de aprendizado">
          {(id) => (
            <Select id={id} value={def.evaluation.exclude_learning === false ? "include" : "exclude"} onChange={(e) => set(["evaluation", "exclude_learning"], e.target.value === "exclude")}>
              <option value="exclude">Não agir em aprendizado</option>
              <option value="include">Agir mesmo em aprendizado</option>
            </Select>
          )}
        </Field>
        <Field label="Idade mínima (dias)" hint="Usada quando a Meta não informa a fase de aprendizado">
          {(id) => <Input id={id} type="number" min={0} max={60} value={def.evaluation.min_age_days} onChange={(e) => set(["evaluation", "min_age_days"], Number(e.target.value))} />}
        </Field>
        <Field label="Atraso de conversão (h)" hint="Ignora as últimas horas, em que vendas ainda podem chegar">
          {(id) => <Input id={id} type="number" min={0} max={72} value={def.evaluation.conversion_delay_hours} onChange={(e) => set(["evaluation", "conversion_delay_hours"], Number(e.target.value))} />}
        </Field>
        <Field label="Filtrar por nome contém">{(id) => <Input id={id} value={def.scope.name_contains ?? ""} onChange={(e) => set(["scope", "name_contains"], e.target.value || null)} />}</Field>
        <Field label="Projetos" hint="Nenhum = todos que você acessa">
          {(id) => (
            <Select id={id} multiple value={def.scope.project_ids} onChange={(e) => set(["scope", "project_ids"], Array.from(e.target.selectedOptions).map((o) => o.value))} className="h-20">
              {(projects.data?.projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <h3 className="mt-4 text-sm font-semibold">Ações</h3>
      <div className="space-y-2">
        {catalog.actions.map((a) => {
          // Ações "só simulação" continuam selecionáveis (a simulação mostra o efeito); o servidor bloqueia a ativação.
          const disabled = a.availability === "planned" || (def.level === "project" && !["notify", "webhook"].includes(a.type)) || (a.type === "budget" && def.level === "ad");
          return (
            <div key={a.type} className="flex flex-wrap items-center gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={a.label}
                  disabled={disabled && !hasAction(a.type)}
                  checked={hasAction(a.type)}
                  onChange={(e) =>
                    toggleAction(
                      a.type,
                      e.target.checked,
                      a.type === "tag" ? { tag: "regra" } : a.type === "webhook" ? { subscription_id: subs.data?.subscriptions.find((s) => s.events.includes("rule.triggered"))?.id ?? "" } : a.type === "budget" ? { mode: "percent", value: "-20" } : {},
                    )
                  }
                />
                {a.label}
              </label>
              {a.unavailable_reason && (
                <Badge tone="neutral" title={a.unavailable_reason}>
                  só simulação
                </Badge>
              )}
              {a.unavailable_reason && hasAction(a.type) && <span className="text-xs text-muted">{a.unavailable_reason}</span>}
              {a.type === "budget" && hasAction("budget") && (
                <>
                  <Select aria-label="Tipo de ajuste" className="w-auto" value={def.actions.find((x: any) => x.type === "budget").mode} onChange={(e) => set(["actions"], def.actions.map((x: any) => (x.type === "budget" ? { ...x, mode: e.target.value } : x)))}>
                    <option value="percent">variar em %</option>
                    <option value="absolute">definir valor (R$)</option>
                  </Select>
                  <Input aria-label="Valor do ajuste" className="w-28" value={def.actions.find((x: any) => x.type === "budget").value} onChange={(e) => set(["actions"], def.actions.map((x: any) => (x.type === "budget" ? { ...x, value: e.target.value } : x)))} />
                  <span className="text-xs text-muted">ex.: -20 reduz 20%; 15 aumenta 15%</span>
                </>
              )}
              {a.type === "tag" && hasAction("tag") && (
                <Input aria-label="Tag" className="w-40" value={def.actions.find((x: any) => x.type === "tag").tag} onChange={(e) => set(["actions"], def.actions.map((x: any) => (x.type === "tag" ? { ...x, tag: e.target.value } : x)))} />
              )}
              {a.type === "webhook" && hasAction("webhook") && (
                <Select aria-label="Assinatura de webhook" className="w-auto" value={def.actions.find((x: any) => x.type === "webhook").subscription_id} onChange={(e) => set(["actions"], def.actions.map((x: any) => (x.type === "webhook" ? { ...x, subscription_id: e.target.value } : x)))}>
                  <option value="">Selecione (precisa do evento rule.triggered)</option>
                  {(subs.data?.subscriptions ?? [])
                    .filter((s) => s.events.includes("rule.triggered"))
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name} ({s.status})
                      </option>
                    ))}
                </Select>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="mt-4 text-sm font-semibold">Limites e agenda</h3>
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Intervalo mínimo entre ações (min)">{(id) => <Input id={id} type="number" min={15} value={def.limits.cooldown_minutes} onChange={(e) => set(["limits", "cooldown_minutes"], Number(e.target.value))} />}</Field>
        <Field label="Máximo de ações por dia">{(id) => <Input id={id} type="number" min={1} max={500} value={def.limits.max_actions_per_day} onChange={(e) => set(["limits", "max_actions_per_day"], Number(e.target.value))} />}</Field>
        {hasAction("budget") && (
          <>
            <Field label="Variação máxima por ação (%)">
              {(id) => <Input id={id} type="number" min={1} max={100} value={def.limits.max_budget_change_pct ?? ""} onChange={(e) => set(["limits", "max_budget_change_pct"], e.target.value === "" ? null : Number(e.target.value))} />}
            </Field>
            <Field label="Teto de orçamento diário (R$)" hint="Vazio = sem teto">
              {(id) => <Input id={id} value={def.limits.budget_ceiling ?? ""} onChange={(e) => set(["limits", "budget_ceiling"], e.target.value || null)} />}
            </Field>
          </>
        )}
        <Field label="Avaliar a cada">
          {(id) => (
            <Select id={id} value={def.schedule.every_minutes} onChange={(e) => set(["schedule", "every_minutes"], Number(e.target.value))}>
              {catalog.schedules.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60} h`}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Conflito com outra regra">
          {(id) => (
            <Select id={id} value={def.conflict} onChange={(e) => set(["conflict"], e.target.value)}>
              <option value="skip">Não reverter ação de outra regra</option>
              <option value="override">Pode reverter</option>
            </Select>
          )}
        </Field>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button variant="secondary" busy={busy === "sim"} onClick={() => void run("sim")}>
          Simular
        </Button>
        <Select aria-label="Dias de histórico na simulação" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-auto py-1">
          <option value={0}>só agora</option>
          <option value={3}>+ 3 dias anteriores</option>
          <option value={7}>+ 7 dias anteriores</option>
        </Select>
        <Button busy={busy === "save"} onClick={() => void run("save")}>
          {ruleId ? "Salvar nova versão" : "Salvar como rascunho"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">{catalog.notes.join(" ")}</p>
      {sim && (
        <div className="mt-4">
          <SimulationResult evaluations={sim} />
        </div>
      )}
    </Card>
  );
}
