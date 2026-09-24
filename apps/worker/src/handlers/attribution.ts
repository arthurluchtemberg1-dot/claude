import { createHmac } from "node:crypto";
import type { PoolClient } from "@tracker/db";
import {
  attribute,
  classifyTouch,
  hasUnexpandedMacro,
  parseNameIdPair,
  type AttributionModel,
  type AttributionTouchpoint,
  type ClickIdKey,
} from "@tracker/domain";

/**
 * Atribuição de um pedido aprovado (seção 16). Monta os toques com a hierarquia de evidência:
 * 1) token do SDK devolvido pelo checkout (vincula o pedido ao visitante); 2) origem declarada pelo checkout
 * (UTMs; IDs validados contra entidades conhecidas da própria organização); 3) sessões do visitante vinculado.
 * Recalcular cria nova versão (histórico preservado) e nunca dispara Purchase (R16-07, T27).
 */

export interface AttributionDeps {
  tokenHmacKey: Buffer;
}

const hashToken = (key: Buffer, token: string) => createHmac("sha256", key).update(token).digest();

function rowToTouch(r: Record<string, any>, evidenceOverride?: AttributionTouchpoint["evidence"]): AttributionTouchpoint {
  return {
    id: r.id,
    occurredAt: r.occurred_at,
    channel: r.channel,
    isPaid: r.is_paid,
    network: r.network,
    evidence: evidenceOverride ?? r.evidence,
    campaignId: r.campaign_id,
    adsetId: r.adset_id,
    adId: r.ad_id,
    idsValidated: r.ids_validated,
    utm: { source: r.utm_source, medium: r.utm_medium, campaign: r.utm_campaign, content: r.utm_content, term: r.utm_term },
    declared: r.declared,
  };
}

