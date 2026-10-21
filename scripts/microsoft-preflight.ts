/**
 * Pré-checagem LOCAL da configuração Microsoft (Fase 93.1). Não faz login, não troca code, não imprime client id/secret:
 * só diz se cada variável está definida, se a configuração é aceita pelo código e se o Discovery REAL do authority escolhido é aceito.
 * Uso: npm run microsoft:preflight   (com as variáveis no ambiente/.env local, nunca versionadas)
 */
import "dotenv/config";
import { buildAuthorizationUrl, getMicrosoftConfig } from "../src/helpers/microsoftOidc";

const names = ["MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET", "MICROSOFT_REDIRECT_URI", "MICROSOFT_TENANT"] as const;
for (const n of names) console.log(`${n}: ${process.env[n]?.trim() ? "definida" : n === "MICROSOFT_TENANT" ? "ausente (padrão: common)" : "AUSENTE"}`);

const config = getMicrosoftConfig();
if (!config) {
  console.log("\nConfiguração NÃO aceita (variável ausente, tenant inválido ou redirect URI inseguro). Nada foi testado contra a Microsoft.");
  process.exit(2);
}
console.log(`\nauthority/tenant: ${config.tenant}`);
console.log(`redirect URI (registre EXATAMENTE este valor na plataforma Web do aplicativo): ${config.redirectUri}`);
try {
  const url = new URL(await buildAuthorizationUrl(config, { state: "s".repeat(43), nonce: "n".repeat(43), codeChallenge: "c".repeat(43) }));
  console.log(`Discovery real aceito; authorize: ${url.origin}${url.pathname}`);
} catch (e) {
  console.log(`Discovery REJEITADO: ${e instanceof Error ? e.name : "erro"}`);
  process.exit(3);
}
console.log("\nPré-checagem ok. Isto NÃO valida login real: siga o roteiro do §17 do doc de auditoria.");
