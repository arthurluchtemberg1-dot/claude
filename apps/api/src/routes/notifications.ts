import { randomUUID } from "node:crypto";
import { pushEndpointAllowed } from "@tracker/connectors";
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  isNotificationKind,
  isValidHhMm,
  notificationLabel,
  notificationPlaysSound,
  roleHas,
  type NotificationKind,
} from "@tracker/domain";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { audit, orgSystemTx, orgTx } from "../lib/org-tx";
import { assertPermission, assertProjectAccess } from "../services/auth";

/**
 * Central de notificações (R34-01..R34-04): cada usuário vê apenas as próprias notificações da organização ativa
 * (RLS por usuário + organização). Preferências por tipo/canal, projetos, horário silencioso, som e valores ocultos.
 * Inscrições de Web Push por dispositivo: endpoint validado (https, serviço de push conhecido) e chaves nunca
 * devolvidas pela API.
 */

const channelPrefs = z.object({ in_app: z.boolean().optional(), email: z.boolean().optional(), push: z.boolean().optional() }).strict();
const hhmm = z.string().refine(isValidHhMm, "use HH:MM");

const alertSettingsSchema = z
  .object({
    connection_stale_hours: z.number().int().min(0).max(24 * 30).optional(),
    connection_failures_per_hour: z.number().int().min(0).max(10_000).optional(),
    queue_delay_minutes: z.number().int().min(0).max(24 * 60).optional(),
    destination_failures_per_hour: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

export const notificationRoutes =
  (deps: AppDeps): FastifyPluginAsync =>
  async (app) => {
    const channels = () => ({
      in_app: { available: true },
      email: {
        available: deps.config.ALLOW_EXTERNAL_DELIVERY && deps.config.EMAIL_TRANSPORT === "smtp",
        reason: !deps.config.ALLOW_EXTERNAL_DELIVERY
          ? "Envio externo desligado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)"
          : deps.config.EMAIL_TRANSPORT !== "smtp"
            ? "E-mail real não configurado (EMAIL_TRANSPORT=smtp e SMTP_URL)"
            : null,
      },
      push: {
        available: Boolean(deps.config.webPush) && deps.config.ALLOW_EXTERNAL_DELIVERY,
        public_key: deps.config.webPush?.publicKey ?? null,
        reason: !deps.config.webPush
          ? "Web Push não configurado (WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY, WEB_PUSH_SUBJECT)"
          : !deps.config.ALLOW_EXTERNAL_DELIVERY
            ? "Envio externo desligado neste ambiente (ALLOW_EXTERNAL_DELIVERY=false)"
            : null,
      },
    });

    app.get("/notifications", async (req) => {
      const q = z
        .object({
          limit: z.coerce.number().int().min(1).max(100).default(30),
          before: z.string().datetime({ offset: true }).optional(),
          since: z.string().datetime({ offset: true }).optional(),
          unread: z.enum(["true", "false"]).optional(),
        })
        .parse(req.query);
      return orgTx(deps, req, async (c) => {
        const rows = (
          await c.query(
            `select id, kind, severity, title, body, link, project_id, is_test, created_at, read_at, data->>'order_id' as order_id
               from public.notifications
              where ($1::timestamptz is null or created_at < $1) and ($2::timestamptz is null or created_at > $2) and ($3::boolean is not true or read_at is null)
              order by created_at desc, id desc limit $4`,
            [q.before ?? null, q.since ?? null, q.unread === "true", q.limit],
          )
        ).rows;
        const unread = (await c.query("select count(*)::int as n from public.notifications where read_at is null")).rows[0].n;
        return {
          server_time: deps.now().toISOString(),
          unread_count: unread,
          notifications: rows.map((r) => ({
            ...r,
            label: notificationLabel(r.kind),
            sound: notificationPlaysSound(r.kind),
          })),
        };
      });
    });

    app.get("/notifications/unread-count", async (req) =>
      orgTx(deps, req, async (c) => ({ unread_count: (await c.query("select count(*)::int as n from public.notifications where read_at is null")).rows[0].n })),
    );

    app.post("/notifications/read", async (req) => {
      const b = z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() }).refine((x) => x.all || x.ids?.length, "informe ids ou all").parse(req.body);
      return orgTx(deps, req, async (c) => {
        const r = b.all
          ? await c.query("update public.notifications set read_at = $1 where read_at is null", [deps.now()])
          : await c.query("update public.notifications set read_at = $1 where read_at is null and id = any($2)", [deps.now(), b.ids]);
        return { updated: r.rowCount ?? 0 };
      });
    });

    app.get("/notifications/preferences", async (req) =>
      orgTx(deps, req, async (c, { org }) => {
        const p = (await c.query("select kinds, project_ids, quiet_start, quiet_end, sound_enabled, sound_volume, hide_amounts, updated_at from public.notification_preferences")).rows[0];
        return {
          preferences: {
            kinds: p?.kinds ?? {},
            project_ids: p?.project_ids ?? [],
            quiet_start: p?.quiet_start ?? null,
            quiet_end: p?.quiet_end ?? null,
            sound_enabled: p?.sound_enabled ?? false,
            sound_volume: p?.sound_volume ?? 60,
            hide_amounts: p?.hide_amounts ?? false,
            updated_at: p?.updated_at ?? null,
          },
          timezone: org.timezone,
          channels: channels(),
          kinds: Object.entries(NOTIFICATION_KINDS)
            .filter(([k]) => k !== "system.test")
            .map(([k, d]) => ({
              kind: k,
              label: d.label,
              description: d.description,
              severity: d.severity,
              defaults: d.defaults,
              availability: d.availability,
              unavailable_reason: "unavailableReason" in d ? d.unavailableReason : null,
              // Perfil sem a permissão do tipo não recebe (ex.: leitor não recebe falha de integração).
              permitted: roleHas(org.role, d.permission),
            })),
        };
      }),
    );

    app.put("/notifications/preferences", async (req) => {
      const b = z
        .object({
          kinds: z.record(z.string(), channelPrefs).default({}),
          project_ids: z.array(z.string().uuid()).max(200).default([]),
          quiet_start: hhmm.nullable().default(null),
          quiet_end: hhmm.nullable().default(null),
          sound_enabled: z.boolean().default(false),
          sound_volume: z.number().int().min(0).max(100).default(60),
          hide_amounts: z.boolean().default(false),
        })
        .strict()
        .parse(req.body);
      for (const k of Object.keys(b.kinds)) if (!isNotificationKind(k) || k === "system.test") throw badRequest("invalid_kind", `Tipo de notificação desconhecido: ${k}`);
      if ((b.quiet_start === null) !== (b.quiet_end === null)) throw badRequest("invalid_quiet_hours", "Informe início e fim do horário silencioso");
      const kinds: Partial<Record<NotificationKind, Record<string, boolean>>> = {};
      for (const [k, v] of Object.entries(b.kinds)) kinds[k as NotificationKind] = Object.fromEntries(NOTIFICATION_CHANNELS.filter((ch) => v[ch] !== undefined).map((ch) => [ch, v[ch]!]));
      return orgTx(deps, req, async (c, { auth, org }) => {
        for (const p of b.project_ids) assertProjectAccess(org, p);
        if (b.project_ids.length) {
          const found = (await c.query("select count(*)::int as n from public.projects where id = any($1)", [b.project_ids])).rows[0].n;
          if (found !== new Set(b.project_ids).size) throw badRequest("invalid_project", "Projeto inexistente");
        }
        await c.query(
          `insert into public.notification_preferences (organization_id, user_id, kinds, project_ids, quiet_start, quiet_end, sound_enabled, sound_volume, hide_amounts, updated_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           on conflict (organization_id, user_id) do update set kinds = excluded.kinds, project_ids = excluded.project_ids, quiet_start = excluded.quiet_start,
             quiet_end = excluded.quiet_end, sound_enabled = excluded.sound_enabled, sound_volume = excluded.sound_volume, hide_amounts = excluded.hide_amounts, updated_at = excluded.updated_at`,
          [org.id, auth.userId, JSON.stringify(kinds), [...new Set(b.project_ids)], b.quiet_start, b.quiet_end, b.sound_enabled, b.sound_volume, b.hide_amounts, deps.now()],
        );
        return { ok: true };
      });
    });

    app.get("/notifications/push/subscriptions", async (req) =>
      orgTx(deps, req, async (c) => ({
        channel: channels().push,
        subscriptions: (
          await c.query("select id, label, created_at, last_success_at, last_failure_at, last_error, consecutive_failures, disabled_at, disabled_reason from public.push_subscriptions order by created_at desc")
        ).rows,
      })),
    );

    app.post("/notifications/push/subscriptions", async (req, reply) => {
      const b = z
        .object({
          endpoint: z.string().url().max(2048),
          keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{20,200}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{8,100}={0,2}$/) }),
          label: z.string().trim().max(120).optional(),
        })
        .parse(req.body);
      if (!deps.config.webPush) throw badRequest("push_unavailable", channels().push.reason ?? "Web Push indisponível");
      if (!b.endpoint.startsWith("https://") || !pushEndpointAllowed(b.endpoint, deps.config.webPush.allowedHosts)) {
        throw badRequest("invalid_endpoint", "Endpoint de push não pertence a um serviço de push permitido");
      }
      // Um endpoint pertence a um navegador: o último usuário que o inscreveu nesta organização passa a recebê-lo.
      return orgSystemTx(deps, req, async (c, { auth, org }) => {
        await c.query("delete from public.push_subscriptions where organization_id = $1 and endpoint = $2", [org.id, b.endpoint]);
        const r = await c.query(
          "insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth, label) values ($1, $2, $3, $4, $5, $6) returning id, label, created_at",
          [org.id, auth.userId, b.endpoint, b.keys.p256dh.replace(/=+$/, ""), b.keys.auth.replace(/=+$/, ""), b.label ?? null],
        );
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "push_subscription.created", targetType: "push_subscription", targetId: r.rows[0].id, requestId: req.id });
        reply.status(201);
        return r.rows[0];
      });
    });

    app.delete("/notifications/push/subscriptions/:id", async (req) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      return orgTx(deps, req, async (c) => {
        const r = await c.query("delete from public.push_subscriptions where id = $1", [id]);
        if (!r.rowCount) throw notFound("Inscrição não encontrada");
        return { ok: true };
      });
    });

    // Teste explícito dos canais deste usuário (R34-03: som e push testáveis). O worker cria e entrega.
    app.post("/notifications/test", async (req) =>
      orgSystemTx(deps, req, async (c, { auth, org }) => {
        const key = randomUUID();
        await c.query("insert into public.outbox (organization_id, topic, payload, dedup_key, priority) values ($1, 'notifications.test', $2, $3, 2)", [
          org.id, JSON.stringify({ user_id: auth.userId, key }), `ntt:${key}`,
        ]);
        return { queued: true, channels: channels() };
      }),
    );

    // Limiares dos monitores da organização (0 desliga).
    app.get("/notifications/alert-settings", async (req) => {
      assertPermission(req.auth, req.org, "metrics.read");
      return orgTx(deps, req, async (c) => ({ alerts: (await c.query("select coalesce(settings->'alerts', '{}') as a from public.organizations")).rows[0]?.a ?? {} }));
    });

    app.put("/notifications/alert-settings", async (req) => {
      assertPermission(req.auth, req.org, "provider.connect");
      const b = alertSettingsSchema.parse(req.body);
      return orgTx(deps, req, async (c, { auth, org }) => {
        await c.query("update public.organizations set settings = jsonb_set(settings, '{alerts}', coalesce(settings->'alerts', '{}') || $2::jsonb) where id = $1", [org.id, JSON.stringify(b)]);
        await audit(c, { organizationId: org.id, actorId: auth.userId, action: "alert_settings.updated", details: b, requestId: req.id });
        return { alerts: (await c.query("select settings->'alerts' as a from public.organizations")).rows[0].a };
      });
    });
  };
