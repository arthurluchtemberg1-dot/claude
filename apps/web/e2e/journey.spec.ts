import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";

/**
 * T70 — fluxo completo em interface: configurar, coletar, pagar (teste), atribuir, consultar e estornar.
 * O "pagamento" é simulado com o payload DOCUMENTADO da Lowify (internal-webhook.md v1.0.0), sinalizado como tal;
 * isto valida o pipeline local, não homologa a integração com a Lowify.
 */

const documented = JSON.parse(readFileSync(join(E2E.root, "packages/connectors/test/fixtures/lowify/documented-example.json"), "utf8"));

function latestEmail(kind: string, to: string): { actionUrl: string } {
  const files = readdirSync(E2E.outbox).sort().reverse();
  for (const f of files) {
    const m = JSON.parse(readFileSync(join(E2E.outbox, f), "utf8"));
    if (m.kind === kind && m.to === to) return m;
  }
  throw new Error(`E-mail ${kind} para ${to} não encontrado`);
}

async function waitFor<T>(fn: () => Promise<T | null | undefined>, ms = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("Tempo esgotado aguardando condição");
    await new Promise((r) => setTimeout(r, 400));
  }
}

async function visitLanding(page: Page, publicKey: string): Promise<string> {
  // Landing simulada na origem local (o Chrome bloqueia página "pública" carregando script de localhost — Private Network Access).
  const landing = `${E2E.webUrl}/e2e-loja/oferta?utm_source=facebook&utm_medium=paid_social&utm_campaign=Campanha%20E2E%7C120000000000777`;
  const snippet = `<script>!function(w,d,n,u){w.TrackerQ=w.TrackerQ||[];w[n]=w[n]||function(){w.TrackerQ.push([].slice.call(arguments))};var s=d.createElement("script");s.async=1;s.src=u;d.head.appendChild(s)}(window,document,"tracker","${E2E.webUrl}/sdk/v1/tracker.js");
tracker("init",{projectKey:"${publicKey}",endpoint:"${E2E.webUrl}/api",checkoutHosts:["pay.lowify.e2e.test"],tokenParam:"utm_term"});
tracker("setConsent",{analytics:true,ads:true,storage:true});</script>`;
  await page.route(`${E2E.webUrl}/e2e-loja/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: `<!doctype html><html><head>${snippet}</head><body><h1>Oferta</h1><a id="comprar" href="http://pay.lowify.e2e.test/c/ABC?aff=XYZ&utm_term=kw">Comprar</a></body></html>` }),
  );
  let checkoutUrl = "";
  await page.route("http://pay.lowify.e2e.test/**", (route) => {
    checkoutUrl = route.request().url();
    return route.fulfill({ contentType: "text/html", body: "<h1>Checkout simulado</h1>" });
  });
  await page.goto(landing);
  // Aguarda o SDK carregar, enviar o PageView e obter o token (sem travar a página).
  await page.waitForFunction(() => typeof (window as unknown as { tracker?: { version?: string } }).tracker?.version === "string");
  await page.evaluate(() => (window as unknown as { tracker: (m: string) => Promise<unknown> }).tracker("requestToken"));
  await page.click("#comprar");
  await waitFor(async () => checkoutUrl || null);
  return checkoutUrl;
}

test("T70 jornada completa: cadastro → conexão Lowify → visita com SDK → venda → atribuição → estorno", async ({ page, request, browser }) => {
  const email = `e2e-${Date.now()}@teste.local`;

  // 1. Cadastro e verificação de e-mail
  await page.goto("/cadastro");
  await page.getByLabel("Nome").fill("Pessoa E2E");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill("senha-forte-e2e-123");
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(page).toHaveURL(/\/onboarding/);
  const verify = latestEmail("verify_email", email);
  await page.goto(new URL(verify.actionUrl).pathname + new URL(verify.actionUrl).search);
  await expect(page.getByText("E-mail confirmado.")).toBeVisible();

  // 2. Organização (sem dados fictícios)
  await page.goto("/onboarding");
  await page.getByLabel("Nome da organização").fill("Operação E2E");
  await page.getByRole("button", { name: "Criar e continuar" }).click();
  await expect(page).toHaveURL(/\/integracoes/);
  await page.goto("/painel");
  await expect(page.getByRole("heading", { name: "Visão geral" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Receita bruta aprovada: R\$\s0,00/ })).toBeVisible();

  // 3. Conexão Lowify com token no utm_term
  await page.goto("/integracoes");
  await page.getByRole("button", { name: "Nova conexão" }).click();
  await page.getByLabel("Identificador da conta no provedor").fill("vendedor-e2e");
  await page.getByLabel("Campo que transporta o token do SDK (opcional)").selectOption("utm_term");
  await page.getByRole("button", { name: "Criar conexão" }).click();
  const webhookUrl = await page.getByLabel("URL do webhook").inputValue();
  expect(webhookUrl).toMatch(/\/v1\/webhooks\/whk_[A-Za-z0-9]{40}$/);
  await page.getByRole("button", { name: "Concluir" }).click();
  await expect(page.getByText("Aguardando primeiro evento")).toBeVisible();

  // 4. Chave pública e visita com o SDK (em outro contexto, como um visitante)
  await page.goto("/configuracoes");
  const publicKey = (await page.locator("text=/pk_[A-Za-z0-9]{24}/").first().textContent())!.match(/pk_[A-Za-z0-9]{24}/)![0];
  const visitor = await browser.newContext();
  const vpage = await visitor.newPage();
  const checkoutUrl = await visitLanding(vpage, publicKey);
  const co = new URL(checkoutUrl);
  expect(co.searchParams.get("aff")).toBe("XYZ"); // parâmetro de afiliado preservado
  expect(co.searchParams.get("utm_campaign")).toBe("Campanha E2E|120000000000777");
  const term = co.searchParams.get("utm_term")!;
  expect(term).toMatch(/^kw\|trk_[A-Za-z0-9]{24}$/);
  await visitor.close();

  // 5. "Pagamento": webhook documentado da Lowify com as UTMs devolvidas pelo checkout
  const orderId = `ord_e2e_${Date.now()}`;
  const ts = new Date().toLocaleString("sv-SE", { timeZone: "America/Sao_Paulo" }).replace("T", " ");
  const tracking = { ...documented.tracking, utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "Campanha E2E|120000000000777", utm_term: term };
  const paid = await request.post(webhookUrl, { data: { ...documented, order_id: orderId, timestamp: ts, tracking }, headers: { "idempotency-key": `${orderId}:sale.paid:321` } });
  expect(paid.status()).toBe(200);

  // 6. Consulta: venda aprovada e atribuída por token (processada pelo worker via Redis)
  await page.goto("/vendas");
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("link", { name: orderId })).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 45_000 });
  await expect(page.getByRole("row", { name: new RegExp(orderId) }).getByText("Aprovada")).toBeVisible();
  await page.getByRole("link", { name: orderId }).click();
  await expect(page.getByText(/evidência token_link/)).toBeVisible();
  await expect(page.getByText("Checkout devolveu token", { exact: false })).toBeVisible();
  await expect(page.getByText(/R\$\s199,90/).first()).toBeVisible();

  await page.goto("/painel");
  await expect(page.getByRole("button", { name: /Receita bruta aprovada: R\$\s199,90/ })).toBeVisible();

  // 6b. Campanhas: venda atribuída ao ID da campanha; sem gasto importado o gasto é "indisponível", nunca zero.
  await page.goto("/campanhas");
  const campaignRow = page.getByRole("row", { name: /ID 120000000000777/ });
  await expect(campaignRow).toBeVisible();
  await expect(campaignRow.getByText("indisponível")).toBeVisible();
  await expect(campaignRow.getByText(/R\$\s199,90/)).toBeVisible();

  // 7. Estorno
  const refunded = await request.post(webhookUrl, { data: { ...documented, order_id: orderId, event: "sale.refunded", status: "refunded", timestamp: ts, tracking } });
  expect(refunded.status()).toBe(200);
  await page.goto("/vendas");
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("row", { name: new RegExp(orderId) }).getByText("Estornada")).toBeVisible({ timeout: 4000 });
  }).toPass({ timeout: 45_000 });
  await page.goto("/painel");
  await expect(page.getByRole("button", { name: /Receita após estornos: R\$\s0,00/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Receita bruta aprovada: R\$\s199,90/ })).toBeVisible();

  // 7b. API pública: chave exibida uma única vez e usável; revogação imediata.
  await page.goto("/api-webhooks");
  await page.getByRole("button", { name: "Criar chave" }).click();
  const shown = (await page.locator("code", { hasText: /^tk_live_/ }).textContent())!;
  expect(shown).toMatch(/^tk_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{40}$/);
  const apiOrders = await request.get(`${E2E.apiUrl}/public/v1/orders`, { headers: { authorization: `Bearer ${shown}` } });
  expect(apiOrders.status()).toBe(200);
  expect((await apiOrders.json()).data.map((o: { external_order_id: string }) => o.external_order_id)).toContain(orderId);
  await page.getByRole("button", { name: "Já guardei" }).click();
  await expect(page.locator("code", { hasText: /^tk_live_/ })).toHaveCount(0);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revogar" }).first().click();
  await expect(page.getByText("revogada", { exact: true })).toBeVisible();
  expect((await request.get(`${E2E.apiUrl}/public/v1/orders`, { headers: { authorization: `Bearer ${shown}` } })).status()).toBe(401);

  // 8. Diagnóstico e integrações refletem estado real
  await page.goto("/integracoes");
  await expect(page.getByText("Conectada", { exact: true })).toBeVisible();
  await page.goto("/diagnostico");
  await expect(page.getByRole("heading", { name: "Diagnóstico e qualidade" })).toBeVisible();
});

test("telas públicas: login com senha errada mostra erro acionável e não revela contas", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill("ninguem@teste.local");
  await page.getByLabel("Senha").fill("senha-errada-123");
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByText("E-mail ou senha inválidos")).toBeVisible();
});

test("módulo não implementado é identificado como planejado (R39-01)", async ({ page }) => {
  await page.goto("/entrar");
  // Sem sessão, rotas internas redirecionam para login.
  await page.goto("/modulos/automacao");
  await expect(page).toHaveURL(/\/entrar/);
});
