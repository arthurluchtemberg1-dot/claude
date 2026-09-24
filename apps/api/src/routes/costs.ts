import { createHash } from "node:crypto";
import { formatMinorAsDecimal, isSupportedCurrency, isValidTimeZone, parseDecimalToMinor, parseLocalDate } from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { parseCsv, toCsv } from "../lib/csv";
import { badRequest, notFound } from "../lib/errors";
import { audit, jsonSafe, orgTx } from "../lib/org-tx";
import { assertPermission } from "../services/auth";

/**
 * Custos sem API e importação de gastos por CSV com prévia, mapeamento, moeda, fuso, validação e prevenção
 * de duplicidade (R20-04..R20-06, T45); tabelas de taxas e câmbio versionados (R22-06, R22-10); exportação segura (T66).
 */

const currency = z.string().regex(/^[A-Z]{3}$/).refine(isSupportedCurrency, "Moeda não suportada");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const mappingSchema = z.object({
  date: z.string().min(1),
  spend: z.string().min(1),
  entity_id: z.string().min(1).optional(),
  entity_name: z.string().min(1).optional(),
  campaign_id: z.string().min(1).optional(),
  impressions: z.string().min(1).optional(),
  link_clicks: z.string().min(1).optional(),
});

interface SpendPreviewRow {
  line: number;
  date: string;
  entity_id: string;
  entity_name: string | null;
  campaign_id: string | null;
  spend_minor: string;
  impressions: string | null;
  link_clicks: string | null;
}

function normalizeDecimal(v: string): string {
  const t = v.trim().replace(/\s/g, "");
  // "1.234,56" → "1234.56"; "1234,56" → "1234.56"; "1234.56" mantém.
  if (/,\d{1,2}$/.test(t)) return t.replace(/\./g, "").replace(",", ".");
  return t.replace(/,/g, "");
}

