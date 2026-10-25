import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Graph API FALSA (local) para testes — reproduz só os formatos usados pelo cliente, conforme os SDKs oficiais:
 * access_token na query, paginação por paging.next (URL completa), erros { error: { code, message, ... } },
 * atualização por POST no nó e cópias por POST /{id}/copies. Nunca há chamada à Meta real.
 */

export interface FakeEntity {
  id: string;
  name: string;
  status: "ACTIVE" | "PAUSED";
  effective_status?: string;
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  campaign_id?: string;
  adset_id?: string;
  learning_stage_info?: { status: string };
}

export interface FakeAccount {
  id: string; // act_...
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  amount_spent: string;
  spend_cap: string;
  campaigns: FakeEntity[];
  adsets: FakeEntity[];
  ads: FakeEntity[];
  /** Gasto por dia e anúncio: { "AAAA-MM-DD": { adId: "12.34" } } (campanhas/conjuntos agregam). */
  spend: Record<string, Record<string, string>>;
  purchases?: Record<string, Record<string, { count: string; value: string }>>;
}

export interface FakeMeta {
  url: string;
  version: string;
  tokens: Map<string, { permissions: string[]; accounts: string[]; userName: string }>;
  accounts: Map<string, FakeAccount>;
  requests: { method: string; path: string; query: Record<string, string>; body: unknown }[];
  /** Erro forçado para a próxima chamada que casar com o caminho. */
  /** `hang`: não responde; com `apply`, aplica a escrita e só então "perde" a resposta (timeout após efeito). */
  failNext: { match: RegExp; status: number; error: Record<string, unknown>; times?: number; hang?: boolean; apply?: boolean }[];
  close(): Promise<void>;
}

export async function startFakeMeta(version = "v26.0"): Promise<FakeMeta> {
  const state: Omit<FakeMeta, "url" | "close"> = { version, tokens: new Map(), accounts: new Map(), requests: [], failNext: [] };
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    let drop = false;
    const json = (r: ServerResponse, status: number, body: unknown) => {
      if (!drop) r.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const chunks: Buffer[] = [];
    for await (const ch of req) chunks.push(ch as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    const u = new URL(req.url ?? "/", "http://x");
    const query = Object.fromEntries(u.searchParams.entries());
    const path = u.pathname.replace(`/${version}/`, "");
    state.requests.push({ method: req.method ?? "GET", path, query, body });
    const forced = state.failNext.find((f) => f.match.test(`${req.method} ${path}`));
    if (forced) {
      if (forced.times === undefined || --forced.times <= 0) state.failNext.splice(state.failNext.indexOf(forced), 1);
      if (forced.hang && !forced.apply) return; // simula escrita sem resposta (timeout no cliente)
      if (forced.hang) drop = true;
      else return json(res, forced.status, { error: forced.error });
    }
    const tok = state.tokens.get(query.access_token ?? "");
    if (!tok) return json(res, 400, { error: { message: "Invalid OAuth access token - Cannot parse access token", type: "OAuthException", code: 190, fbtrace_id: "T1" } });
    const accOf = (id: string) => (tok.accounts.includes(id) ? state.accounts.get(id) : undefined);
    const fields = (query.fields ?? "").split(",").filter(Boolean);
    const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => fields.includes(k) || k === "id"));
    const page = (rows: unknown[], key: string) => {
      const size = Math.min(Number(query.limit ?? 25), 2); // páginas pequenas para exercitar paging.next
      const after = Number(query.after ?? 0);
      const slice = rows.slice(after, after + size);
      const next = after + size < rows.length ? new URL(`${server_url()}/${version}/${key}?${new URLSearchParams({ ...query, after: String(after + size) })}`).toString() : undefined;
      return { data: slice, paging: next ? { next } : {} };
    };
    const seg = path.split("/");
    if (req.method === "GET") {
      if (path === "me") return json(res, 200, { id: "999", name: tok.userName });
      if (path === "me/permissions") return json(res, 200, { data: tok.permissions.map((p) => ({ permission: p, status: "granted" })) });
      if (path === "me/adaccounts") return json(res, 200, page(tok.accounts.map((id) => state.accounts.get(id)!).map((a) => pick({ ...a, account_id: a.id.slice(4) } as never)), "me/adaccounts"));
      const acc = seg[0]?.startsWith("act_") ? accOf(seg[0]) : undefined;
      if (seg[0]?.startsWith("act_") && !acc) return json(res, 400, { error: { message: "Unsupported get request", code: 100, type: "GraphMethodException" } });
      if (acc && seg.length === 1) return json(res, 200, pick({ ...acc, account_id: acc.id.slice(4) } as never));
      if (acc && (seg[1] === "campaigns" || seg[1] === "adsets" || seg[1] === "ads")) return json(res, 200, page(acc[seg[1]].map((e) => pick({ ...e, effective_status: e.effective_status ?? e.status } as never)), path));
      if (acc && seg[1] === "adspixels") return json(res, 200, { data: [{ id: "PX1", name: "Pixel Loja", last_fired_time: "2026-10-24T10:00:00+0000" }] });
      if (acc && seg[1] === "promote_pages") return json(res, 200, { data: [{ id: "PG1", name: "Página Loja" }] });
      if (acc && seg[1] === "insights") {
        const tr = JSON.parse(query.time_range ?? "{}") as { since: string; until: string };
        const level = query.level as "campaign" | "adset" | "ad";
        const rows: Record<string, unknown>[] = [];
        for (const [day, perAd] of Object.entries(acc.spend)) {
          if (day < tr.since || day > tr.until) continue;
          const groups = new Map<string, { spend: number; ad: FakeEntity; count: number; value: number; hasP: boolean }>();
          for (const [adId, sp] of Object.entries(perAd)) {
            const ad = acc.ads.find((a) => a.id === adId)!;
            const key = level === "campaign" ? ad.campaign_id! : level === "adset" ? ad.adset_id! : ad.id;
            const g = groups.get(key) ?? { spend: 0, ad, count: 0, value: 0, hasP: false };
            g.spend += Number(sp);
            const p = acc.purchases?.[day]?.[adId];
            if (p) {
              g.count += Number(p.count);
              g.value += Number(p.value);
              g.hasP = true;
            }
            groups.set(key, g);
          }
          for (const [key, g] of groups) {
            const camp = acc.campaigns.find((c) => c.id === g.ad.campaign_id)!;
            const adset = acc.adsets.find((s) => s.id === g.ad.adset_id)!;
            rows.push({
              account_currency: acc.currency,
              account_id: acc.id.slice(4),
              campaign_id: camp.id,
              campaign_name: camp.name,
              ...(level !== "campaign" ? { adset_id: adset.id, adset_name: adset.name } : {}),
              ...(level === "ad" ? { ad_id: key, ad_name: g.ad.name } : {}),
              spend: g.spend.toFixed(2),
              impressions: String(Math.round(g.spend * 100)),
              inline_link_clicks: String(Math.round(g.spend)),
              ...(g.hasP ? { actions: [{ action_type: "purchase", value: String(g.count) }], action_values: [{ action_type: "purchase", value: g.value.toFixed(2) }] } : {}),
              date_start: day,
              date_stop: day,
            });
          }
        }
        return json(res, 200, page(rows, path));
      }
      for (const a of state.accounts.values()) {
        const e = [...a.campaigns, ...a.adsets, ...a.ads].find((x) => x.id === seg[0]);
        if (e && tok.accounts.includes(a.id)) return json(res, 200, pick({ ...e, effective_status: e.effective_status ?? e.status } as never));
      }
      return json(res, 404, { error: { message: "Unknown path", code: 803 } });
    }
    if (req.method === "POST") {
      if (!tok.permissions.includes("ads_management")) return json(res, 403, { error: { message: "(#200) Requires ads_management permission", code: 200, type: "OAuthException" } });
      for (const a of state.accounts.values()) {
        const lists = { campaign: a.campaigns, adset: a.adsets, ad: a.ads };
        for (const [level, list] of Object.entries(lists)) {
          const e = list.find((x) => x.id === seg[0]);
          if (!e) continue;
          if (seg[1] === "copies") {
            const copy: FakeEntity = { ...e, id: `${e.id}_copy${list.length}`, name: `${e.name} - Cópia`, status: body?.status_option === "ACTIVE" ? "ACTIVE" : "PAUSED" };
            list.push(copy);
            return json(res, 200, { [`copied_${level === "campaign" ? "campaign" : level === "adset" ? "adset" : "ad"}_id`]: copy.id });
          }
          if (body?.status) e.status = body.status;
          if (body?.daily_budget !== undefined) e.daily_budget = String(body.daily_budget);
          if (body?.name) e.name = body.name;
          return json(res, 200, { success: true });
        }
      }
      return json(res, 400, { error: { message: "Unsupported post request", code: 100 } });
    }
    return json(res, 405, { error: { message: "method" } });
  };
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(Number(process.env.FAKE_META_PORT ?? 0), "127.0.0.1", r));
  const server_url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ...state, url: server_url(), close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }) } as FakeMeta;
}

