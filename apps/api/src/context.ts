import type { Pool } from "@tracker/db";
import type { Permission, Role } from "@tracker/domain";
import type { Logger } from "pino";
import type { AppConfig } from "./lib/config";
import type { EmailSender } from "./lib/email";

export interface AppDeps {
  config: AppConfig;
  pools: { app: Pool; system: Pool };
  logger: Logger;
  email: EmailSender;
  now: () => Date;
}

export interface AuthInfo {
  userId: string;
  sessionId: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  mfaEnabled: boolean;
  mfaVerified: boolean;
  isPlatformAdmin: boolean;
}

export interface OrgInfo {
  id: string;
  role: Role;
  permissions: ReadonlySet<Permission>;
  /** null = sem restrição por projeto; lista = acesso limitado a esses projetos (R06-07). */
  projectIds: string[] | null;
  mfaRequired: boolean;
  timezone: string;
  currency: string;
  isDemo: boolean;
  internalMode: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthInfo | null;
    org: OrgInfo | null;
  }
}
