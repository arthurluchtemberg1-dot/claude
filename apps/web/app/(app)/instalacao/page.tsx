"use client";

import { useState } from "react";
import { useSession } from "@/components/shell";
import { Alert, Badge, Button, Card, CopyButton, Field, Input, PageHeader, Select, Textarea } from "@/components/ui";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";

/* eslint-disable @typescript-eslint/no-explicit-any */

const PLATFORMS: { id: string; label: string; steps: string[] }[] = [
  { id: "html", label: "HTML", steps: ["Cole o código antes de </head> em todas as páginas.", "Publique e abra a página com ?utm_source=teste para gerar um evento de teste."] },
  { id: "wordpress", label: "WordPress/Elementor", steps: ["Use um plugin de inserção de código no cabeçalho (ou tema filho) e cole o código.", "Elementor: Configurações do site → Código personalizado → <head>."] },
  { id: "gtm", label: "Google Tag Manager", steps: ["Crie uma tag HTML personalizada com o código.", "Acionador: All Pages. Se usar CMP no GTM, dispare setConsent após o consentimento."] },
  { id: "next", label: "React/Next.js", steps: ["Adicione com next/script (strategy=\"afterInteractive\") no layout raiz.", "Mudanças de rota SPA são detectadas automaticamente."] },
  { id: "webflow", label: "Webflow/Wix", steps: ["Configurações do site → Custom code → Head code.", "Wix: requer plano que permita código personalizado."] },
  { id: "shopify", label: "Shopify/WooCommerce", steps: ["Instale no tema (theme.liquid) ou via plugin de cabeçalho.", "O checkout hospedado pode não permitir scripts de terceiros; a venda é confirmada pelo webhook do checkout."] },
  { id: "typebot", label: "Typebot/construtores", steps: ["Somente construtores que permitem script no <head> são suportados.", "Em iframes, use o adaptador postMessage com origem declarada."] },
];

export default function InstallPage() {
  const { org } = useSession();
  const projects = useApi<{ projects: { id: string; name: string; public_key: string; allowed_origins: string[] }[] }>("/v1/projects");
  const diag = useApi<any>("/v1/diagnostics/overview");
  const [projectId, setProjectId] = useState<string>("");
  const [hosts, setHosts] = useState("pay.lowify.com.br");
  const [carrier, setCarrier] = useState("utm_term");
  const [platform, setPlatform] = useState("html");
  const project = projects.data?.projects.find((p) => p.id === projectId) ?? projects.data?.projects[0];
  // Domínio de coleta: por padrão o próprio painel (rewrite /api → API). Pode ser um domínio próprio verificado.
  const endpoint = process.env.NEXT_PUBLIC_COLLECT_URL ?? (typeof window !== "undefined" ? `${window.location.origin}/api` : "");
  const sdkUrl = process.env.NEXT_PUBLIC_SDK_URL ?? (typeof window !== "undefined" ? `${window.location.origin}/sdk/v1/tracker.js` : "");
  const checkoutHosts = hosts.split(",").map((h) => h.trim()).filter(Boolean);
  const snippet = project
    ? `<script>!function(w,d,n,u){w.TrackerQ=w.TrackerQ||[];w[n]=w[n]||function(){w.TrackerQ.push([].slice.call(arguments))};var s=d.createElement("script");s.async=1;s.src=u;d.head.appendChild(s)}(window,document,"tracker","${sdkUrl}");
tracker("init",{projectKey:"${project.public_key}",endpoint:"${endpoint}",checkoutHosts:${JSON.stringify(checkoutHosts)}${carrier ? `,tokenParam:"${carrier}"` : ""}});
// Após o consentimento do visitante (CMP/banner): tracker("setConsent",{analytics:true,ads:true,storage:true});</script>`
    : "";
  const t = diag.data?.tracking;

  return (
    <div className="space-y-4">
      <PageHeader title="Instalação do SDK" description="Código copiado não significa rastreamento validado: confirme abaixo o recebimento real de eventos." />
      <Card title="1. Código de instalação">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label="Projeto">
            {(id) => (
              <Select id={id} value={project?.id ?? ""} onChange={(e) => setProjectId(e.target.value)}>
                {projects.data?.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Domínios do checkout" hint="Separados por vírgula; links para esses domínios recebem UTMs e token.">
            {(id) => <Input id={id} value={hosts} onChange={(e) => setHosts(e.target.value)} />}
          </Field>
          <Field label="Parâmetro do token" hint="Deve coincidir com o campo configurado na conexão do checkout.">
            {(id) => (
              <Select id={id} value={carrier} onChange={(e) => setCarrier(e.target.value)}>
                <option value="">trk (padrão, checkout precisa devolver)</option>
                {["utm_term", "utm_content"].map((u) => (
                  <option key={u}>{u}</option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {project && (
          <div className="mt-3 space-y-2">
            <p className="text-sm">
              Chave pública do projeto: <span className="font-mono">{project.public_key}</span> <Badge>não é segredo; não autentica vendas</Badge>
            </p>
            <Textarea readOnly rows={5} value={snippet} aria-label="Código de instalação" />
            <CopyButton value={snippet} label="Copiar código" />
          </div>
        )}
        <Alert tone="info" title="Consentimento">
          Por padrão nada é armazenado sem o sinal de consentimento de analytics; sinais de publicidade (_fbp/_fbc, IP, navegador) exigem consentimento de publicidade. Integre o setConsent ao seu banner/CMP.
        </Alert>
      </Card>
      <Card title="2. Instruções por plataforma">
        <div className="flex flex-wrap gap-2">
          {PLATFORMS.map((p) => (
            <Button key={p.id} variant={platform === p.id ? "primary" : "secondary"} onClick={() => setPlatform(p.id)}>
              {p.label}
            </Button>
          ))}
        </div>
        <ol className="mt-3 list-decimal pl-5 text-sm">
          {PLATFORMS.find((p) => p.id === platform)!.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </Card>
      <Card title="3. Verificação de recebimento" actions={<Button variant="secondary" onClick={diag.reload}>Atualizar</Button>}>
        {t ? (
          <ul className="space-y-1 text-sm">
            <li>
              <Badge tone={t.last_event_at ? "ok" : "warn"}>{t.last_event_at ? "evento recebido" : "nenhum evento"}</Badge> Último evento: {dateTime(t.last_event_at, org.organization.timezone)}
            </li>
            <li>Sessões (7 dias): {t.sessions_7d} · Eventos (7 dias): {t.events_7d}</li>
            <li>Tokens emitidos (7 dias): {t.tokens_7d} · Tokens vinculados a pedidos (30 dias): {t.tokens_linked_30d}</li>
          </ul>
        ) : (
          <p className="text-sm text-muted">Carregando…</p>
        )}
        <p className="mt-2 text-xs text-muted">A passagem até o checkout é validada somente quando uma venda de teste autorizada retorna o token/UTMs (ver diagnóstico do pedido).</p>
      </Card>
    </div>
  );
}