/** Conta de exemplo: 2 campanhas, 2 conjuntos, 3 anúncios, gasto em 2 dias. */
export function sampleAccount(id: string, days: string[]): FakeAccount {
  const [d1, d2] = days;
  return {
    id,
    name: "Conta Loja",
    currency: "BRL",
    timezone_name: "America/Sao_Paulo",
    account_status: 1,
    amount_spent: "95000",
    spend_cap: "100000",
    campaigns: [
      { id: "C1", name: "[VENDAS] Produto X", status: "ACTIVE", objective: "OUTCOME_SALES", daily_budget: "10000" },
      { id: "C2", name: "[TESTE] Público Y", status: "ACTIVE", objective: "OUTCOME_SALES" },
    ],
    adsets: [
      { id: "S1", name: "Conjunto Aberto", status: "ACTIVE", campaign_id: "C1", learning_stage_info: { status: "SUCCESS" } },
      { id: "S2", name: "Conjunto Interesses", status: "ACTIVE", campaign_id: "C2", daily_budget: "5000", learning_stage_info: { status: "LEARNING" } },
    ],
    ads: [
      { id: "A1", name: "Vídeo 1", status: "ACTIVE", campaign_id: "C1", adset_id: "S1" },
      { id: "A2", name: "Imagem 2", status: "ACTIVE", campaign_id: "C1", adset_id: "S1" },
      { id: "A3", name: "Vídeo 3", status: "ACTIVE", campaign_id: "C2", adset_id: "S2" },
    ],
    spend: { [d1!]: { A1: "40.00", A2: "20.50", A3: "15.00" }, [d2!]: { A1: "30.00", A3: "10.00" } },
    purchases: { [d1!]: { A1: { count: "2", value: "394.00" } } },
  };
}
