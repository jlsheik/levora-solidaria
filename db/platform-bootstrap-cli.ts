/**
 * CLI administrativo OFFLINE do Platform Owner (Fase 90; docs/IDENTIDADE_E_AUTENTICACAO_ESPECIFICACAO.md §25.2).
 * Roda fora da aplicação HTTP e exige acesso ao ambiente (DATABASE_URL, IDENTITY_CODE_PEPPER_V*). NÃO existe rota pública
 * equivalente. O token é impresso UMA vez no terminal e nunca é gravado (só o HMAC) nem registrado em log/audit.
 *
 *   npm run platform:bootstrap-owner   -- --email owner@exemplo.com   emite o token do PRIMEIRO owner (15 min, uso único)
 *   npm run platform:owner-recovery                                    emite o token de recuperação do owner atual
 *   npm run platform:bootstrap-revoke                                  revoga o token pendente
 *   npm run platform:bootstrap-status                                  mostra o estado (nunca o token)
 *
 * A ativação acontece no navegador em /plataforma/ativar (senha → TOTP → códigos de recuperação) e é atômica.
 */
import "dotenv/config";
import { userInfo, hostname } from "node:os";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const command = process.argv[2];
  const { db } = await import("../src/helpers/db.js");
  const { BootstrapError, issueBootstrapToken, revokePendingBootstrapTokens } = await import("../src/helpers/platformBootstrap.js");
  const issuedBy = `${userInfo().username}@${hostname()}`;

  try {
    if (command === "owner" || command === "owner-recovery") {
      const result = await issueBootstrapToken({ purpose: command === "owner" ? "owner" : "owner_recovery", email: arg("--email"), issuedBy });
      console.log("");
      console.log(`Token de ${command === "owner" ? "ATIVAÇÃO DO PLATFORM OWNER" : "RECUPERAÇÃO DO PLATFORM OWNER"} (e-mail: ${result.email})`);
      console.log("Mostrado UMA ÚNICA VEZ — não é gravado em lugar nenhum. Válido até " + result.expiresAt.toISOString() + " (15 min), uso único.");
      console.log("");
      console.log("    " + result.token);
      console.log("");
      console.log("Abra /plataforma/ativar no navegador e cole o token no campo (nunca em URL). Para cancelar: npm run platform:bootstrap-revoke");
    } else if (command === "revoke") {
      const revoked = await db.transaction().execute((trx) => revokePendingBootstrapTokens(trx, issuedBy));
      console.log(revoked > 0 ? `Token pendente revogado.` : "Nenhum token pendente.");
    } else if (command === "status") {
      const pending = await db.selectFrom("platformBootstrapTokens").select(["purpose", "createdAt", "expiresAt", "claimedAt", "issuedBy"]).where("usedAt", "is", null).where("revokedAt", "is", null).executeTakeFirst();
      const owner = await db.selectFrom("platformAccess").select("userId").where("level", "=", "owner").where("status", "=", "active").executeTakeFirst();
      console.log(`Platform Owner ativo: ${owner ? "sim" : "não"}`);
      console.log(pending ? `Token pendente: ${pending.purpose}, expira em ${pending.expiresAt.toISOString()}${pending.claimedAt ? " (já reivindicado)" : ""}` : "Nenhum token pendente.");
    } else {
      console.error("Uso: platform-bootstrap-cli <owner --email X | owner-recovery | revoke | status>");
      process.exitCode = 2;
    }
  } catch (error) {
    if (error instanceof BootstrapError) {
      console.error("Recusado: " + error.message);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((error) => {
  console.error("Falha:", error instanceof Error ? error.message : error);
  process.exit(1);
});
