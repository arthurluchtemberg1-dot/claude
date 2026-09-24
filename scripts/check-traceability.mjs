#!/usr/bin/env node
/**
 * Gera docs/REQUIREMENTS_TRACEABILITY.md a partir de docs/PRD.md + docs/traceability/status.json e falha se:
 * - algum requisito do PRD não estiver no status (ou vice-versa);
 * - algum cenário T01–T70 estiver ausente;
 * - houver estado inválido.
 * Uso: pnpm traceability   (edite status.json e rode novamente)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prd = readFileSync(join(root, "docs/PRD.md"), "utf8");
const status = JSON.parse(readFileSync(join(root, "docs/traceability/status.json"), "utf8"));
const STATES = {
  done: "✅ Implementado localmente",
  partial: "🟡 Parcial",
  blocked: "⛔ Bloqueado externamente",
  planned: "⏳ Planejado",
  process: "📄 Método/documento",
  validated_sandbox: "🧪 Validado em sandbox",
  validated_production: "🏁 Validado em produção",
};
const TEST_STATES = { done: "✅ Automatizado e executado", partial: "🟡 Parcial", planned: "⏳ Planejado", blocked: "⛔ Bloqueado" };

const text = new Map();
const sectionTitle = new Map();
let currentSection = "";
for (const line of prd.split("\n")) {
  const h = /^## (\d{2}(?:–\d{2})?\.|Anexos)(.*)$/.exec(line);
  if (h) currentSection = (h[1] + h[2]).trim();
  const m = /^- \*\*(R[0-9A-C]+-\d+)\*\* — (.*)$/.exec(line);
  if (m) {
    text.set(m[1], m[2]);
    sectionTitle.set(m[1], currentSection);
  }
}
const errors = [];
const byId = new Map(status.requirements.map((r) => [r.id, r]));
for (const id of text.keys()) if (!byId.has(id)) errors.push(`Requisito ${id} do PRD ausente em status.json`);
for (const id of byId.keys()) if (!text.has(id)) errors.push(`Requisito ${id} em status.json não existe no PRD`);
for (const r of status.requirements) if (!STATES[r.status]) errors.push(`Estado inválido em ${r.id}: ${r.status}`);
const tests = new Map(status.tests.map((t) => [t.id, t]));
for (let i = 1; i <= 70; i++) {
  const id = `T${String(i).padStart(2, "0")}`;
  if (!tests.has(id)) errors.push(`Cenário ${id} ausente`);
  else if (!TEST_STATES[tests.get(id).status]) errors.push(`Estado inválido em ${id}`);
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}

const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const short = (s, n = 140) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const count = (arr, key) => arr.reduce((a, r) => ((a[r[key]] = (a[r[key]] ?? 0) + 1), a), {});
const reqCount = count(status.requirements, "status");
const testCount = count(status.tests, "status");

let md = `# Matriz de rastreabilidade de requisitos\n\n`;
md += `> Arquivo **gerado** por \`pnpm traceability\` a partir de [\`PRD.md\`](PRD.md) e [\`traceability/status.json\`](traceability/status.json). `;
md += `Edite o JSON e regenere; o comando falha se algum requisito do PRD ou cenário T01–T70 desaparecer.\n\n`;
md += `Atualizado em: ${status.updated}. Estados de requisito conforme R11-03/R46-01: "Implementado localmente" = código + testes executados neste repositório; `;
md += `não significa validado com o provedor externo.\n\n`;
md += `## Resumo\n\n| Estado | Requisitos |\n| --- | --- |\n`;
for (const [k, v] of Object.entries(STATES)) if (reqCount[k]) md += `| ${v} | ${reqCount[k]} |\n`;
md += `| **Total** | **${status.requirements.length}** |\n\n| Cenários de teste (seção 43) | Quantidade |\n| --- | --- |\n`;
for (const [k, v] of Object.entries(TEST_STATES)) if (testCount[k]) md += `| ${v} | ${testCount[k]} |\n`;
md += `\n## Cenários obrigatórios T01–T70\n\n| ID | Estado | Evidência / pendência |\n| --- | --- | --- |\n`;
for (const t of status.tests) md += `| ${t.id} | ${TEST_STATES[t.status]} | ${esc(t.evidence)} |\n`;
md += `\n## Requisitos\n\nColunas: ID · requisito (resumo; texto completo no PRD) · etapa · estado · implementação · testes · dependência externa · observação.\n`;
let lastSection = "";
for (const r of status.requirements) {
  const sec = sectionTitle.get(r.id);
  if (sec !== lastSection) {
    md += `\n### ${sec}\n\n| ID | Requisito | Etapa | Estado | Implementação | Testes | Dependência | Observação |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
    lastSection = sec;
  }
  md += `| ${r.id} | ${esc(short(text.get(r.id)))} | ${r.stage} | ${STATES[r.status]} | ${esc(r.impl)} | ${esc(r.tests)} | ${esc(r.dep)} | ${esc(r.note)} |\n`;
}
writeFileSync(join(root, "docs/REQUIREMENTS_TRACEABILITY.md"), md);
console.log(`OK: ${status.requirements.length} requisitos, ${status.tests.length} cenários. ${JSON.stringify(reqCount)}`);
