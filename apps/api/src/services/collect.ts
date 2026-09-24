import { classifyTouch, declaredIdsFromUtm, extractClickIds, referrerHost, sanitizeUrl, sanitizedToString } from "@tracker/domain";
import { withTx } from "@tracker/db";
import { z } from "zod";
import type { AppDeps } from "../context";
import { hmacToken, randomToken, tokenHint } from "../lib/crypto";

/**
 * Coletor público do SDK (seção 13). A chave pública identifica o projeto, mas não autentica vendas nem
 * comprova origem (R13-01, R40-09). Consentimento por finalidade (R13-18/19, T34). Limites anti-poluição (R40-11).
 */

const idRe = /^[A-Za-z0-9_-]{16,64}$/;
const PII_KEY = /(mail|phone|fone|tel|cpf|cnpj|document|senha|pass|card|cvv|name|nome|address|endereco|birth)/i;

export const collectSchema = z.object({
  v: z.literal(1),
  pk: z.string().regex(/^pk_[A-Za-z0-9]{16,40}$/),
  aid: z.string().regex(idRe),
  sid: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  consent: z.object({ analytics: z.boolean().nullable(), ads: z.boolean().nullable(), storage: z.boolean().nullable() }),
  ctx: z.object({
    url: z.string().max(2048),
    ref: z.string().max(2048).nullish(),
    fbp: z.string().max(200).nullish(),
    fbc: z.string().max(500).nullish(),
  }),
  events: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
        name: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/),
        ts: z.number().int().positive(),
        url: z.string().max(2048).nullish(),
        props: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
      }),
    )
    .max(50),
  token_request: z.boolean().optional(),
  test: z.boolean().optional(),
});

export type CollectPayload = z.infer<typeof collectSchema>;

export interface CollectResult {
  status: number;
  body: Record<string, unknown>;
}

const FBP_RE = /^fb\.\d\.\d{10,13}\.\d{1,25}$/;
const FBC_RE = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_-]{1,450}$/;

