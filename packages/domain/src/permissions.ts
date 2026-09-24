/**
 * Perfis e permissões granulares (R06-09, R06-10). A autorização é sempre verificada no servidor (R40-01).
 */

export const PERMISSIONS = [
  "metrics.read",
  "pii.read",
  "data.export",
  "pixel.configure",
  "provider.connect",
  "members.manage",
  "costs.write",
  "media.execute",
  "rules.activate",
  "billing.access",
  "api.manage",
  "sales.write",
  "org.manage",
  "attribution.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "admin", "manager", "analyst", "finance", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  manager: "Gestor",
  analyst: "Analista",
  finance: "Financeiro",
  viewer: "Cliente/leitor",
};

const ALL = new Set<Permission>(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: ALL,
  // Administrador: operação ampla, exceto ações reservadas ao proprietário (organização e cobrança).
  admin: new Set<Permission>([...PERMISSIONS].filter((p) => p !== "billing.access" && p !== "org.manage")),
  manager: new Set<Permission>(["metrics.read", "media.execute", "rules.activate", "pixel.configure", "data.export"]),
  analyst: new Set<Permission>(["metrics.read", "data.export"]),
  finance: new Set<Permission>(["metrics.read", "costs.write", "sales.write", "data.export", "pii.read"]),
  viewer: new Set<Permission>(["metrics.read"]),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Perfis sensíveis que exigem MFA ativo para ações privilegiadas (R06-03). */
export const MFA_REQUIRED_ROLES: ReadonlySet<Role> = new Set(["owner", "admin", "finance"]);

export function isRole(v: unknown): v is Role {
  return typeof v === "string" && (ROLES as readonly string[]).includes(v);
}

export function isPermission(v: unknown): v is Permission {
  return typeof v === "string" && (PERMISSIONS as readonly string[]).includes(v);
}

/** Mascaramento de dados pessoais para quem não possui `pii.read` (R24-01). */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [user, domain] = email.split("@");
  if (!domain || !user) return "***";
  return `${user.slice(0, 1)}***@${domain.replace(/^[^.]+/, (d) => d.slice(0, 1) + "***")}`;
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  return digits.length <= 4 ? "****" : `${"*".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

export function maskName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p.slice(0, 1) + "***")
    .join(" ");
}
