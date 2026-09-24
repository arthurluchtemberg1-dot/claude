"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, Field, Input, PageHeader, Select, Table, Td, Textarea, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { money, todayIn } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const CATEGORY_LABELS: Record<string, string> = {
  media_offline: "Mídia offline (conta como mídia)",
  influencer: "Influenciador (conta como mídia)",
  affiliate: "Afiliado (conta como mídia)",
  boost: "Impulsionamento (conta como mídia)",
  product_cost: "Custo de produto",
  shipping: "Frete",
  tax_estimate: "Impostos estimados",
  operating_expense: "Despesa operacional",
  tool: "Ferramentas",
  other: "Outros custos variáveis",
};

export default function CostsPage() {
  const { org, can, reloadOrg } = useSession();
  const { toast, toastNode } = useToast();
  const today = todayIn(org.organization.timezone);
  const accounts = useApi<{ ad_accounts: any[] }>("/v1/ad-accounts");
  const entries = useApi<{ entries: any[] }>("/v1/cost-entries");
  const fees = useApi<{ fee_schedules: any[] }>("/v1/fee-schedules");
  const [acc, setAcc] = useState({ network: "meta", external_account_id: "", name: "", currency: org.organization.currency, timezone: org.organization.timezone });
  const [imp, setImp] = useState({ ad_account_id: "", level: "campaign", csv: "data;campanha_id;campanha;gasto;impressoes;cliques\n", date: "data", spend: "gasto", entity_id: "campanha_id", entity_name: "campanha", impressions: "impressoes", link_clicks: "cliques" });
  const [preview, setPreview] = useState<any | null>(null);
  const [cost, setCost] = useState({ category: "influencer", description: "", amount: "", currency: org.organization.currency, period_start: today, period_end: today });
  const [fee, setFee] = useState({ name: "Taxa do checkout", percent: "0", fixed: "0", valid_from: today });

  async function act<T>(fn: () => Promise<T>, ok: string): Promise<T | undefined> {
    try {
      const r = await fn();
      toast({ tone: "ok", text: ok });
      return r;
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
      return undefined;
    }
  }

  const writable = can("costs.write");

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader title="Custos e mídia" description="Gastos importados (CSV) e custos sem API com origem identificada. Reimportar substitui o dia/entidade (não soma). Custos materiais ausentes deixam a contribuição como parcial." />
      <Card title="Contas de anúncios">
        {!accounts.data?.ad_accounts.length ? (
          <Empty title="Nenhuma conta">Cadastre a conta para importar gastos por CSV. A sincronização via API da Meta depende de app aprovado (ver dependências externas).</Empty>
        ) : (
          <Table headers={["Conta", "Rede", "Moeda/fuso", "Cobertura"]}>
            {accounts.data.ad_accounts.map((a) => (
              <tr key={a.id}>
                <Td>
                  {a.name} <span className="font-mono text-xs text-muted">{a.external_account_id}</span>
                </Td>
                <Td>{a.network}</Td>
                <Td>
                  {a.currency} · {a.timezone ?? "—"}
                  {a.timezone && a.timezone !== org.organization.timezone && <Badge tone="warn">fuso diferente da organização</Badge>}
                </Td>
                <Td className="text-xs">{a.synced_from ? `${a.synced_from} a ${a.synced_to}` : "sem dados"}</Td>
              </tr>
            ))}
          </Table>
        )}
        {writable && (
          <form
            className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-6"
            onSubmit={async (e) => {
              e.preventDefault();
              await act(() => api("/v1/ad-accounts", { method: "POST", body: acc }), "Conta cadastrada");
              accounts.reload();
            }}
          >
            <Select aria-label="Rede" value={acc.network} onChange={(e) => setAcc({ ...acc, network: e.target.value })}>
              {["meta", "google", "tiktok", "microsoft", "kwai", "taboola", "outbrain", "manual"].map((n) => (
                <option key={n}>{n}</option>
              ))}
            </Select>
            <Input aria-label="ID da conta" placeholder="ID da conta (ex.: act_123)" required value={acc.external_account_id} onChange={(e) => setAcc({ ...acc, external_account_id: e.target.value })} />
            <Input aria-label="Nome" placeholder="Nome" required value={acc.name} onChange={(e) => setAcc({ ...acc, name: e.target.value })} />
            <Input aria-label="Moeda" value={acc.currency} onChange={(e) => setAcc({ ...acc, currency: e.target.value.toUpperCase() })} />
            <Input aria-label="Fuso da conta" value={acc.timezone} onChange={(e) => setAcc({ ...acc, timezone: e.target.value })} />
            <Button type="submit">Cadastrar conta</Button>
          </form>
        )}
      </Card>

      {writable && (
        <Card title="Importar gasto diário (CSV)">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label="Conta">
              {(id) => (
                <Select id={id} value={imp.ad_account_id} onChange={(e) => setImp({ ...imp, ad_account_id: e.target.value })}>
                  <option value="">Selecione</option>
                  {accounts.data?.ad_accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Nível (um único nível por conta evita dupla contagem)">
              {(id) => (
                <Select id={id} value={imp.level} onChange={(e) => setImp({ ...imp, level: e.target.value })}>
                  <option value="account">Conta</option>
                  <option value="campaign">Campanha</option>
                  <option value="adset">Conjunto</option>
                  <option value="ad">Anúncio</option>
                </Select>
              )}
            </Field>
            {(["date", "spend", "entity_id", "entity_name", "impressions", "link_clicks"] as const).map((k) => (
              <Field key={k} label={`Coluna: ${k}`}>
                {(id) => <Input id={id} value={imp[k]} onChange={(e) => setImp({ ...imp, [k]: e.target.value })} />}
              </Field>
            ))}
          </div>
          <Field label="Conteúdo CSV (datas AAAA-MM-DD ou DD/MM/AAAA; decimais com vírgula ou ponto)">
            {(id) => <Textarea id={id} rows={6} value={imp.csv} onChange={(e) => setImp({ ...imp, csv: e.target.value })} />}
          </Field>
          <div className="mt-2 flex gap-2">
            <Button
              variant="secondary"
              onClick={async () => {
                const mapping: Record<string, string> = { date: imp.date, spend: imp.spend };
                if (imp.level !== "account") {
                  mapping.entity_id = imp.entity_id;
                  if (imp.entity_name) mapping.entity_name = imp.entity_name;
                }
                if (imp.impressions) mapping.impressions = imp.impressions;
                if (imp.link_clicks) mapping.link_clicks = imp.link_clicks;
                const r = await act(() => api<any>("/v1/imports/spend/preview", { method: "POST", body: { ad_account_id: imp.ad_account_id, level: imp.level, csv: imp.csv, mapping } }), "Prévia gerada");
                if (r) setPreview(r);
              }}
            >
              Gerar prévia
            </Button>
            {preview && preview.row_count > 0 && (
              <Button
                onClick={async () => {
                  await act(() => api(`/v1/imports/${preview.import_id}/commit`, { method: "POST", body: {} }), `${preview.row_count} linha(s) importadas`);
                  setPreview(null);
                  accounts.reload();
                }}
              >
                Confirmar importação
              </Button>
            )}
          </div>
          {preview && (
            <div className="mt-3 space-y-2 text-sm">
              <p>
                {preview.row_count} linha(s) válidas · total {preview.total_spend} {preview.currency} · período {preview.period?.from ?? "—"} a {preview.period?.to ?? "—"} · fuso da conta {preview.timezone}
              </p>
              {preview.will_replace_existing > 0 && <Alert tone="warn" title={`${preview.will_replace_existing} registro(s) existente(s) serão substituídos (não somados)`} />}
              {preview.errors.map((er: any) => (
                <Alert key={er.line} tone="err" title={`Linha ${er.line}: ${er.message}`} />
              ))}
            </div>
          )}
        </Card>
      )}

      <Card title="Custos sem API e despesas">
        {writable && (
          <form
            className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-7"
            onSubmit={async (e) => {
              e.preventDefault();
              await act(() => api("/v1/cost-entries", { method: "POST", body: cost }), "Custo registrado");
              entries.reload();
            }}
          >
            <Select aria-label="Categoria" value={cost.category} onChange={(e) => setCost({ ...cost, category: e.target.value })} className="md:col-span-2">
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Input aria-label="Descrição" placeholder="Descrição / origem" required value={cost.description} onChange={(e) => setCost({ ...cost, description: e.target.value })} />
            <Input aria-label="Valor" placeholder="Valor (ex.: 150.00)" required pattern="\d+(\.\d{1,2})?" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} />
            <Input aria-label="Início" type="date" value={cost.period_start} onChange={(e) => setCost({ ...cost, period_start: e.target.value })} />
            <Input aria-label="Fim" type="date" value={cost.period_end} onChange={(e) => setCost({ ...cost, period_end: e.target.value })} />
            <Button type="submit">Adicionar</Button>
          </form>
        )}
        {!entries.data?.entries.length ? (
          <Empty title="Nenhum custo registrado" />
        ) : (
          <Table headers={["Categoria", "Descrição", "Valor", "Período", "Origem", ""]}>
            {entries.data.entries.map((c) => (
              <tr key={c.id}>
                <Td>{CATEGORY_LABELS[c.category] ?? c.category}</Td>
                <Td>{c.description}</Td>
                <Td className="tabular">{money(c.amount_minor, c.currency)}</Td>
                <Td className="text-xs">
                  {c.period_start} a {c.period_end}
                </Td>
                <Td>
                  <Badge>{c.source}</Badge>
                </Td>
                <Td>
                  {writable && (
                    <Button variant="ghost" onClick={async () => { await act(() => api(`/v1/cost-entries/${c.id}`, { method: "DELETE" }), "Removido"); entries.reload(); }}>
                      Remover
                    </Button>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Taxas (vigência) e política de custos">
        {writable && (
          <form
            className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-5"
            onSubmit={async (e) => {
              e.preventDefault();
              const bp = Math.round(Number(fee.percent.replace(",", ".")) * 100);
              await act(() => api("/v1/fee-schedules", { method: "POST", body: { name: fee.name, percent_bp: bp, fixed: fee.fixed, currency: org.organization.currency, valid_from: fee.valid_from } }), "Tabela de taxa criada");
              fees.reload();
            }}
          >
            <Input aria-label="Nome" value={fee.name} onChange={(e) => setFee({ ...fee, name: e.target.value })} />
            <Input aria-label="Percentual" placeholder="% (ex.: 4,99)" value={fee.percent} onChange={(e) => setFee({ ...fee, percent: e.target.value })} />
            <Input aria-label="Fixo" placeholder="Fixo (ex.: 1.00)" value={fee.fixed} onChange={(e) => setFee({ ...fee, fixed: e.target.value })} />
            <Input aria-label="Vigência" type="date" value={fee.valid_from} onChange={(e) => setFee({ ...fee, valid_from: e.target.value })} />
            <Button type="submit">Adicionar taxa</Button>
          </form>
        )}
        {fees.data?.fee_schedules.map((f) => (
          <p key={f.id} className="text-sm">
            {f.name}: {(f.percent_bp / 100).toLocaleString("pt-BR")}% + {money(f.fixed_minor, f.currency)} desde {f.valid_from} <Badge tone="info">estimativa quando o checkout não informa a taxa</Badge>
          </p>
        ))}
        {writable && (
          <div className="mt-3 text-sm">
            <p className="mb-1 font-medium">Custos materiais declarados como inexistentes nesta operação:</p>
            {["impostos", "custo de produto"].map((c) => {
              const current = org.organization.cost_policy?.declared_zero ?? [];
              return (
                <label key={c} className="mr-4 inline-flex items-center gap-1">
                  <input
                    type="checkbox"
                    defaultChecked={current.includes(c)}
                    onChange={async (e) => {
                      const next = e.target.checked ? [...new Set([...current, c])] : current.filter((x) => x !== c);
                      await act(() => api("/v1/org/cost-policy", { method: "PATCH", body: { declared_zero: next } }), "Política de custos atualizada");
                      reloadOrg();
                    }}
                  />
                  Sem {c}
                </label>
              );
            })}
            <p className="mt-1 text-xs text-muted">Sem essa declaração ou lançamentos da categoria, a contribuição aparece como “resultado parcial”.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
