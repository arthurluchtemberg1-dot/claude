/**
 * Gera docs/METRICS_DICTIONARY.md a partir do registro único de métricas (packages/domain/src/metrics/definitions.ts).
 * Uso: pnpm docs:metrics
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { METRIC_DEFINITIONS } from "../packages/domain/src/metrics/definitions";

const BASIS: Record<string, string> = { approval: "por aprovação", financial_movement: "por movimento financeiro", acquisition_cohort: "por coorte de aquisição" };
const esc = (s: string | null | undefined) => (s ?? "—").replace(/\|/g, "\\|");

let md = `# Dicionário de métricas\n\n`;
md += `> Gerado por \`pnpm docs:metrics\` a partir de \`packages/domain/src/metrics/definitions.ts\` (fonte única usada por API, painel e testes; R22-01).\n\n`;
md += `## Princípios\n\n`;
md += `- Dinheiro em inteiros na menor unidade da moeda (\`bigint\`); razões como frações exatas, arredondadas só na apresentação.\n`;
md += `- Denominador zero → **indefinido** ("—") com motivo; dado ausente → **indisponível** (nunca zero). Qualidade: completo, parcial ou estimado.\n`;
md += `- Moedas nunca são somadas sem câmbio identificado e datado; sem câmbio, cada moeda é exibida separadamente.\n`;
md += `- Períodos locais no fuso da organização convertidos para UTC como intervalo \`[início, fim)\`.\n`;
md += `- Bases temporais: **por aprovação** (pedidos pela primeira confirmação no período; estornos da coorte até \`as_of\`), **por movimento financeiro** (cada lançamento na data em que ocorreu) e **por coorte de aquisição** (atualmente igual à base por aprovação; receita posterior de clientes requer identidade de cliente — pendente).\n`;
md += `- Atribuição: ROAS/CPA usam os pedidos creditados pela política selecionada (padrão: último clique pago elegível, 7 dias). Modelos fracionados são rotulados como "conversões creditadas".\n`;
md += `- Gasto: um único nível por conta de anúncios (conta > campanha > conjunto > anúncio) e uma única fonte por entidade/dia (API > CSV > manual), evitando dupla contagem; reimportação substitui o snapshot.\n\n`;
md += `## Fixture obrigatória (R43-02)\n\n`;
md += `Pedidos de R$100 e R$50 aprovados, taxas R$5, investimento R$30, estorno parcial de R$20 e integral de R$50 → receita bruta R$150, estornos R$70, após estornos R$80, 2 aprovados, 1 retido, CPA aprovado R$15, CPA retido R$30, ticket R$75, ROAS bruto 5, ROAS após estornos 80/30, contribuição R$45. `;
md += `Verificada em \`packages/domain/test/metrics-fixture.test.ts\` e ponta a ponta via webhooks + API em \`apps/api/test/integration/webhook-pipeline.test.ts\`, com repetição de todos os webhooks.\n\n`;
md += `## Métricas\n\n| ID | Métrica | Unidade | Fórmula | Denominador | Fonte | Estornos | Bases | Observações |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
for (const d of Object.values(METRIC_DEFINITIONS)) {
  md += `| \`${d.id}\` | ${esc(d.label)} | ${d.unit} | ${esc(d.formula)} | ${esc(d.denominator)} | ${esc(d.source)} | ${esc(d.refundPolicy)} | ${d.bases.map((b) => BASIS[b]).join(", ")} | ${esc(d.notes)} |\n`;
}
writeFileSync(join(import.meta.dirname, "..", "docs/METRICS_DICTIONARY.md"), md);
console.log(`docs/METRICS_DICTIONARY.md: ${Object.keys(METRIC_DEFINITIONS).length} métricas`);
