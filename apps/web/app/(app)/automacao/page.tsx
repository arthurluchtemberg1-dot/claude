"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { DECISION_TONE, LEVEL_LABEL, RULE_STATUS as STATUS, RuleBuilder, type Catalog } from "@/components/rule-builder";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, PageHeader, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */


function KillSwitch() {
  const { can } = useSession();
  const k = useApi<{ system: boolean; organization: boolean; projects: any[] }>("/v1/rules/kill-switch");
  const toast = useToast();
  if (!k.data) return null;
  return (
    <Card title="Parada de emergência">
      {toast.toastNode}
      {k.data.system && <Alert tone="err">Parada do sistema ativa (RULES_KILL_SWITCH): nenhuma regra executa ações.</Alert>}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span>Organização: {k.data.organization ? <Badge tone="err">regras pausadas</Badge> : <Badge tone="ok">regras liberadas</Badge>}</span>
        {can("rules.activate") && (
          <Button
            variant={k.data.organization ? "secondary" : "danger"}
            onClick={async () => {
              await api("/v1/rules/kill-switch", { method: "PUT", body: { organization: !k.data!.organization } });
              toast.toast({ tone: "ok", text: k.data!.organization ? "Regras liberadas" : "Todas as regras pausadas" });
              k.reload();
            }}
          >
            {k.data.organization ? "Liberar regras" : "Pausar todas as regras agora"}
          </Button>
        )}
        {k.data.projects.length > 0 && <span className="text-muted">{k.data.projects.length} projeto(s) com regras pausadas</span>}
      </div>
    </Card>
  );
}

export default function AutomationPage() {
  const router = useRouter();
  const { can, org } = useSession();
  const list = useApi<{ rules: any[] }>("/v1/rules");
  const catalog = useApi<Catalog>("/v1/rules/catalog");
  const [draft, setDraft] = useState<{ def: any; name: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const tz = org.organization.timezone;

  const act = async (id: string, what: "simulate" | "activate" | "shadow" | "pause") => {
    setErr(null);
    try {
      await api(`/v1/rules/${id}/${what}`, { method: "POST", body: {} });
      list.reload();
      if (what === "simulate") router.push(`/automacao/${id}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Falha");
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Automação"
        description="Regras que avaliam campanhas, conjuntos, anúncios ou metas do projeto e notificam, marcam ou chamam webhooks. Toda regra é simulada antes de ativar; ações na rede de anúncios ficam em simulação até a conexão de gestão Meta."
      />
      <KillSwitch />
      {err && <Alert tone="err">{err}</Alert>}
      <Card title="Regras">
        {list.error && <ErrorBox error={list.error} onRetry={list.reload} />}
        {list.data && list.data.rules.length === 0 && <Empty title="Nenhuma regra ainda">Comece por um exemplo abaixo e preencha os valores do seu negócio.</Empty>}
        {list.data && list.data.rules.length > 0 && (
          <Table headers={["Regra", "Nível", "Situação", "Última execução", ""]}>
            {list.data.rules.map((r) => (
              <tr key={r.id}>
                <Td>
                  <Link href={`/automacao/${r.id}`} className="font-medium underline">
                    {r.name}
                  </Link>
                  <div className="text-xs text-muted">versão {r.current_version}</div>
                </Td>
                <Td>{LEVEL_LABEL[r.level] ?? r.level}</Td>
                <Td>
                  <Badge tone={STATUS[r.status]?.tone ?? "neutral"}>{STATUS[r.status]?.label ?? r.status}</Badge>
                  {r.status_reason && <div className="text-xs text-muted">{r.status_reason}</div>}
                </Td>
                <Td className="text-xs">
                  {r.last_run ? (
                    <>
                      <div>{dateTime(r.last_run.started_at, tz)}</div>
                      {r.last_run.skip_reason ? (
                        <div className="text-warn">{r.last_run.skip_reason}</div>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {Object.entries(r.last_run.summary ?? {}).map(([k, v]) => (
                            <Badge key={k} tone={DECISION_TONE[k] ?? "neutral"}>
                              {`${k.replace("skip_", "").replace("_", " ")}: ${v}`}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td>
                  {can("rules.activate") && (
                    <div className="flex flex-wrap gap-1">
                      <Button variant="ghost" onClick={() => void act(r.id, "simulate")}>
                        Simular
                      </Button>
                      {r.status !== "active" && (
                        <Button variant="secondary" onClick={() => void act(r.id, "activate")}>
                          Ativar
                        </Button>
                      )}
                      {r.status !== "simulate" && r.status !== "active" && (
                        <Button variant="ghost" onClick={() => void act(r.id, "shadow")}>
                          Só simular no horário
                        </Button>
                      )}
                      {(r.status === "active" || r.status === "simulate") && (
                        <Button variant="ghost" onClick={() => void act(r.id, "pause")}>
                          Pausar
                        </Button>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {can("rules.activate") && catalog.data && (
        <Card title="Começar por um exemplo">
          <ul className="grid gap-2 md:grid-cols-2">
            {catalog.data.presets.map((p) => (
              <li key={p.key} className="rounded-md border border-border p-3">
                <div className="font-medium">{p.name}</div>
                <p className="text-sm text-muted">{p.description}</p>
                <p className="mt-1 text-xs">Você define: {p.required.join(", ")}</p>
                <Button variant="secondary" className="mt-2" onClick={() => setDraft({ def: p.definition, name: p.name.replace(/^Exemplo: /, "") })}>
                  Usar este exemplo
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {draft && catalog.data && (
        <RuleBuilder
          catalog={catalog.data}
          initial={draft.def}
          initialName={draft.name}
          onSaved={(id) => {
            setDraft(null);
            router.push(`/automacao/${id}`);
          }}
        />
      )}
    </div>
  );
}
