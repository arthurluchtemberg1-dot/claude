"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, getOrgId, setOrgId, useApi } from "@/lib/api";
import { BRAND } from "@/lib/brand";
import { NotificationsBell } from "./notifications-bell";
import { Badge, Button, cx, Select, Skeleton } from "./ui";

export interface Me {
  user: { id: string; email: string; display_name: string; email_verified: boolean; mfa_enabled: boolean; mfa_verified: boolean };
  organizations: { id: string; name: string; slug: string; role: string; is_demo: boolean; internal_mode: boolean }[];
}

export interface OrgCtx {
  organization: { id: string; name: string; timezone: string; currency: string; is_demo: boolean; internal_mode: boolean; mfa_required: boolean; cost_policy: { declared_zero?: string[] } | null };
  membership: { role: string; permissions: string[]; project_ids: string[] | null };
}

interface SessionValue {
  me: Me;
  org: OrgCtx;
  can: (p: string) => boolean;
  reloadOrg: () => void;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession fora do AppShell");
  return v;
}

/** Navegação em seções; módulos não implementados aparecem identificados como planejados (R39-01). */
type NavItem = { href: string; label: string; icon: keyof typeof ICONS; status?: "planned" };
const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: "Principal",
    items: [
      { href: "/primeiros-passos", label: "Primeiros passos", icon: "flag" },
      { href: "/painel", label: "Visão geral", icon: "home" },
      { href: "/campanhas", label: "Campanhas", icon: "target" },
      { href: "/vendas", label: "Vendas", icon: "cart" },
      { href: "/clientes", label: "Clientes", icon: "users" },
    ],
  },
  {
    section: "Automação",
    items: [
      { href: "/automacao", label: "Regras", icon: "bolt" },
      { href: "/gestor-ia", label: "Gestor IA", icon: "spark" },
      { href: "/notificacoes", label: "Notificações", icon: "bell" },
    ],
  },
  {
    section: "Rastreamento",
    items: [
      { href: "/integracoes/meta", label: "Meta Ads", icon: "meta" },
      { href: "/integracoes", label: "Integrações", icon: "plug" },
      { href: "/instalacao", label: "Instalação do SDK", icon: "code" },
      { href: "/origem", label: "Origem e UTMs", icon: "link" },
      { href: "/pixels", label: "Pixels e conversões", icon: "pixel" },
      { href: "/atribuicao", label: "Atribuição", icon: "split" },
    ],
  },
  {
    section: "Gestão",
    items: [
      { href: "/custos", label: "Custos e mídia", icon: "coin" },
      { href: "/diagnostico", label: "Diagnóstico", icon: "pulse" },
      { href: "/api-webhooks", label: "API e webhooks", icon: "hook" },
      { href: "/configuracoes", label: "Configurações", icon: "gear" },
    ],
  },
  {
    section: "Em breve",
    items: [
      { href: "/modulos/whatsapp-crm", label: "WhatsApp e CRM", icon: "chat", status: "planned" },
      { href: "/modulos/funis", label: "Funis e testes", icon: "funnel", status: "planned" },
      { href: "/modulos/relatorios", label: "Relatórios", icon: "doc", status: "planned" },
      { href: "/modulos/assinatura", label: "Assinatura", icon: "card", status: "planned" },
    ],
  },
];
const ALL_HREFS = NAV.flatMap((g) => g.items.map((i) => i.href));

