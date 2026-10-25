"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { dateTime } from "@/lib/format";
import { registerServiceWorker, unlockAudio, useNotificationFeed } from "@/lib/notifications";
import { Badge, Button, cx } from "./ui";

const TONE = { success: "ok", warning: "warn", critical: "err", info: "info" } as const;

/** Sino do cabeçalho: contador de não lidas, últimas notificações e som opcional de venda (R34-01, R34-03). */
export function NotificationsBell({ timezone }: { timezone: string }) {
  const prefs = useApi<{ preferences: { sound_enabled: boolean; sound_volume: number } }>("/v1/notifications/preferences");
  const feed = useNotificationFeed({ soundEnabled: prefs.data?.preferences.sound_enabled ?? false, soundVolume: prefs.data?.preferences.sound_volume ?? 60 });
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void registerServiceWorker();
    // Qualquer interação libera o áudio para o som de venda (exigência dos navegadores).
    const unlock = () => unlockAudio();
    window.addEventListener("pointerdown", unlock, { once: true });
    return () => window.removeEventListener("pointerdown", unlock);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <Button
        variant="ghost"
        className="relative px-2"
        aria-label={feed.unread ? `Notificações: ${feed.unread} não lidas` : "Notificações"}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="notifications-bell"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void feed.refresh();
        }}
      >
        <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {feed.unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-err px-1 text-center text-[10px] font-semibold leading-[1.1rem] text-white" data-testid="notifications-unread">
            {feed.unread > 99 ? "99+" : feed.unread}
          </span>
        )}
      </Button>
      {open && (
        <div role="dialog" aria-label="Notificações recentes" className="absolute right-0 z-50 mt-2 w-[min(92vw,24rem)] rounded-lg border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-sm font-semibold">Notificações</span>
            {feed.unread > 0 && (
              <button className="text-xs text-muted underline hover:text-text" onClick={() => void feed.markRead("all")}>
                Marcar todas como lidas
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {feed.latest.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Nenhuma notificação ainda.</li>}
            {feed.latest.map((n) => (
              <li key={n.id} className={cx("border-b border-border last:border-0", !n.read_at && "bg-surface-2")}>
                <Link
                  href={n.link ?? "/notificacoes"}
                  className="block px-3 py-2 hover:bg-surface-2"
                  onClick={() => {
                    setOpen(false);
                    if (!n.read_at) void feed.markRead([n.id]);
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{n.title}</span>
                    <Badge tone={TONE[n.severity]}>{n.label}</Badge>
                  </div>
                  {n.body && <div className="truncate text-xs text-muted">{n.body}</div>}
                  <div className="text-[11px] text-muted">{dateTime(n.created_at, timezone)}</div>
                </Link>
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-3 py-2 text-right">
            <Link href="/notificacoes" className="text-sm underline" onClick={() => setOpen(false)}>
              Ver todas e preferências
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