export async function computeAttribution(c: PoolClient, deps: AttributionDeps, orgId: string, orderId: string, now: Date) {
  const order = (await c.query("select id, project_id, first_approved_at, declared_tracking from public.orders where organization_id = $1 and id = $2 for update", [orgId, orderId])).rows[0];
  if (!order || !order.first_approved_at) return { status: "skipped" as const, reason: "Pedido sem aprovação" };
  const conversionAt: Date = order.first_approved_at;
  const declared = order.declared_tracking ?? {};
  const notes: string[] = [];

  // 1) Token opaco devolvido pelo checkout → visitante (mesmo projeto e dentro da validade).
  let visitorId: string | null = null;
  if (typeof declared.trackingToken === "string") {
    const lt = (
      await c.query(
        `select id, visitor_id, created_at, expires_at from public.link_tokens
          where organization_id = $1 and project_id = $2 and token_hash = $3`,
        [orgId, order.project_id, hashToken(deps.tokenHmacKey, declared.trackingToken)],
      )
    ).rows[0];
    if (!lt) notes.push("Token devolvido pelo checkout não pertence a este projeto ou não existe");
    else if (lt.created_at > conversionAt || lt.expires_at < conversionAt) notes.push("Token fora da validade na data da conversão");
    else {
      visitorId = lt.visitor_id;
      await c.query(
        `insert into public.order_visitor_links (organization_id, order_id, visitor_id, evidence, link_token_id) values ($1, $2, $3, 'token_link', $4) on conflict do nothing`,
        [orgId, orderId, visitorId, lt.id],
      );
      await c.query("update public.link_tokens set first_order_id = coalesce(first_order_id, $2), first_linked_at = coalesce(first_linked_at, $3) where id = $1", [lt.id, orderId, now]);
    }
  }

  // 2) Origem declarada pelo checkout (dado declaratório, R15-07).
  const u = declared.utm ?? {};
  const hasDeclared = u.source || u.medium || u.campaign || u.content || u.term || declared.campaignId;
  if (hasDeclared) {
    const clean = (v: unknown) => (typeof v === "string" && !hasUnexpandedMacro(v) ? v : null);
    const macroFields = ["source", "medium", "campaign", "content", "term"].filter((k) => typeof u[k] === "string" && hasUnexpandedMacro(u[k]));
    if (macroFields.length) notes.push(`UTMs com macro não expandida ignoradas: ${macroFields.join(", ")}`);
    const campaign = parseNameIdPair(clean(u.campaign));
    const adset = parseNameIdPair(clean(u.medium));
    const ad = parseNameIdPair(clean(u.content));
    const campaignId = declared.campaignId ?? campaign.id;
    const adsetId = declared.adsetId ?? adset.id;
    const adId = declared.adId ?? ad.id;
    // IDs só são validados contra entidades da própria organização (T40).
    let validated = false;
    const anyId = campaignId ?? adsetId ?? adId;
    if (anyId) {
      const v = await c.query(
        "select 1 from public.ad_entities where organization_id = $1 and external_id = any($2) limit 1",
        [orgId, [campaignId, adsetId, adId].filter(Boolean)],
      );
      validated = !!v.rows[0];
    }
    const clickIds = (declared.clickIds ?? {}) as Partial<Record<ClickIdKey, string>>;
    const cls = classifyTouch({ utmSource: clean(u.source), utmMedium: clean(u.medium) && !adset.id ? clean(u.medium) : null, utmCampaign: clean(u.campaign), clickIds });
    // Com template "nome|id" em utm_medium o medium não é canal; IDs de anúncio comprovam mídia paga somente se validados.
    const isPaid = cls.isPaid || (validated && !!anyId);
    await c.query(
      `insert into public.touchpoints (organization_id, project_id, order_id, occurred_at, channel, is_paid, network, evidence, utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          campaign_id, adset_id, ad_id, ids_validated, click_ids, declared, classification_reason)
       values ($1,$2,$3,$4,$5,$6,$7,'checkout_source',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,true,$18)
       on conflict (organization_id, order_id) where evidence = 'checkout_source' do update set
         channel = excluded.channel, is_paid = excluded.is_paid, campaign_id = excluded.campaign_id, adset_id = excluded.adset_id, ad_id = excluded.ad_id, ids_validated = excluded.ids_validated`,
      [
        orgId, order.project_id, orderId, conversionAt, isPaid ? "paid" : cls.channel, isPaid, cls.network,
        clean(u.source), clean(u.medium), clean(u.campaign), clean(u.content), clean(u.term),
        campaignId ?? null, adsetId ?? null, adId ?? null, validated, JSON.stringify(clickIds),
        isPaid && !cls.isPaid ? "IDs de anúncio declarados e validados na organização" : cls.reason,
      ],
    );
  }

  // 3) Toques: origem declarada do pedido + sessões do visitante vinculado por token.
  const touchRows = (await c.query("select * from public.touchpoints where organization_id = $1 and order_id = $2", [orgId, orderId])).rows;
  const touches: AttributionTouchpoint[] = touchRows.map((r) => rowToTouch(r));
  const linked = (await c.query("select visitor_id, evidence from public.order_visitor_links where organization_id = $1 and order_id = $2", [orgId, orderId])).rows;
  for (const l of linked) {
    const vt = await c.query("select * from public.touchpoints where organization_id = $1 and visitor_id = $2 and evidence = 'session' and occurred_at <= $3", [orgId, l.visitor_id, conversionAt]);
    for (const r of vt.rows) touches.push(rowToTouch(r, l.evidence));
  }
  if (visitorId === null && linked.length === 0 && typeof declared.trackingToken !== "string") notes.push("Checkout não devolveu token do rastreador");

  const policies = (await c.query("select id, policy_key, version, model, window_days from public.attribution_policies where organization_id = $1 and is_active order by is_default desc", [orgId])).rows;
  const results = [];
  for (const p of policies) {
    const res = attribute({ id: p.id, version: p.version, model: p.model as AttributionModel, windowDays: p.window_days }, conversionAt, touches);
    const selected = res.selectedTouchpointId ? touches.find((t) => t.id === res.selectedTouchpointId) : null;
    const prev = await c.query(
      "update public.order_attributions set is_current = false where organization_id = $1 and order_id = $2 and policy_key = $3 and is_current returning id",
      [orgId, orderId, p.policy_key],
    );
    await c.query(
      `insert into public.order_attributions (organization_id, project_id, order_id, policy_id, policy_key, policy_version, model, window_days, conversion_at, category,
          selected_touchpoint_id, evidence, quality, reason, unattributed_reason, path, credits, network, campaign_id, adset_id, ad_id, utm_source, utm_campaign, computed_at, recalculation_of)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [
        orgId, order.project_id, orderId, p.id, p.policy_key, p.version, res.model, res.windowDays, conversionAt, res.category,
        res.selectedTouchpointId, res.evidence, res.quality, [res.reason, ...notes].join(" · "), res.unattributedReason,
        JSON.stringify(res.path), JSON.stringify(res.credits.map((cr) => ({ touchpoint_id: cr.touchpointId, weight: `${cr.weight.num}/${cr.weight.den}` }))),
        selected?.network ?? null, selected?.campaignId ?? null, selected?.adsetId ?? null, selected?.adId ?? null, selected?.utm.source ?? null, selected?.utm.campaign ?? null,
        now, prev.rows[0]?.id ?? null,
      ],
    );
    results.push({ policy: p.policy_key, category: res.category });
  }
  return { status: "computed" as const, results, notes };
}
