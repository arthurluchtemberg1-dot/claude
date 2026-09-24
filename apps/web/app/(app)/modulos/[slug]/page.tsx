import { notFound } from "next/navigation";
import { Badge, Card, PageHeader } from "@/components/ui";

/**
 * Módulos do escopo ainda não implementados: exibidos como planejados, com requisitos e etapa (R39-01).
 * Nenhuma tela simula funcionalidade inexistente.
 */
const MODULES: Record<string, { title: string; stage: string; reqs: string; summary: string; blockers?: string }> = {
  campanhas: { title: "Gestão de campanhas", stage: "E6", reqs: "R25-01..R25-11", summary: "Consulta, pausa/ativação, orçamento, duplicação e criação rápida somente nas redes com capacidade implementada e permissão de escrita.", blockers: "Leitura e escrita Meta exigem app aprovado e OAuth (DEP-META-APP)." },
  automacao: { title: "Motor de regras", stage: "E6", reqs: "R26-01..R26-13", summary: "Regras com simulação sem escrita, versões imutáveis, cooldown, tetos, locks e parada por regra/projeto/organização." },
  ia: { title: "Gestor com IA", stage: "E6", reqs: "R27-01..R27-12", summary: "Análises com ferramentas tipadas sobre o serviço de métricas; sem SQL arbitrário; estado indisponível sem chave configurada.", blockers: "Requer provedor/chave de IA configurados (DEP-AI)." },
  "whatsapp-crm": { title: "WhatsApp e CRM", stage: "E7", reqs: "R28-01..R29-09", summary: "Atribuição de conversas via APIs oficiais, CRM leve e recuperação com consentimento e revalidação antes do envio.", blockers: "Número e app na WhatsApp Business Platform (DEP-WHATSAPP)." },
  funis: { title: "Funis, VSL e experimentos", stage: "E7", reqs: "R30-01..R31-05", summary: "Etapas observadas, alocação estável de variantes e análise de criativos sem números inventados." },
  relatorios: { title: "Relatórios e exportações", stage: "E8", reqs: "R32-01..R32-10", summary: "Relatórios salvos, XLSX/PDF, links com expiração e agendamentos. Já disponível: exportação CSV de pedidos com neutralização de fórmulas." },
  assinatura: { title: "Assinatura da plataforma", stage: "E8", reqs: "R36-01..R36-07", summary: "Planos, trial, entitlements aplicados no servidor e metering idempotente. Modo de uso interno já disponível.", blockers: "Provedor de cobrança e decisões de preço (DEP-BILLING)." },
};

export default async function ModulePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const m = MODULES[slug];
  if (!m) notFound();
  return (
    <div className="space-y-4">
      <PageHeader title={m.title} description="Módulo do escopo ainda não implementado nesta versão." actions={<Badge>Planejado · {m.stage}</Badge>} />
      <Card title="O que será entregue">
        <p className="text-sm">{m.summary}</p>
        <p className="mt-2 text-xs text-muted">Requisitos: {m.reqs} (ver docs/REQUIREMENTS_TRACEABILITY.md).</p>
        {m.blockers && <p className="mt-2 text-xs text-warn">Dependência externa: {m.blockers}</p>}
      </Card>
    </div>
  );
}
