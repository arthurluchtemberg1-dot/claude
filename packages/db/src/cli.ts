import { requireEnv } from "./client";
import { migrate, migrationStatus } from "./migrate";

const cmd = process.argv[2];
const url = requireEnv("DATABASE_URL_ADMIN");

if (cmd === "migrate") {
  const applied = await migrate(url);
  console.log(applied.length ? `${applied.length} migração(ões) aplicada(s).` : "Banco já está atualizado.");
} else if (cmd === "status") {
  for (const m of await migrationStatus(url)) console.log(`${m.applied ? "✔" : "·"} ${m.name}`);
} else {
  console.error("Uso: cli.ts <migrate|status>");
  process.exit(2);
}