/** Ícones de traço simples (desenho próprio), 24×24. */
const ICONS = {
  flag: "M5 21V4m0 0h11l-2 4 2 4H5",
  home: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0-3.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1z",
  cart: "M3 4h2l2.4 11h10.2L20 8H6.2M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 12 0v1m2-10a3 3 0 1 0 0-6m2 16v-1a5 5 0 0 0-3-4.6",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zm4 4a2 2 0 0 0 4 0",
  meta: "M3 15c0-5 2.5-8 4.5-8 3 0 5.5 10 9 10 2 0 4.5-2 4.5-5s-2-5-4-5c-3.5 0-6 10-9.5 10C5 17 3 16.5 3 15z",
  plug: "M9 2v5m6-5v5M6 7h12v4a6 6 0 0 1-12 0zm6 10v5",
  code: "M8 8l-5 4 5 4m8-8l5 4-5 4M14 4l-4 16",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1m-2 7.4l-1 1a4 4 0 0 1-5.7-5.7l3-3a4 4 0 0 1 5.7 0",
  pixel: "M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zm10 3h6m-3-3v6",
  split: "M6 3v6a6 6 0 0 0 6 6h0a6 6 0 0 1 6 6M18 3v6a6 6 0 0 1-3 5.2M3 6l3-3 3 3m6 0l3-3 3 3",
  coin: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3-12.5c-.6-.9-1.7-1.5-3-1.5-1.9 0-3 1-3 2.3 0 3.2 6 1.7 6 4.9 0 1.3-1.3 2.3-3 2.3-1.4 0-2.5-.6-3.1-1.6M12 5v2m0 10v2",
  pulse: "M3 12h4l3-8 4 16 3-8h4",
  hook: "M7 15a4 4 0 1 0 4 4m6-4a4 4 0 1 1-4 4H9m3-14a4 4 0 0 1 2 7.5L17 15",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.2-1.3L14.4 3h-4l-.4 2.4a7.4 7.4 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.4 7.4 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3z",
  chat: "M4 5h16v11H8l-4 4z",
  funnel: "M3 4h18l-7 8v7l-4 2v-9z",
  doc: "M6 2h9l5 5v15H6zm8 0v6h6M9 13h8M9 17h8",
  card: "M3 6h18v12H3zm0 4h18M7 15h4",
} as const;

function NavIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={ICONS[name]} />
    </svg>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string>("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("trk_theme") ?? "system";
      setTheme(t);
      if (t !== "system") document.documentElement.dataset.theme = t;
    } catch {
      /* ignorar */
    }
  }, []);
  return (
    <Select
      aria-label="Tema"
      value={theme}
      onChange={(e) => {
        const t = e.target.value;
        setTheme(t);
        try {
          localStorage.setItem("trk_theme", t);
        } catch {
          /* ignorar */
        }
        if (t === "system") delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = t;
      }}
      className="w-auto py-1 text-xs"
    >
      <option value="system">Tema do sistema</option>
      <option value="light">Claro</option>
      <option value="dark">Escuro</option>
    </Select>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const me = useApi<Me>("/v1/auth/me");
  const [orgId, setOrg] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (me.error?.status === 401) router.replace(`/entrar?next=${encodeURIComponent(pathname)}`);
  }, [me.error, router, pathname]);

  useEffect(() => {
    if (!me.data) return;
    if (!me.data.user.mfa_verified) {
      router.replace("/mfa");
      return;
    }
    const orgs = me.data.organizations;
    if (!orgs.length) {
      router.replace("/onboarding");
      return;
    }
    const stored = getOrgId();
    const valid = orgs.find((o) => o.id === stored)?.id ?? orgs[0]!.id;
    if (valid !== stored) setOrgId(valid);
    setOrg(valid);
  }, [me.data, router]);

  const org = useApi<OrgCtx>(orgId ? "/v1/org" : null);
  const value = useMemo<SessionValue | null>(
    () => (me.data && org.data ? { me: me.data, org: org.data, can: (p) => org.data!.membership.permissions.includes(p), reloadOrg: org.reload } : null),
    [me.data, org.data, org.reload],
  );

  if (me.error && me.error.status !== 401) {
    return <div className="p-6 text-sm text-err">Não foi possível carregar a sessão: {me.error.message}</div>;
  }
  if (!value) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6" aria-busy>
        <div className="w-full max-w-md space-y-3">
          <Skeleton className="h-6 w-1/2" />
          <Skeleton />
          <Skeleton />
        </div>
      </div>
    );
  }

  const logout = async () => {
    await api("/v1/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
    setOrgId(null);
    router.replace("/entrar");
  };

  return (
    <Ctx.Provider value={value}>
      <a href="#conteudo" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-surface focus:p-2">
        Pular para o conteúdo
      </a>
      <div className="flex min-h-screen">
        <aside
          className={cx(
            "fixed inset-y-0 left-0 z-40 flex flex-col border-r border-border bg-surface transition-all md:static",
            collapsed ? "w-16" : "w-64",
            menuOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
          )}
          aria-label="Navegação principal"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border p-3">
            {!collapsed && <span className="font-semibold">{BRAND.name}</span>}
            <Button variant="ghost" aria-label={collapsed ? "Expandir menu" : "Recolher menu"} onClick={() => setCollapsed((c) => !c)} className="hidden px-2 md:inline-flex">
              {collapsed ? "»" : "«"}
            </Button>
            <Button variant="ghost" aria-label="Fechar menu" onClick={() => setMenuOpen(false)} className="px-2 md:hidden">
              ×
            </Button>
          </div>
          <nav className="flex-1 overflow-y-auto p-2">
            {NAV.map((g) => (
              <div key={g.section} className="mb-3">
                {!collapsed && <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{g.section}</p>}
                <ul className="space-y-0.5">
                  {g.items.map((n) => {
                    // Item mais específico vence (ex.: /integracoes/meta não acende /integracoes).
                    const matches = (h: string) => pathname === h || pathname.startsWith(h + "/");
                    const active = matches(n.href) && !ALL_HREFS.some((h) => h !== n.href && h.startsWith(n.href + "/") && matches(h));
                    return (
                      <li key={n.href}>
                        <Link
                          href={n.href}
                          onClick={() => setMenuOpen(false)}
                          aria-current={active ? "page" : undefined}
                          title={n.label}
                          className={cx(
                            "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                            collapsed && "justify-center px-2",
                            active ? "bg-primary/10 font-semibold text-primary" : "text-muted hover:bg-surface-2 hover:text-text",
                          )}
                        >
                          <NavIcon name={n.icon} />
                          <span className={cx("flex-1", collapsed && "sr-only")}>{n.label}</span>
                          {!collapsed && n.status === "planned" && <Badge>planejado</Badge>}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
          {/* Em telas pequenas o tema fica no menu lateral (cabeçalho em uma linha). */}
          <div className="border-t border-border p-2 sm:hidden">
            <ThemeToggle />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Button variant="ghost" className="px-2 md:hidden" aria-label="Abrir menu" onClick={() => setMenuOpen(true)}>
                ☰
              </Button>
              <Select
                aria-label="Organização"
                value={orgId ?? ""}
                onChange={(e) => {
                  setOrgId(e.target.value);
                  window.location.href = "/painel";
                }}
                className="w-auto max-w-[10rem] py-1 sm:max-w-[16rem]"
              >
                {value.me.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.is_demo ? " (demonstração)" : ""}
                  </option>
                ))}
              </Select>
              {value.org.organization.is_demo && (
                <Badge tone="warn" title="Organização de demonstração — dados sintéticos">
                  Demonstração<span className="hidden lg:inline">&nbsp;— dados sintéticos</span>
                </Badge>
              )}
              {value.org.organization.internal_mode && <Badge>Uso interno</Badge>}
            </div>
            <div className="flex items-center gap-2 text-sm">
              {!value.me.user.email_verified && <Badge tone="warn">E-mail não verificado</Badge>}
              <NotificationsBell timezone={value.org.organization.timezone} />
              <span className="hidden text-muted sm:inline">{value.me.user.display_name}</span>
              <div className="hidden sm:block">
                <ThemeToggle />
              </div>
              <Button variant="secondary" onClick={logout}>
                Sair
              </Button>
            </div>
          </header>
          <main id="conteudo" className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-6">
            {children}
          </main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
