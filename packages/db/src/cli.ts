import { requireEnv } from "./client";
import { migrate, migrationStatus } from "./migrate";
import { provisionRoles } from "./roles";

const cmd = process.argv[2];
const url = requireEnv("DATABASE_URL_ADMIN");

if (cmd === "migrate") {
  const applied = await migrate(url);
  console.log(applied.length ? `${applied.length} migração(ões) aplicada(s).` : "Banco já está atualizado.");
} else if (cmd === "status") {
  for (const m of await migrationStatus(url)) console.log(`${m.applied ? "✔" : "·"} ${m.name}`);
} else if (cmd === "provision-roles") {
  await provisionRoles(url, { app: requireEnv("DB_APP_PASSWORD"), system: requireEnv("DB_SYSTEM_PASSWORD") });
  console.log("Papéis tracker_app e tracker_system com LOGIN e CONNECT neste banco.");
} else {
  console.error("Uso: cli.ts <migrate|status|provision-roles>");
  process.exit(2);
}
