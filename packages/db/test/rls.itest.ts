import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DB } from "../../../test/env";
import { createPool, withTx } from "../src";

/**
 * Testes independentes de isolamento direto no banco (R40-02, T52, T54): executados com os papéis reais
 * tracker_app e tracker_system, sem passar pela API.
 */

const admin = new pg.Pool({ connectionString: TEST_DB.admin });
const app = createPool(TEST_DB.app);
const system = createPool(TEST_DB.system);

let orgA: string, orgB: string, userA: string, projectA: string, projectB: string;

async function seedOrg(label: string) {
  const user = (await admin.query("insert into iam.users (email, password_hash, display_name) values ($1, 'x', $2) returning id", [`${label}-${randomUUID()}@teste.local`, label])).rows[0].id as string;
  const org = (await admin.query("insert into public.organizations (name, slug) values ($1, $2) returning id", [label, `${label}-${randomUUID().slice(0, 8)}`])).rows[0].id as string;
  await admin.query("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'owner')", [org, user]);
  const project = (await admin.query("insert into public.projects (organization_id, name, public_key) values ($1, 'P', $2) returning id", [org, `pk_${randomUUID().replace(/-/g, "").slice(0, 24)}`])).rows[0].id as string;
  return { user, org, project };
}

beforeAll(async () => {
  const a = await seedOrg("org-a");
  const b = await seedOrg("org-b");
  [orgA, userA, projectA] = [a.org, a.user, a.project];
  [orgB, projectB] = [b.org, b.project];
});

afterAll(async () => {
  await Promise.all([admin.end(), app.end(), system.end()]);
});

describe("RLS com papel tracker_app", () => {
  it("membro lê somente a própria organização", async () => {
    const rows = await withTx(app, { organizationId: orgA, userId: userA }, async (c) => (await c.query("select id from public.projects")).rows);
    expect(rows.map((r) => r.id)).toEqual([projectA]);
  });

  it("T52 contexto de outra organização sem associação não retorna nada (IDOR)", async () => {
    const rows = await withTx(app, { organizationId: orgB, userId: userA }, async (c) => (await c.query("select id from public.projects where id = $1", [projectB])).rows);
    expect(rows).toEqual([]);
  });

  it("T52 escrita em outra organização é bloqueada pela política", async () => {
    await expect(
      withTx(app, { organizationId: orgA, userId: userA }, (c) =>
        c.query("insert into public.projects (organization_id, name, public_key) values ($1, 'x', $2)", [orgB, `pk_${randomUUID().replace(/-/g, "").slice(0, 24)}`]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("sem contexto de organização nada é visível", async () => {
    const rows = await withTx(app, null, async (c) => (await c.query("select id from public.projects")).rows);
    expect(rows).toEqual([]);
  });

  it("credenciais e IAM não são acessíveis ao papel da API", async () => {
    await expect(withTx(app, { organizationId: orgA, userId: userA }, (c) => c.query("select * from private.credentials"))).rejects.toThrow(/permission denied/);
    await expect(withTx(app, { organizationId: orgA, userId: userA }, (c) => c.query("select * from iam.users"))).rejects.toThrow(/permission denied/);
  });

  it("razão financeira é somente leitura para a API", async () => {
    await expect(
      withTx(app, { organizationId: orgA, userId: userA }, (c) => c.query("delete from public.financial_entries")),
    ).rejects.toThrow(/permission denied/);
  });

  it("T54 remoção da associação revoga acesso imediatamente, inclusive para sessões existentes", async () => {
    const extra = (await admin.query("insert into iam.users (email, password_hash, display_name) values ($1, 'x', 'tmp') returning id", [`tmp-${randomUUID()}@teste.local`])).rows[0].id as string;
    await admin.query("insert into public.memberships (organization_id, user_id, role) values ($1, $2, 'analyst')", [orgA, extra]);
    const before = await withTx(app, { organizationId: orgA, userId: extra }, async (c) => (await c.query("select count(*)::int as n from public.projects")).rows[0].n);
    expect(before).toBe(1);
    await admin.query("update public.memberships set status = 'removed' where organization_id = $1 and user_id = $2", [orgA, extra]);
    const after = await withTx(app, { organizationId: orgA, userId: extra }, async (c) => (await c.query("select count(*)::int as n from public.projects")).rows[0].n);
    expect(after).toBe(0);
  });
});

describe("RLS com papel tracker_system", () => {
  it("worker só enxerga a organização do contexto do job", async () => {
    const rows = await withTx(system, { organizationId: orgA }, async (c) => (await c.query("select organization_id from public.projects")).rows);
    expect(rows.every((r) => r.organization_id === orgA)).toBe(true);
    const cross = await withTx(system, { organizationId: orgA }, async (c) => (await c.query("select id from public.projects where id = $1", [projectB])).rows);
    expect(cross).toEqual([]);
  });

  it("chave estrangeira composta impede vínculo entre organizações", async () => {
    // Conexão da org A apontando para projeto da org B: FK (organization_id, project_id) falha.
    await expect(
      admin.query("insert into public.provider_connections (organization_id, project_id, provider, kind, name) values ($1, $2, 'lowify', 'checkout', 'x')", [orgA, projectB]),
    ).rejects.toThrow(/foreign key/);
  });

  it("T03 unicidade de recebimento garantida pelo banco sob concorrência", async () => {
    const acct = (await admin.query("insert into public.provider_accounts (organization_id, project_id, provider, external_account_id, display_name) values ($1, $2, 'lowify', $3, 'Conta') returning id", [orgA, projectA, `acct-${randomUUID()}`])).rows[0].id as string;
    const conn = (await admin.query("insert into public.provider_connections (organization_id, project_id, provider_account_id, provider, kind, name) values ($1, $2, $3, 'lowify', 'checkout', 'c') returning id", [orgA, projectA, acct])).rows[0].id as string;
    const insert = () =>
      withTx(system, { organizationId: orgA }, (c) =>
        c.query(
          `insert into public.webhook_receipts (organization_id, project_id, connection_id, provider, provider_account_id, dedup_key, dedup_method, body, body_sha256, auth_method)
           values ($1, $2, $3, 'lowify', $4, 'same-key', 'fingerprint', '\\x7b7d', '\\x00', 'test')
           on conflict (organization_id, provider_account_id, dedup_key) do update set delivery_count = webhook_receipts.delivery_count + 1
           returning (xmax = 0) as inserted`,
          [orgA, projectA, conn, acct],
        ),
      );
    const results = await Promise.all(Array.from({ length: 10 }, insert));
    expect(results.filter((r) => r.rows[0].inserted).length).toBe(1);
    const count = (await admin.query("select count(*)::int as n, max(delivery_count) as d from public.webhook_receipts where provider_account_id = $1", [acct])).rows[0];
    expect(count.n).toBe(1);
    expect(count.d).toBe(10);
  });
});
