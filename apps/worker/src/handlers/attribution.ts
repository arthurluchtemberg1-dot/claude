import { createHmac } from "node:crypto";
import type { PoolClient } from "@tracker/db";
import {
  attribute,
  classifyTouch,
  declaredIdsFromUtm,
  hasUnexpandedMacro,
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

/** Tolerância de desvio de relógio entre o provedor de checkout e este servidor (horários com precisão de segundos). */
export const CLOCK_SKEW_MS = 10 * 60_000;

const hashToken = (key: Buffer, token: string) => createHmac("sha256", key).update(token).digest();

// Linha do banco (colunas de public.touchpoints).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  const order = (await c.query("select id, project_id, first_approved_at, declared_tracking, parent_order_id from public.orders where organization_id = $1 and id = $2 for update", [orgId, orderId])).rows[0];
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
    else if (lt.created_at.getTime() > conversionAt.getTime() + CLOCK_SKEW_MS || lt.expires_at < conversionAt) notes.push("Token fora da validade na data da conversão");
    else {
      if (lt.created_at > conversionAt) notes.push("Desvio de relógio entre provedor e servidor tolerado (token emitido segundos após o horário informado pelo checkout)");
      visitorId = lt.visitor_id;
      await c.query(
        `insert into public.order_visitor_links (organization_id, order_id, visitor_id, evidence, link_token_id) values ($1, $2, $3, 'token_link', $4) on conflict do nothing`,
        [orgId, orderId, visitorId, lt.id],
      );
      await c.query("update public.link_tokens set first_order_id = coalesce(first_order_id, $2), first_linked_at = coalesce(first_linked_at, $3) where id = $1", [lt.id, orderId, now]);
    }
  }

  // 1b) Upsell/downsell com vínculo comprovado pela origem e sem vínculo próprio: herda os visitantes vinculados ao
  // pedido original (R10-06, T16). Vínculo próprio (token do próprio pedido) sempre prevalece.
  const ownLinks = (
    await c.query("select 1 from public.order_visitor_links where organization_id = $1 and order_id = $2 and evidence <> 'parent_order' limit 1", [orgId, orderId])
  ).rows.length;
  if (ownLinks) {
    await c.query("delete from public.order_visitor_links where organization_id = $1 and order_id = $2 and evidence = 'parent_order'", [orgId, orderId]);
  } else if (order.parent_order_id) {
    const inherited = await c.query(
      `insert into public.order_visitor_links (organization_id, order_id, visitor_id, evidence, inherited_from_order_id)
       select organization_id, $2, visitor_id, 'parent_order', $3 from public.order_visitor_links
        where organization_id = $1 and order_id = $3 and evidence in ('token_link', 'parent_order')
       on conflict do nothing returning visitor_id`,
      [orgId, orderId, order.parent_order_id],
    );
    const total = (await c.query("select count(*)::int as n from public.order_visitor_links where organization_id = $1 and order_id = $2 and evidence = 'parent_order'", [orgId, orderId])).rows[0].n;
    if (total > 0) notes.push(`Vínculo herdado do pedido original (upsell declarado pela origem)${inherited.rowCount ? "" : " já registrado"}`);
  }

  // 2) Origem declarada pelo checkout (dado declaratório, R15-07). O token transportado num campo UTM não é origem.
  const u: Record<string, string | null> = { ...(declared.utm ?? {}) };
  if (typeof declared.trackingToken === "string") {
    for (const k of Object.keys(u)) {
      const v = u[k];
      if (typeof v === "string" && (v.includes(declared.trackingToken) || v.includes("[token]"))) u[k] = v.replace(declared.trackingToken, "").replace("[token]", "").replace(/[|_\s-]+$/, "") || null;
    }
  }
  const hasDeclared = u.source || u.medium || u.campaign || u.content || u.term || declared.campaignId;
  if (hasDeclared) {
    const clean = (v: unknown) => (typeof v === "string" && !hasUnexpandedMacro(v) ? v : null);
    const macroFields = ["source", "medium", "campaign", "content", "term"].filter((k) => typeof u[k] === "string" && hasUnexpandedMacro(u[k] as string));
    if (macroFields.length) notes.push(`UTMs com macro não expandida ignoradas: ${macroFields.join(", ")}`);
    const ids = declaredIdsFromUtm({ campaign: clean(u.campaign), medium: clean(u.medium), content: clean(u.content), term: clean(u.term) });
    const campaignId = declared.campaignId ?? ids.campaignId;
    const adsetId = declared.adsetId ?? ids.adsetId;
    const adId = declared.adId ?? ids.adId;
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
    const cls = classifyTouch({ utmSource: clean(u.source), utmMedium: ids.mediumIsPair ? null : clean(u.medium), utmCampaign: clean(u.campaign), clickIds });
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

  // 3) Toques. Hierarquia de evidência (R16-04): havendo vínculo por token, os toques do visitante vinculado são a
  // evidência principal e a origem declarada pelo checkout fica apenas como corroboração (não compete como toque).
  const linked = (await c.query("select visitor_id, evidence from public.order_visitor_links where organization_id = $1 and order_id = $2", [orgId, orderId])).rows;
  const touchRows = linked.length ? [] : (await c.query("select * from public.touchpoints where organization_id = $1 and order_id = $2", [orgId, orderId])).rows;
  const touches: AttributionTouchpoint[] = touchRows.map((r) => rowToTouch(r));
  if (linked.length && hasDeclared) notes.push("Origem declarada pelo checkout registrada como corroboração do vínculo por token");
  // IDs declarados nas UTMs das visitas vinculadas são validados agora contra entidades da organização (T40).
  if (linked.length) {
    await c.query(
      `update public.touchpoints t set ids_validated = true
        where t.organization_id = $1 and t.visitor_id = any($2) and t.evidence = 'session' and not t.ids_validated
          and exists (select 1 from public.ad_entities e where e.organization_id = $1 and e.external_id in (t.campaign_id, t.adset_id, t.ad_id))`,
      [orgId, linked.map((l) => l.visitor_id)],
    );
  }
  for (const l of linked) {
    const vt = await c.query("select * from public.touchpoints where organization_id = $1 and visitor_id = $2 and evidence = 'session' and occurred_at <= $3", [
      orgId,
      l.visitor_id,
      new Date(conversionAt.getTime() + CLOCK_SKEW_MS),
    ]);
    for (const r of vt.rows) {
      // Vínculo herdado do pedido original deriva de um vínculo por token: mesma força de evidência.
      const t = rowToTouch(r, l.evidence === "parent_order" ? "token_link" : l.evidence);
      // Toque dentro da tolerância de desvio de relógio é tratado como simultâneo à conversão.
      touches.push(t.occurredAt > conversionAt ? { ...t, occurredAt: conversionAt } : t);
    }
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
  // Upsells aprovados sem vínculo próprio são recalculados quando o pedido original ganha vínculos (sem Purchase, R16-07).
  const parentLinks = (await c.query("select count(*)::int as n from public.order_visitor_links where organization_id = $1 and order_id = $2 and evidence in ('token_link', 'parent_order')", [orgId, orderId])).rows[0].n;
  if (parentLinks > 0) {
    const children = await c.query(
      `select o.id from public.orders o
        where o.organization_id = $1 and o.parent_order_id = $2 and o.first_approved_at is not null
          and not exists (select 1 from public.order_visitor_links l where l.organization_id = $1 and l.order_id = o.id)`,
      [orgId, orderId],
    );
    for (const ch of children.rows) {
      await c.query(
        "insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'attribution.compute', $2, $3, 3) on conflict do nothing",
        [orgId, JSON.stringify({ order_id: ch.id }), `attr:${ch.id}:parent-links:${orderId}:${parentLinks}`],
      );
    }
  }
  return { status: "computed" as const, results, notes };
}
