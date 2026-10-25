#!/usr/bin/env node
/**
 * Gera um par de chaves VAPID para Web Push (R34-01). Imprime no terminal local; copie para o .env ou para o cofre
 * de segredos do provedor. Trocar as chaves invalida as inscrições existentes (usuários precisam reativar o push).
 */
import { createRequire } from "node:module";

// Dependência do pacote de conectores (onde o envio é implementado).
const webpush = createRequire(new URL("../packages/connectors/package.json", import.meta.url))("web-push");

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`WEB_PUSH_VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`WEB_PUSH_VAPID_PRIVATE_KEY=${privateKey}`);
console.log("WEB_PUSH_SUBJECT=mailto:operacao@seu-dominio.com.br");
