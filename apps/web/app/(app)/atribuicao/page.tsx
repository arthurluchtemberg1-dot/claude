"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, ErrorBox, Field, Input, PageHeader, Select, Skeleton, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { ATTRIBUTION_LABELS, addDays, dateTime, money, todayIn } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Policies {
  policies: { policy_key: string; current: any; versions: any[] }[];
  models: Record<string, string>;
  windows: number[];
}

export default function AttributionPage() {
  const { org, can } = useSession();
  const tz = org.organization.timezone;
  const { toast, toastNode } = useToast();
  const today = todayIn(tz);
  const [from, setFrom] = useState(addDays(today, -6));
  const [to, setTo] = useState(today);
  const policies = useApi<Policies>("/v1/attribution/policies");
  const compare = useApi<{ policies: any[]; note: string }>(`/v1/attribution/compare?from=${from}&to=${to}`);
  const [form, setForm] = useState({ name: "Primeiro toque — 30 dias", model: "first_touch", window_days: 30 });
  const [edit, setEdit] = useState<{ key: string; model: string; window_days: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can("attribution.manage");

  async function act<T>(fn: () => Promise<T>, ok: string): Promise<T | null> {
    try {
      const r = await fn();
      toast({ tone: "ok", text: ok });
      policies.reload();
      compare.reload();
      return r;
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
      return null;
    }
  }

  const models = policies.data?.models ?? {};
  const windows = policies.data?.windows ?? [1, 7, 14, 30];

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader
        title="Atribuição"
        description="A política principal define a origem exibida em vendas, painel e webhooks. Outras políticas servem para comparação. Alterar modelo ou janela cria nova versão; o histórico é preservado e recalcular nunca reenvia conversões."
      />
      {policies.error && <ErrorBox error={policies.error} onRetry={policies.reload} />}
      {!policies.data && !policies.error && <Skeleton className="h-40" />}
      {policies.data && (
        <Card title="Políticas ativas">
          <Table headers={["Política", "Modelo", "Janela", "Versão", "Criada em", ""]}>
            {policies.data.policies
              .filter((p) => p.current)
              .map((p) => (
                <tr key={p.policy_key}>
                  <Td>
                    {p.current.name} {p.policy_key === "default" && <Badge tone="info">principal</Badge>}
                    <div className="font-mono text-xs text-muted">{p.policy_key}</div>
                  </Td>
                  <Td>{p.current.model_label}</Td>
                  <Td className="tabular">{p.current.window_days} dia(s)</Td>
                  <Td className="tabular">
                    v{p.current.version}
                    {p.versions.length > 1 && (
                      <details className="text-xs text-muted">
                        <summary className="cursor-pointer">histórico</summary>
                        <ul>
                          {p.versions.map((v) => (
                            <li key={v.version}>
                              v{v.version}: {v.model_label}, {v.window_days} d — {dateTime(v.created_at, tz)}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </Td>
                  <Td className="tabular text-xs">{dateTime(p.current.created_at, tz)}</Td>
                  <Td>
                    {manage && (
                      <div className="flex gap-2">
                        <Button variant="secondary" onClick={() => setEdit({ key: p.policy_key, model: p.current.model, window_days: p.current.window_days })}>
                          Nova versão
                        </Button>
                        {p.policy_key !== "default" && (
                          <Button variant="danger" onClick={() => confirm("Desativar esta política de comparação?") && act(() => api(`/v1/attribution/policies/${p.policy_key}`, { method: "DELETE" }), "Política desativada")}>
                            Desativar
                          </Button>
                        )}
                      </div>
                    )}
                  </Td>
                </tr>
              ))}
          </Table>
          {edit && (
            <form
              className="mt-4 grid grid-cols-1 gap-3 rounded-lg border border-border p-3 md:grid-cols-4"
              onSubmit={async (e) => {
                e.preventDefault();
                const r = await act(() => api(`/v1/attribution/policies/${edit.key}`, { method: "PUT", body: { model: edit.model, window_days: edit.window_days } }), "Nova versão criada");
                if (r) setEdit(null);
              }}
            >
              <p className="text-sm md:col-span-4">
                Nova versão de <strong>{edit.key}</strong>. Vendas novas usam a nova versão; recalcule o período para atualizar vendas anteriores.
              </p>
              <Field label="Modelo">
                {(id) => (
                  <Select id={id} value={edit.model} onChange={(e) => setEdit({ ...edit, model: e.target.value })}>
                    {Object.entries(models).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Janela">
                {(id) => (
                  <Select id={id} value={edit.window_days} onChange={(e) => setEdit({ ...edit, window_days: Number(e.target.value) })}>
                    {windows.map((w) => (
                      <option key={w} value={w}>
                        {w} dia(s)
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <div className="flex items-end gap-2">
                <Button type="submit">Salvar versão</Button>
                <Button variant="ghost" type="button" onClick={() => setEdit(null)}>
                  Cancelar
                </Button>
              </div>
            </form>
          )}
        </Card>
      )}

      {manage && (
        <Card title="Nova política de comparação">
          <form
            className="grid grid-cols-1 gap-3 md:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              await act(() => api("/v1/attribution/policies", { method: "POST", body: form }), "Política criada — recalcule o período para comparar vendas anteriores");
              setBusy(false);
            }}
          >
            <Field label="Nome">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Modelo">
              {(id) => (
                <Select id={id} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                  {Object.entries(models).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Janela">
              {(id) => (
                <Select id={id} value={form.window_days} onChange={(e) => setForm({ ...form, window_days: Number(e.target.value) })}>
                  {windows.map((w) => (
                    <option key={w} value={w}>
                      {w} dia(s)
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end">
              <Button type="submit" busy={busy}>
                Criar política
              </Button>
            </div>
          </form>
        </Card>
      )}

      <Card title="Comparação no período">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <Field label="De">{(id) => <Input id={id} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Até">{(id) => <Input id={id} type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />}</Field>
          {manage && (
            <Button
              variant="secondary"
              onClick={async () => {
                const r = await act(() => api<{ queued: number }>("/v1/attribution/recompute", { method: "POST", body: { from, to } }), "Recálculo agendado");
                if (r) toast({ tone: "ok", text: `${r.queued} venda(s) em recálculo; atualize em instantes` });
              }}
            >
              Recalcular período
            </Button>
          )}
        </div>
        {compare.error && <ErrorBox error={compare.error} onRetry={compare.reload} />}
        {compare.data && (
          <div className="grid gap-4 lg:grid-cols-2">
            {compare.data.policies.map((p) => (
              <div key={p.policy_key} className="rounded-lg border border-border p-3">
                <h3 className="font-medium">
                  {p.name} <span className="text-xs text-muted">({p.model_label}, {p.window_days} d, v{p.version})</span>
                </h3>
                <Table headers={["Categoria", "Pedidos", "Receita aprovada"]}>
                  {p.categories.map((cRow: any) => (
                    <tr key={`${cRow.currency}-${cRow.category}`}>
                      <Td>{cRow.category === "not_computed" ? <Badge tone="warn">sem cálculo nesta política</Badge> : (ATTRIBUTION_LABELS[cRow.category] ?? cRow.category)}</Td>
                      <Td className="tabular">{cRow.orders}</Td>
                      <Td className="tabular">{money(cRow.gross, cRow.currency)}</Td>
                    </tr>
                  ))}
                </Table>
                {p.networks.map((g: any) => (
                  <div key={g.currency} className="mt-2 text-xs text-muted">
                    Receita creditada por rede ({g.currency}):{" "}
                    {g.rows.length ? g.rows.map((r: any) => `${r.network ?? "sem rede"} ${money(r.attributed_gross_minor, g.currency)} (${r.orders_credit} venda(s))`).join(" · ") : "—"}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {compare.data && <p className="mt-3 text-xs text-muted">{compare.data.note}</p>}
        <Alert tone="info" title="Resultados internos">
          A atribuição usa somente evidências observadas por este sistema (token, origem do checkout, sessões). Não reproduz a atribuição das redes de anúncio.
        </Alert>
      </Card>
    </div>
  );
}
