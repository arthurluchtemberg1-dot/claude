/**
 * Administração pelo servidor (instalação privada, sem depender de e-mail):
 *   node dist/admin.js create-owner --email voce@exemplo.com --name "Seu nome"
 *   node dist/admin.js reset-password --email voce@exemplo.com
 *   node dist/admin.js reset-mfa --email voce@exemplo.com
 * A senha vem de TRACKER_PASSWORD ou é digitada (sem eco) — nunca como argumento (histórico do shell).
 * Usa DATABASE_URL_SYSTEM. Em desenvolvimento: pnpm --filter @tracker/api admin -- create-owner ...
 */
import { parseArgs } from "node:util";
import pg from "pg";
import { hashPassword } from "../lib/crypto";

const { positionals, values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== "--"),
  allowPositionals: true,
  options: { email: { type: "string" }, name: { type: "string" } },
});
const cmd = positionals[0];
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const email = values.email?.trim().toLowerCase() ?? "";
if (!cmd || !["create-owner", "reset-password", "reset-mfa"].includes(cmd)) fail("Uso: admin.js create-owner|reset-password|reset-mfa --email voce@exemplo.com [--name \"Nome\"]");
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail("Informe --email válido");
const url = process.env.DATABASE_URL_SYSTEM ?? fail("DATABASE_URL_SYSTEM ausente");

async function readHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Entrada redirecionada: lê a primeira linha.
    const chunks: Buffer[] = [];
    for await (const ch of process.stdin) chunks.push(ch as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let out = "";
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(out);
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") out = out.slice(0, -1);
        else out += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function newPassword(): Promise<string> {
  let pw = process.env.TRACKER_PASSWORD ?? "";
  if (!pw) {
    pw = await readHidden("Nova senha (mín. 10 caracteres): ");
    if (process.stdin.isTTY && (await readHidden("Repita a senha: ")) !== pw) fail("As senhas não conferem");
  }
  if (pw.length < 10 || pw.length > 256 || /^(.)\1+$/.test(pw)) fail("Senha fraca: use ao menos 10 caracteres, sem repetir um único caractere");
  return pw;
}

const c = new pg.Client({ connectionString: url });
await c.connect();
try {
  const user = (await c.query("select id from iam.users where email = $1", [email])).rows[0] as { id: string } | undefined;
  if (cmd === "create-owner") {
    if (user) fail("Já existe uma conta com este e-mail; use reset-password");
    const hash = await hashPassword(await newPassword());
    await c.query("insert into iam.users (email, password_hash, display_name, email_verified_at) values ($1, $2, $3, now())", [email, hash, (values.name ?? email.split("@")[0]!).slice(0, 120)]);
    console.log(`Conta criada e verificada: ${email}. Entre no painel e crie sua organização.`);
  } else if (cmd === "reset-password") {
    if (!user) fail("Conta não encontrada");
    const hash = await hashPassword(await newPassword());
    await c.query("update iam.users set password_hash = $2 where id = $1", [user!.id, hash]);
    await c.query("delete from iam.sessions where user_id = $1", [user!.id]);
    console.log("Senha redefinida; sessões abertas foram encerradas.");
  } else {
    if (!user) fail("Conta não encontrada");
    await c.query("delete from iam.mfa_totp where user_id = $1", [user!.id]);
    await c.query("delete from iam.sessions where user_id = $1", [user!.id]);
    console.log("Autenticação em dois fatores removida; configure de novo ao entrar.");
  }
} finally {
  await c.end();
}
