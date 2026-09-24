"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, Empty, ErrorBox, Field, Input, PageHeader, Select, Table, Td, useToast } from "@/components/ui";
import { api, ApiError, useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const DELIVERY_LABEL: Record<string, string> = {
  received: "Recebido",
  validated: "Validado",
  queued: "Em fila",
  sent: "Enviado",
  accepted: "Aceito pela API",
  rejected: "Rejeitado",
  retry_scheduled: "Aguardando reenvio",
  expired: "Expirado",
  not_eligible: "Não elegível",
  unknown_outcome: "Resultado desconhecido",
};

export default function PixelsPage() {
  const { org, can } = useSession();
  const { toast, toastNode } = useToast();
  const dests = useApi<{ destinations: any[]; external_delivery_allowed: boolean }>("/v1/destinations");
  const deliveries = useApi<{ deliveries: any[]; note: string }>("/v1/deliveries?limit=50");
  const [form, setForm] = useState({ name: "Pixel principal", pixel_id: "", access_token: "", test_event_code: "" });
  const [busy, setBusy] = useState(false);

  async function act(fn: () => Promise<unknown>, ok: string) {
    try {
      await fn();
      toast({ tone: "ok", text: ok });
      dests.reload();
      deliveries.reload();
    } catch (e) {
      toast({ tone: "err", text: e instanceof ApiError ? e.message : "Falha" });
    }
  }

  return (
    <div className="space-y-4">
      {toastNode}
      <PageHeader title="Pixels e conversões" description="Destinos de conversão por servidor. Criados desligados; envio exige emissor responsável definido, modo de teste validado e envio externo permitido no ambiente." />
      {dests.data && !dests.data.external_delivery_allowed && (
        <Alert tone="warn" title="Envio externo desabilitado neste ambiente">
          Nenhuma chamada é feita às plataformas. As entregas ficam registradas como não elegíveis com o motivo.
        </Alert>
      )}
      {can("pixel.configure") && (
        <Card title="Novo destino Meta Conversions API">
          <form
            className="grid grid-cols-1 gap-3 md:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              await act(
                () =>
                  api("/v1/destinations", {
                    method: "POST",
                    body: { provider: "meta_capi", name: form.name, access_token: form.access_token, config: { pixel_id: form.pixel_id, test_event_code: form.test_event_code || null } },
                  }),
                "Destino criado (desligado)",
              );
              setForm({ ...form, access_token: "" });
              setBusy(false);
            }}
          >
            <Field label="Nome">{(id) => <Input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
            <Field label="Pixel/dataset ID">{(id) => <Input id={id} required inputMode="numeric" value={form.pixel_id} onChange={(e) => setForm({ ...form, pixel_id: e.target.value })} />}</Field>
            <Field label="Token de acesso (fica cifrado no servidor)">{(id) => <Input id={id} required type="password" autoComplete="off" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} />}</Field>
            <Field label="Código de evento de teste">{(id) => <Input id={id} value={form.test_event_code} onChange={(e) => setForm({ ...form, test_event_code: e.target.value })} />}</Field>
            <div className="md:col-span-4">
              <Button type="submit" busy={busy}>
                Criar destino
              </Button>
            </div>
          </form>
        </Card>
      )}
      <Card title="Destinos">
        <ErrorBox error={dests.error} onRetry={dests.reload} />
        {!dests.data?.destinations.length ? (
          <Empty title="Nenhum destino configurado" />
        ) : (
          <Table headers={["Destino", "Estado", "Emissor do Purchase", "Ações"]}>
            {dests.data.destinations.map((d) => (
              <tr key={d.id}>
                <Td>
                  <div className="font-medium">{d.name}</div>
                  <div className="text-xs text-muted">
                    Meta CAPI · pixel {d.config.pixel_id} · API {d.config.api_version} · {d.deliveries} entrega(s)
                  </div>
                </Td>
                <Td>
                  <Badge tone={d.status === "enabled" ? "ok" : d.status === "test_mode" ? "info" : "neutral"}>{{ disabled: "Desligado", test_mode: "Modo de teste", enabled: "Produção", awaiting_configuration: "Aguardando configuração" }[d.status as string]}</Badge>
                </Td>
                <Td>
                  <Select
                    aria-label="Emissor responsável"
                    value={d.purchase_emitter ?? ""}
                    disabled={!can("pixel.configure")}
                    onChange={(e) => act(() => api(`/v1/destinations/${d.id}`, { method: "PATCH", body: { purchase_emitter: e.target.value || null } }), "Emissor atualizado")}
                  >
                    <option value="">Não definido</option>
                    <option value="server">Servidor (este destino)</option>
                    <option value="browser">Navegador</option>
                    <option value="checkout_native">Pixel nativo do checkout</option>
                  </Select>
                  <p className="mt-1 text-xs text-muted">Defina um único emissor de Purchase; desative os demais para evitar duplicidade.</p>
                </Td>
                <Td>
                  {can("pixel.configure") && (
                    <div className="flex flex-wrap gap-2">
                      {d.status !== "test_mode" && <Button variant="secondary" onClick={() => act(() => api(`/v1/destinations/${d.id}`, { method: "PATCH", body: { status: "test_mode" } }), "Modo de teste ativado")}>Modo de teste</Button>}
                      {d.status === "test_mode" && <Button onClick={() => act(() => api(`/v1/destinations/${d.id}`, { method: "PATCH", body: { status: "enabled" } }), "Ativado em produção")}>Ativar produção</Button>}
                      {d.status !== "disabled" && <Button variant="danger" onClick={() => act(() => api(`/v1/destinations/${d.id}`, { method: "PATCH", body: { status: "disabled" } }), "Desligado")}>Desligar</Button>}
                      <Button variant="ghost" onClick={() => act(async () => { const r = await api<{ message: string }>(`/v1/destinations/${d.id}/test`, { method: "POST", body: {} }); toast({ tone: "ok", text: r.message }); }, "Teste solicitado")}>Testar</Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Card title="Entregas recentes" actions={<Button variant="secondary" onClick={deliveries.reload}>Atualizar</Button>}>
        {!deliveries.data?.deliveries.length ? (
          <Empty title="Nenhuma entrega" />
        ) : (
          <Table headers={["Quando", "Destino", "Evento", "Status", "Tentativas", "Resposta", ""]}>
            {deliveries.data.deliveries.map((d) => (
              <tr key={d.id}>
                <Td className="tabular text-xs">{dateTime(d.updated_at, org.organization.timezone)}</Td>
                <Td>{d.destination}</Td>
                <Td className="font-mono text-xs">{d.event_name} · {d.event_id}</Td>
                <Td>
                  <Badge tone={d.status === "accepted" ? "ok" : ["rejected", "expired"].includes(d.status) ? "err" : "warn"}>{DELIVERY_LABEL[d.status] ?? d.status}</Badge>
                  {d.not_eligible_reason && <div className="text-xs text-muted">{d.not_eligible_reason}</div>}
                </Td>
                <Td className="tabular">{d.attempts}</Td>
                <Td className="text-xs">{d.last_http_status ?? "—"} {d.last_provider_code && `· código ${d.last_provider_code}`} {d.last_trace_id && `· trace ${d.last_trace_id}`}</Td>
                <Td>{can("pixel.configure") && d.status !== "accepted" && <Button variant="ghost" onClick={() => act(() => api(`/v1/deliveries/${d.id}/resend`, { method: "POST", body: {} }), "Reenvio agendado (mesmo event_id)")}>Reenviar</Button>}</Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 text-xs text-muted">{deliveries.data?.note}</p>
      </Card>
    </div>
  );
}