function normalizeDate(v: string): string | null {
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

export function buildSpendPreview(csv: string, mapping: z.infer<typeof mappingSchema>, cur: string, level: string) {
  const { header, rows } = parseCsv(csv, 50_000);
  const idx = (col?: string) => (col ? header.indexOf(col) : -1);
  const missing = Object.entries(mapping).filter(([, col]) => col && idx(col) < 0).map(([k, col]) => `${k} → "${col}"`);
  if (missing.length) throw badRequest("mapping_invalid", `Colunas não encontradas: ${missing.join(", ")}`, { header });
  const out: SpendPreviewRow[] = [];
  const errors: { line: number; message: string }[] = [];
  const seen = new Map<string, number>();
  rows.forEach((r, i) => {
    const line = i + 2;
    const d = normalizeDate(r[idx(mapping.date)] ?? "");
    if (!d) return errors.push({ line, message: "Data inválida (use AAAA-MM-DD ou DD/MM/AAAA)" });
    try {
      parseLocalDate(d);
    } catch {
      return errors.push({ line, message: "Data inexistente" });
    }
    const entity = level === "account" ? "account" : (r[idx(mapping.entity_id)] ?? "").trim();
    if (!entity) return errors.push({ line, message: "ID da entidade ausente" });
    let spend: bigint;
    try {
      spend = parseDecimalToMinor(normalizeDecimal(r[idx(mapping.spend)] ?? ""), cur);
    } catch (e) {
      return errors.push({ line, message: `Gasto inválido: ${(e as Error).message}` });
    }
    if (spend < 0n) return errors.push({ line, message: "Gasto negativo" });
    const key = `${entity}|${d}`;
    if (seen.has(key)) return errors.push({ line, message: `Duplicado no arquivo (mesma entidade e data da linha ${seen.get(key)})` });
    seen.set(key, line);
    const int = (col?: string) => {
      const v = col ? (r[idx(col)] ?? "").trim().replace(/[.\s]/g, "") : "";
      return /^\d+$/.test(v) ? v : null;
    };
    out.push({
      line,
      date: d,
      entity_id: entity,
      entity_name: mapping.entity_name ? (r[idx(mapping.entity_name)] ?? "").slice(0, 200) || null : null,
      campaign_id: mapping.campaign_id ? (r[idx(mapping.campaign_id)] ?? "").trim() || null : null,
      spend_minor: spend.toString(),
      impressions: int(mapping.impressions),
      link_clicks: int(mapping.link_clicks),
    });
  });
  return { header, rows: out, errors };
}

export const costRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    app.get("/ad-accounts", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => jsonSafe({ ad_accounts: (await c.query("select id, project_id, network, external_account_id, name, currency, timezone, status, last_synced_at, synced_from, synced_to, connection_id from public.ad_accounts order by created_at")).rows }));
    });

    // Conta de anúncios cadastrada manualmente (para importação CSV quando não há API conectada).
    app.post("/ad-accounts", async (req, reply) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z
        .object({
          network: z.enum(["meta", "google", "tiktok", "microsoft", "pinterest", "linkedin", "snapchat", "kwai", "taboola", "outbrain", "manual"]),
          external_account_id: z.string().trim().min(1).max(100),
          name: z.string().trim().min(1).max(120),
          currency,
          timezone: z.string().refine(isValidTimeZone, "Fuso inválido"),
          project_id: z.string().uuid().nullable().default(null),
        })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          `insert into public.ad_accounts (organization_id, project_id, network, external_account_id, name, currency, timezone, status) values ($1,$2,$3,$4,$5,$6,$7,'manual_import')
           on conflict (organization_id, network, external_account_id) do update set name = excluded.name returning id`,
          [org.id, body.project_id, body.network, body.external_account_id, body.name, body.currency, body.timezone],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "ad_account.created", targetType: "ad_account", targetId: r.rows[0].id, requestId: req.id });
        return reply.status(201).send({ id: r.rows[0].id });
      });
    });

    app.post("/imports/spend/preview", { bodyLimit: 10 * 1024 * 1024 }, async (req) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z
        .object({ ad_account_id: z.string().uuid(), level: z.enum(["account", "campaign", "adset", "ad"]), csv: z.string().min(1).max(10 * 1024 * 1024), mapping: mappingSchema, filename: z.string().max(200).optional() })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const acc = (await c.query("select id, currency, timezone from public.ad_accounts where id = $1", [body.ad_account_id])).rows[0];
        if (!acc) throw notFound("Conta de anúncios não encontrada");
        const cur = String(acc.currency).trim();
        const preview = buildSpendPreview(body.csv, body.mapping, cur, body.level);
        const sha = createHash("sha256").update(body.csv).digest("hex");
        const existing = preview.rows.length
          ? (
              await c.query(
                `select count(*)::int as n from public.ad_spend_daily where ad_account_id = $1 and level = $2 and source = 'csv' and (entity_external_id, spend_date) in (select * from unnest($3::text[], $4::date[]))`,
                [acc.id, body.level, preview.rows.map((r) => r.entity_id), preview.rows.map((r) => r.date)],
              )
            ).rows[0].n
          : 0;
        const imp = await c.query(
          `insert into public.cost_imports (organization_id, kind, filename, file_sha256, status, row_count, error_count, mapping, timezone, created_by)
           values ($1, 'ad_spend', $2, $3, 'previewed', $4, $5, $6, $7, $8) returning id`,
          [org.id, body.filename ?? null, sha, preview.rows.length, preview.errors.length, JSON.stringify({ ...body.mapping, level: body.level, ad_account_id: acc.id, rows: preview.rows }), acc.timezone, auth.userId],
        );
        const total = preview.rows.reduce((a, r) => a + BigInt(r.spend_minor), 0n);
        return jsonSafe({
          import_id: imp.rows[0].id,
          currency: cur,
          timezone: acc.timezone,
          rows: preview.rows.slice(0, 50),
          row_count: preview.rows.length,
          errors: preview.errors.slice(0, 100),
          error_count: preview.errors.length,
          total_spend: formatMinorAsDecimal(total, cur),
          will_replace_existing: existing,
          period: preview.rows.length ? { from: preview.rows.map((r) => r.date).sort()[0], to: preview.rows.map((r) => r.date).sort().at(-1) } : null,
        });
      });
    });

    app.post("/imports/:id/commit", async (req) => {
      assertPermission(req.auth, req.org, "costs.write");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const imp = (await c.query("select * from public.cost_imports where id = $1 for update", [id])).rows[0];
        if (!imp) throw notFound();
        if (imp.status !== "previewed") throw badRequest("already_committed", "Importação já confirmada");
        const m = imp.mapping as { level: string; ad_account_id: string; rows: SpendPreviewRow[] };
        const acc = (await c.query("select id, project_id, currency, synced_from, synced_to from public.ad_accounts where id = $1", [m.ad_account_id])).rows[0];
        if (!acc) throw notFound("Conta de anúncios não encontrada");
        for (const r of m.rows) {
          // Reimportar substitui o snapshot (não soma) — T45.
          await c.query(
            `insert into public.ad_spend_daily (organization_id, project_id, ad_account_id, level, entity_external_id, campaign_external_id, spend_date, currency, spend_minor, impressions, link_clicks, source, import_id, snapshot_at)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'csv',$12, now())
             on conflict (organization_id, ad_account_id, level, entity_external_id, spend_date, source) do update set
               spend_minor = excluded.spend_minor, impressions = excluded.impressions, link_clicks = excluded.link_clicks, import_id = excluded.import_id, snapshot_at = now(), campaign_external_id = excluded.campaign_external_id`,
            [org.id, acc.project_id, acc.id, m.level, r.entity_id, r.campaign_id, r.date, acc.currency, BigInt(r.spend_minor), r.impressions, r.link_clicks, id],
          );
          if (m.level !== "account" && r.entity_name) {
            // Histórico de nomes por data da conta: renomear não quebra a junção por ID (T39).
            await c.query(
              `insert into public.ad_entity_names (organization_id, ad_account_id, level, external_id, name, first_seen_date, last_seen_date) values ($1,$2,$3,$4,$5,$6,$6)
               on conflict (organization_id, ad_account_id, level, external_id, name) do update set
                 first_seen_date = least(coalesce(public.ad_entity_names.first_seen_date, excluded.first_seen_date), excluded.first_seen_date),
                 last_seen_date = greatest(coalesce(public.ad_entity_names.last_seen_date, excluded.last_seen_date), excluded.last_seen_date)`,
              [org.id, acc.id, m.level, r.entity_id, r.entity_name, r.date],
            );
          }
        }
        if (m.level !== "account") {
          // Entidades declaradas pela própria organização (fonte csv); nome vigente = o da data mais recente do arquivo.
          const latest = new Map<string, SpendPreviewRow>();
          for (const r of m.rows) {
            const cur = latest.get(r.entity_id);
            if (!cur || r.date > cur.date) latest.set(r.entity_id, r);
          }
          for (const r of latest.values()) {
            await c.query(
              `insert into public.ad_entities (organization_id, ad_account_id, level, external_id, parent_external_id, name, source)
               values ($1,$2,$3,$4,$5,$6,'csv')
               on conflict (organization_id, ad_account_id, level, external_id) do update set
                 last_seen_at = now(), parent_external_id = coalesce(excluded.parent_external_id, public.ad_entities.parent_external_id),
                 name = case when public.ad_entities.source = 'api' then public.ad_entities.name else coalesce(excluded.name, public.ad_entities.name) end`,
              [org.id, acc.id, m.level, r.entity_id, m.level === "campaign" ? null : r.campaign_id, r.entity_name],
            );
          }
        }
        const dates = m.rows.map((r) => r.date).sort();
        if (dates.length) {
          await c.query(
            "update public.ad_accounts set synced_from = least(coalesce(synced_from, $2::date), $2::date), synced_to = greatest(coalesce(synced_to, $3::date), $3::date), last_synced_at = now() where id = $1",
            [acc.id, dates[0], dates[dates.length - 1]],
          );
        }
        await c.query("update public.cost_imports set status = 'committed', committed_at = now() where id = $1", [id]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "spend_import.committed", targetType: "cost_import", targetId: id, details: { rows: m.rows.length }, requestId: req.id });
        return { ok: true, rows: m.rows.length };
      });
    });

    app.get("/cost-entries", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => jsonSafe({ entries: (await c.query("select * from public.cost_entries order by period_start desc, created_at desc limit 500")).rows }));
    });

    app.post("/cost-entries", async (req, reply) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z
        .object({
          category: z.enum(["media_offline", "influencer", "affiliate", "boost", "product_cost", "shipping", "tax_estimate", "operating_expense", "tool", "other"]),
          description: z.string().trim().min(1).max(300),
          amount: z.string().regex(/^\d+(\.\d{1,2})?$/),
          currency,
          period_start: date,
          period_end: date,
          project_id: z.string().uuid().nullable().default(null),
          idempotency_key: z.string().max(100).optional(),
        })
        .parse(req.body);
      if (body.period_end < body.period_start) throw badRequest("invalid_period", "Fim do período anterior ao início");
      const amount = parseDecimalToMinor(body.amount, body.currency);
      const countsAsMedia = ["media_offline", "influencer", "affiliate", "boost"].includes(body.category);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const dedup = body.idempotency_key ?? createHash("sha256").update([body.category, body.description, body.amount, body.currency, body.period_start, body.period_end, body.project_id].join("|")).digest("hex");
        const r = await c.query(
          `insert into public.cost_entries (organization_id, project_id, category, counts_as_media, description, amount_minor, currency, period_start, period_end, source, dedup_key, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual',$10,$11) on conflict (organization_id, dedup_key) do nothing returning id`,
          [org.id, body.project_id, body.category, countsAsMedia, body.description, amount, body.currency, body.period_start, body.period_end, dedup, auth.userId],
        );
        if (!r.rows[0]) return reply.status(409).send({ error: { code: "duplicate", message: "Custo idêntico já cadastrado", request_id: req.id } });
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "cost_entry.created", targetType: "cost_entry", targetId: r.rows[0].id, details: { category: body.category, amount: body.amount, currency: body.currency }, requestId: req.id });
        return reply.status(201).send({ id: r.rows[0].id, counts_as_media: countsAsMedia });
      });
    });

    app.delete("/cost-entries/:id", async (req) => {
      assertPermission(req.auth, req.org, "costs.write");
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query("delete from public.cost_entries where id = $1 returning category, amount_minor, currency", [id]);
        if (!r.rows[0]) throw notFound();
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "cost_entry.deleted", targetType: "cost_entry", targetId: id, details: jsonSafe(r.rows[0]) as Record<string, unknown>, requestId: req.id });
        return { ok: true };
      });
    });

    app.get("/fee-schedules", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => jsonSafe({ fee_schedules: (await c.query("select * from public.fee_schedules order by valid_from desc")).rows }));
    });

    app.post("/fee-schedules", async (req, reply) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z
        .object({ name: z.string().trim().min(1).max(120), provider_account_id: z.string().uuid().nullable().default(null), percent_bp: z.number().int().min(0).max(10_000), fixed: z.string().regex(/^\d+(\.\d{1,2})?$/).default("0"), currency, valid_from: date, valid_to: date.nullable().default(null) })
        .parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          "insert into public.fee_schedules (organization_id, provider_account_id, name, percent_bp, fixed_minor, currency, valid_from, valid_to, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id",
          [org.id, body.provider_account_id, body.name, body.percent_bp, parseDecimalToMinor(body.fixed, body.currency), body.currency, body.valid_from, body.valid_to, auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "fee_schedule.created", targetType: "fee_schedule", targetId: r.rows[0].id, details: body, requestId: req.id });
        return reply.status(201).send({ id: r.rows[0].id });
      });
    });

    app.get("/exchange-rates", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => ({ exchange_rates: (await c.query("select * from public.exchange_rates order by as_of_date desc limit 500")).rows }));
    });

    app.post("/exchange-rates", async (req, reply) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z.object({ from_currency: currency, to_currency: currency, rate: z.string().regex(/^\d+(\.\d{1,10})?$/), as_of_date: date, source: z.string().trim().min(1).max(120) }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const r = await c.query(
          "insert into public.exchange_rates (organization_id, from_currency, to_currency, rate, as_of_date, source, created_by) values ($1,$2,$3,$4,$5,$6,$7) on conflict do nothing returning id",
          [org.id, body.from_currency, body.to_currency, body.rate, body.as_of_date, body.source, auth.userId],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "exchange_rate.created", details: body, requestId: req.id });
        return reply.status(201).send({ id: r.rows[0]?.id ?? null });
      });
    });

    app.patch("/org/cost-policy", async (req) => {
      assertPermission(req.auth, req.org, "costs.write");
      const body = z.object({ declared_zero: z.array(z.enum(["impostos", "custo de produto"])).max(5) }).parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await c.query("update public.organizations set settings = jsonb_set(settings, '{cost_policy}', $2::jsonb, true) where id = $1", [org.id, JSON.stringify(body)]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "cost_policy.updated", details: body, requestId: req.id });
        return { ok: true };
      });
    });

    // Exportação de pedidos: CSV tipado, fórmulas neutralizadas, dados pessoais somente com pii.read (R32-02, R32-10, T66).
    app.get("/exports/orders.csv", async (req, reply) => {
      assertPermission(req.auth, req.org, "data.export");
      const q = z.object({ from: z.iso.datetime({ offset: true }), to: z.iso.datetime({ offset: true }) }).parse(req.query);
      return orgTx(deps, req, async (c, { auth, org }) => {
        const pii = org.permissions.has("pii.read");
        const r = await c.query(
          `select o.external_order_id, o.provider, o.financial_status, o.currency, o.approved_minor, o.reversed_minor, o.first_approved_at, a.category, a.utm_source, a.utm_campaign, a.campaign_id,
                  (select string_agg(coalesce(i.name, i.external_product_id), ' | ') from public.order_items i where i.order_id = o.id) as products, ct.email
             from public.orders o left join public.order_attributions a on a.order_id = o.id and a.is_current and a.policy_key = 'default'
             left join public.order_contacts ct on ct.order_id = o.id
            where o.first_approved_at >= $1 and o.first_approved_at < $2 and ($3::uuid[] is null or o.project_id = any($3)) order by o.first_approved_at limit 100000`,
          [q.from, q.to, org.projectIds],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "export.orders_csv", details: { from: q.from, to: q.to, rows: r.rows.length, pii }, requestId: req.id });
        const header = ["pedido", "provedor", "status", "moeda", "aprovado", "estornado", "aprovado_em_utc", "atribuicao", "utm_source", "utm_campaign", "campaign_id", "produtos", ...(pii ? ["email"] : [])];
        const rows = r.rows.map((o) => [
          o.external_order_id, o.provider, o.financial_status, String(o.currency).trim(),
          formatMinorAsDecimal(o.approved_minor, String(o.currency).trim()), formatMinorAsDecimal(o.reversed_minor, String(o.currency).trim()),
          o.first_approved_at?.toISOString() ?? "", o.category ?? "unattributed", o.utm_source, o.utm_campaign, o.campaign_id, o.products, ...(pii ? [o.email] : []),
        ]);
        reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", 'attachment; filename="pedidos.csv"').header("cache-control", "no-store");
        return toCsv(header, rows);
      });
    });
  };
