import pg from "pg";
import { migrate } from "../packages/db/src/migrate";
import { TEST_DB } from "./env";

export default async function setup() {
  if (!/tracker_test|_test$/.test(new URL(TEST_DB.admin).pathname)) {
    throw new Error("Recusado: testes de integração só rodam em banco de teste (nome terminado em _test).");
  }
  await migrate(TEST_DB.admin, () => undefined);
  const client = new pg.Client({ connectionString: TEST_DB.admin });
  await client.connect();
  try {
    // Estado limpo a cada execução da suíte (somente no banco de teste).
    await client.query("truncate public.organizations, iam.users, public.feature_flags cascade");
  } finally {
    await client.end();
  }
}
