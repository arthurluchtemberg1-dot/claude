"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, ApiError, getOrgId, setOrgId, useApi } from "@/lib/api";
import { BRAND } from "@/lib/brand";
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

/** Navegação: módulos não implementados aparecem identificados como planejados (R39-01). */
const NAV: { href: string; label: string; status?: "planned" }[] = [
  { href: "/painel", label: "Visão geral" },
  { href: "/vendas", label: "Vendas" },
  { href: "/campanhas", label: "Campanhas" },
  { href: "/integracoes", label: "Integrações" },
  { href: "/instalacao", label: "Instalação do SDK" },
  { href: "/origem", label: "Origem e UTMs" },
  { href: "/pixels", label: "Pixels e conversões" },
  { href: "/custos", label: "Custos e mídia" },
  { href: "/diagnostico", label: "Diagnóstico" },
  { href: "/configuracoes", label: "Configurações" },
  { href: "/modulos/automacao", label: "Automação", status: "planned" },
  { href: "/modulos/ia", label: "Gestor IA", status: "planned" },
  { href: "/modulos/whatsapp-crm", label: "WhatsApp e CRM", status: "planned" },
  { href: "/modulos/funis", label: "Funis e testes", status: "planned" },
  { href: "/modulos/relatorios", label: "Relatórios", status: "planned" },
  { href: "/modulos/assinatura", label: "Assinatura", status: "planned" },
];

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
            <ul className="space-y-0.5">
              {NAV.map((n) => {
                const active = pathname === n.href || pathname.startsWith(n.href + "/");
                return (
                  <li key={n.href}>
                    <Link
                      href={n.href}
                      onClick={() => setMenuOpen(false)}
                      aria-current={active ? "page" : undefined}
                      title={n.label}
                      className={cx("flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm", active ? "bg-surface-2 font-semibold" : "text-muted hover:bg-surface-2 hover:text-text")}
                    >
                      <span className={cx(collapsed && "sr-only")}>{n.label}</span>
                      {collapsed && <span aria-hidden>{n.label.slice(0, 2)}</span>}
                      {!collapsed && n.status === "planned" && <Badge>planejado</Badge>}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-4 py-2">
            <div className="flex items-center gap-2">
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
                className="w-auto max-w-[16rem] py-1"
              >
                {value.me.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                    {o.is_demo ? " (demonstração)" : ""}
                  </option>
                ))}
              </Select>
              {value.org.organization.is_demo && <Badge tone="warn">Organização de demonstração — dados sintéticos</Badge>}
              {value.org.organization.internal_mode && <Badge>Uso interno</Badge>}
            </div>
            <div className="flex items-center gap-2 text-sm">
              {!value.me.user.email_verified && <Badge tone="warn">E-mail não verificado</Badge>}
              <span className="hidden text-muted sm:inline">{value.me.user.display_name}</span>
              <ThemeToggle />
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