export async function collect(deps: AppDeps, payload: CollectPayload, meta: { ip: string; userAgent: string | null; origin: string | null }): Promise<CollectResult> {
  const project = (await deps.pools.system.query("select * from app.resolve_project_key($1)", [payload.pk])).rows[0];
  if (!project || project.archived) return { status: 404, body: { error: "unknown_project" } };
  const allowed: string[] = project.allowed_origins ?? [];
  // Validação de origem reduz poluição acidental; não é autenticação (R40-09).
  if (allowed.length && (!meta.origin || !allowed.includes(meta.origin))) return { status: 403, body: { error: "origin_not_allowed" } };

  const orgId = project.organization_id as string;
  const projectId = project.project_id as string;
  const now = deps.now();

  return withTx(deps.pools.system, { organizationId: orgId }, async (c) => {
    const settings = (await c.query("select settings from public.projects where id = $1", [projectId])).rows[0]?.settings ?? {};
    const mode: string = settings?.consent_policy?.mode ?? "require_explicit";
    const analyticsAllowed = payload.consent.analytics === true || (mode === "analytics_legitimate_interest" && payload.consent.analytics !== false);
    const adsAllowed = payload.consent.ads === true;

    if (!analyticsAllowed) {
      // T34: sem consentimento de analytics nada é armazenado além da ausência de coleta.
      return { status: 202, body: { ok: true, stored: false, reason: "consent_required" } };
    }

    const landing = sanitizeUrl(payload.ctx.url);
    if (!landing) return { status: 400, body: { error: "invalid_url" } };
    const refHost = referrerHost(payload.ctx.ref);
    const clickIds = extractClickIds(landing.params);
    const utm = {
      source: landing.params.utm_source ?? null,
      medium: landing.params.utm_medium ?? null,
      campaign: landing.params.utm_campaign ?? null,
      content: landing.params.utm_content ?? null,
      term: landing.params.utm_term ?? null,
    };
    const landingHost = new URL(landing.origin).hostname;
    // IDs declarados em templates "nome|id" (validados depois, na atribuição, contra entidades da organização).
    const ids = declaredIdsFromUtm(utm);
    const cls = classifyTouch({ utmSource: utm.source, utmMedium: ids.mediumIsPair ? null : utm.medium, utmCampaign: utm.campaign, clickIds, referrerHost: refHost, landingHost });

    const earliest = payload.events.reduce((m, e) => Math.min(m, e.ts), now.getTime());
    const firstSeen = new Date(Math.max(earliest, now.getTime() - 24 * 3600_000));

    const v = await c.query(
      `insert into public.visitors (organization_id, project_id, anon_id, first_seen_at, last_seen_at) values ($1, $2, $3, $4, $5)
       on conflict (organization_id, project_id, anon_id) do update set last_seen_at = greatest(public.visitors.last_seen_at, excluded.last_seen_at)
       returning id`,
      [orgId, projectId, payload.aid, firstSeen, now],
    );
    const visitorId = v.rows[0].id as string;

    const fbp = adsAllowed && payload.ctx.fbp && FBP_RE.test(payload.ctx.fbp) ? payload.ctx.fbp : null;
    const fbc = adsAllowed && payload.ctx.fbc && FBC_RE.test(payload.ctx.fbc) ? payload.ctx.fbc : null;
    const s = await c.query(
      `insert into public.sessions (organization_id, project_id, visitor_id, session_key, started_at, last_event_at, landing_url, referrer_host, utm, click_ids,
                                    channel, is_paid, network, classification_reason, ads_consent, client_ip, user_agent, fbp, fbc)
       values ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       on conflict (organization_id, project_id, session_key) do update set
         last_event_at = greatest(public.sessions.last_event_at, excluded.last_event_at),
         ads_consent = excluded.ads_consent,
         client_ip = case when excluded.ads_consent then coalesce(excluded.client_ip, public.sessions.client_ip) else null end,
         user_agent = case when excluded.ads_consent then coalesce(excluded.user_agent, public.sessions.user_agent) else null end,
         fbp = case when excluded.ads_consent then coalesce(excluded.fbp, public.sessions.fbp) else null end,
         fbc = case when excluded.ads_consent then coalesce(excluded.fbc, public.sessions.fbc) else null end
       returning id, (xmax = 0) as inserted, started_at, visitor_id`,
      [
        orgId, projectId, visitorId, payload.sid, firstSeen, sanitizedToString(landing), refHost, JSON.stringify(utm), JSON.stringify(clickIds),
        cls.channel, cls.isPaid, cls.network, cls.reason, adsAllowed,
        adsAllowed ? meta.ip : null, adsAllowed ? meta.userAgent?.slice(0, 512) ?? null : null, fbp, fbc,
      ],
    );
    const session = s.rows[0] as { id: string; inserted: boolean; started_at: Date; visitor_id: string };
    if (session.visitor_id !== visitorId) return { status: 409, body: { error: "session_visitor_mismatch" } };

    if (session.inserted) {
      await c.query(
        `insert into public.touchpoints (organization_id, project_id, visitor_id, session_id, occurred_at, channel, is_paid, network, evidence,
            utm_source, utm_medium, utm_campaign, utm_content, utm_term, click_ids, declared, classification_reason, campaign_id, adset_id, ad_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'session',$9,$10,$11,$12,$13,$14,false,$15,$16,$17,$18)
         on conflict do nothing`,
        [
          orgId, projectId, visitorId, session.id, session.started_at, cls.channel, cls.isPaid, cls.network, utm.source, utm.medium, utm.campaign, utm.content, utm.term,
          JSON.stringify(clickIds), cls.reason, ids.campaignId, ids.adsetId, ids.adId,
        ],
      );
      await c.query("insert into public.consent_records (organization_id, project_id, visitor_id, analytics, advertising, storage, source) values ($1,$2,$3,$4,$5,$6,'sdk')", [
        orgId, projectId, visitorId, payload.consent.analytics, payload.consent.ads, payload.consent.storage,
      ]);
    }

    let stored = 0;
    for (const e of payload.events) {
      const ts = e.ts;
      if (ts > now.getTime() + 5 * 60_000 || ts < now.getTime() - 24 * 3600_000) continue; // fora da janela aceitável
      const eUrl = e.url ? sanitizeUrl(e.url) : null;
      const props: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(e.props ?? {}).slice(0, 20)) if (!PII_KEY.test(k)) props[k] = val;
      const r = await c.query(
        `insert into public.tracking_events (organization_id, project_id, visitor_id, session_id, client_event_id, event_name, occurred_at, page_url, properties, consent, is_test)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict (organization_id, project_id, client_event_id) do nothing`,
        [orgId, projectId, visitorId, session.id, e.id, e.name, new Date(ts), eUrl ? sanitizedToString(eUrl) : null, JSON.stringify(props), JSON.stringify(payload.consent), !!payload.test],
      );
      stored += r.rowCount ?? 0;
    }

    let token: string | undefined;
    let tokenExpiresAt: Date | undefined;
    if (payload.token_request) {
      token = `trk_${randomToken(24)}`;
      tokenExpiresAt = new Date(now.getTime() + 30 * 86_400_000);
      await c.query(
        `insert into public.link_tokens (organization_id, project_id, visitor_id, session_id, token_hash, token_hint, destination_host, created_at, expires_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [orgId, projectId, visitorId, session.id, hmacToken(deps.config.tokenHmacKey, token), tokenHint(token), null, now, tokenExpiresAt],
      );
    }
    return { status: 200, body: { ok: true, stored, ...(token ? { token, token_expires_at: tokenExpiresAt!.toISOString() } : {}) } };
  });
}
