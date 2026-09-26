/**
 * Testes de segurança adicionais (Fases 3, 5 e 6 do pedido de auditoria):
 * SQL injection, XSS armazenado e ciclo de vida de convites/status de
 * organização ("códigos de acesso"). Ver relatório de auditoria (Fase 1)
 * para o raciocínio completo por trás de cada teste.
 */
import { describe, it, expect } from "vitest";
import { db } from "../src/helpers/db";
import { handle as postLogin } from "../src/endpoints/auth/login_with_password_POST";
import { handle as postOrganizations } from "../src/endpoints/organizations_POST";
import { handle as postNeeds } from "../src/endpoints/needs_POST";
import { handle as postStockTransaction } from "../src/endpoints/stock-transactions_POST";
import { handle as postInvite } from "../src/endpoints/organization-invites_POST";
import { handle as postAccept } from "../src/endpoints/organization-invites-accept_POST";
import { handle as postPlatformOrgStatus } from "../src/endpoints/platform-organizations-status_POST";
import {
  createAuthenticatedUser,
  createTestOrganization,
  createTestInventoryItem,
  buildRequest,
  parseJson,
} from "./helpers";

describe("Fase 4 — CSRF (verificação da propriedade que sustenta a análise arquitetural)", () => {
  // Ver docs/SECURITY.md: este app não usa token CSRF porque (1) o cookie é
  // SameSite=Lax (não acompanha POST/fetch cross-site), (2) não há CORS
  // configurado (nenhuma origem externa recebe credenciais) e (3) todo
  // endpoint que muda estado exige um corpo serializado em superjson — algo
  // que um <form> HTML comum não consegue produzir. Este teste prova
  // diretamente a propriedade (3): um corpo que não é superjson válido
  // (o que é exatamente o que um <form> cross-site conseguiria enviar)
  // nunca é interpretado como uma ação válida.
  it("um corpo que não é superjson válido (o que um <form> HTML cross-site produziria) é rejeitado, nunca executado", async () => {
    const owner = await createAuthenticatedUser();
    await createTestOrganization(owner.userId);

    const headers = new Headers({ "Content-Type": "application/json", Cookie: owner.cookie });
    headers.set("x-client-ip-verified", "csrf-form-test");
    // Corpo típico de um <form> HTML (urlencoded), não superjson.
    const forged = new Request("http://localhost/_api/organizations", {
      method: "POST",
      headers,
      body: `name=Organiza%C3%A7%C3%A3o+Forjada&type=organizacao_social&city=BH&state=MG`,
    });

    const response = await postOrganizations(forged);
    expect(response.status).toBe(400); // superjson.parse falha antes de qualquer efeito

    const rows = await db.selectFrom("organizations").select(["id"]).where("createdByUserId", "=", owner.userId).execute();
    expect(rows).toHaveLength(1); // só a organização criada acima, nenhuma "Forjada"
  });
});

describe("Fase 3 — SQL injection", () => {
  it("payload de bypass de autenticação no e-mail de login nunca autentica (nem cria sessão)", async () => {
    // O local-part de e-mail permite aspas simples por RFC — não dependemos
    // só da validação de formato do zod rejeitar isto; o que importa é que,
    // rejeitado na validação OU não encontrado no banco, o resultado NUNCA
    // é uma sessão criada. O Kysely parametriza `.where("email","=",...)`,
    // então mesmo se passasse da validação, o valor é tratado como dado,
    // nunca como comando.
    const maliciousEmail = "attacker' OR '1'='1";
    const response = await postLogin(
      buildRequest("auth/login_with_password", { method: "POST", body: { email: maliciousEmail, password: "qualquer-coisa" } })
    );
    expect(response.status).not.toBe(200);
    expect([400, 401]).toContain(response.status);

    const sessions = await db.selectFrom("sessions").select(["id"]).execute();
    expect(sessions).toHaveLength(0);
  });

  it("payload de bypass também falha com um e-mail existente de verdade e senha injetada", async () => {
    const victim = await createAuthenticatedUser({ email: "vitima@example.com" });
    void victim;

    const response = await postLogin(
      buildRequest("auth/login_with_password", {
        method: "POST",
        body: { email: "vitima@example.com", password: "' OR '1'='1" },
      })
    );
    // Senha não bate (bcrypt.compare trata a string como dado literal) —
    // nunca autentica só porque o valor "parece" uma tautologia SQL.
    expect(response.status).toBe(401);
  });

  it("nome de organização com metacaracteres de SQL é gravado e devolvido como dado literal (endpoint real), nunca altera a consulta nem afeta outras linhas", async () => {
    const owner = await createAuthenticatedUser();
    const maliciousName = "Igreja'; DROP TABLE organizations; --";

    const response = await postOrganizations(
      buildRequest("organizations", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: maliciousName, type: "organizacao_social", city: "Belo Horizonte", state: "MG" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ organization: { id: number; name: string } }>(response);
    expect(data.organization.name).toBe(maliciousName);

    // A tabela continua íntegra (nada foi executado como comando) e outras
    // organizações não foram afetadas.
    const otherOwner = await createAuthenticatedUser();
    const otherOrg = await createTestOrganization(otherOwner.userId, { name: "Organização Legítima" });

    const row = await db.selectFrom("organizations").select(["name"]).where("id", "=", data.organization.id).executeTakeFirstOrThrow();
    expect(row.name).toBe(maliciousName);

    const untouched = await db.selectFrom("organizations").select(["name"]).where("id", "=", otherOrg.id).executeTakeFirstOrThrow();
    expect(untouched.name).toBe("Organização Legítima");
  });
});

describe("Fase 5 — XSS (verificação de que a API não gera vulnerabilidade armazenada)", () => {
  // Nota do relatório de auditoria: não existe nenhum `dangerouslySetInnerHTML`,
  // `innerHTML` nem renderizador de markdown/HTML alimentado por dado de
  // usuário em src/pages ou src/components — todo campo de texto livre é
  // renderizado como `{valor}` JSX, que o React escapa automaticamente. A
  // única coisa que a API PRECISA garantir é não alterar/corromper o dado
  // (nem "sanitizar" tirando algo que quebraria o registro), já que a
  // proteção real acontece no render do frontend, não na API. Estes testes
  // provam o round-trip: o payload malicioso é gravado e devolvido
  // exatamente como enviado, nunca executado nem interpretado como marcação
  // em nenhum ponto do próprio backend.
  const XSS_PAYLOADS = [
    "<script>alert(1)</script>",
    '<img src=x onerror=alert(1)>',
    "javascript:alert(document.cookie)",
  ];

  it.each(XSS_PAYLOADS)("título e descrição de necessidade com payload XSS (%s) são gravados e devolvidos literalmente", async (payload) => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const response = await postNeeds(
      buildRequest("needs", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, title: payload, description: payload, quantityNeeded: 10, unit: "unidade", priority: "media" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ need: { id: number; title: string } }>(response);
    expect(data.need.title).toBe(payload);

    const row = await db.selectFrom("needs").select(["title", "description"]).where("id", "=", data.need.id).executeTakeFirstOrThrow();
    expect(row.title).toBe(payload);
    expect(row.description).toBe(payload);
  });

  it("motivo (reason) de um lançamento de estoque com payload XSS é gravado literalmente", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);
    const item = await createTestInventoryItem(org.id, owner.userId);
    const payload = "<script>alert('estoque')</script>";

    const response = await postStockTransaction(
      buildRequest("stock-transactions", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, itemId: item.id, type: "entrada", quantity: 10, reason: payload },
      })
    );
    expect(response.status).toBe(200);

    const row = await db
      .selectFrom("stockTransactions")
      .select(["reason"])
      .where("itemId", "=", item.id)
      .executeTakeFirstOrThrow();
    expect(row.reason).toBe(payload);
  });

  it("nome de organização com payload XSS não é executado nem interpretado — apenas armazenado como texto", async () => {
    const owner = await createAuthenticatedUser();
    const payload = "<img src=x onerror=alert(1)>";

    const response = await postOrganizations(
      buildRequest("organizations", {
        method: "POST",
        cookie: owner.cookie,
        body: { name: payload, type: "organizacao_social", city: "Belo Horizonte", state: "MG" },
      })
    );
    expect(response.status).toBe(200);
    const data = await parseJson<{ organization: { name: string } }>(response);
    expect(data.organization.name).toBe(payload);
  });
});

describe("Fase 6 — ciclo de vida de convites e status de organização", () => {
  it("aceitar um convite JÁ ACEITO uma segunda vez não funciona (410), não gera segunda membership nem reabre o convite", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, email: "aceita-duas-vezes@example.com", role: "voluntario" },
      })
    );
    const { acceptUrl } = await parseJson<{ acceptUrl: string }>(inviteResponse);
    const token = acceptUrl.split("/convites/")[1];

    const invitedPerson = await createAuthenticatedUser({ email: "aceita-duas-vezes@example.com" });
    const firstAccept = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
    );
    expect(firstAccept.status).toBe(200);

    // Tentativa de reuso/reativação: mesmo token, mesma pessoa, de novo.
    const secondAccept = await postAccept(
      buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
    );
    expect(secondAccept.status).toBe(410);

    // Nenhuma segunda linha de membership, nenhum estado alterado.
    const memberships = await db
      .selectFrom("memberships")
      .select(["id", "status"])
      .where("organizationId", "=", org.id)
      .where("userId", "=", invitedPerson.userId)
      .execute();
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe("ativo");
  });

  it("não existe caminho para 'reativar' um convite revogado usando o mesmo token depois de uma tentativa de aceite falha (permanece revogado)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId);

    const inviteResponse = await postInvite(
      buildRequest("organization-invites", {
        method: "POST",
        cookie: owner.cookie,
        body: { organizationId: org.id, email: "revogado-reuso@example.com", role: "operador" },
      })
    );
    const { invite, acceptUrl } = await parseJson<{ invite: { id: number }; acceptUrl: string }>(inviteResponse);
    const token = acceptUrl.split("/convites/")[1];

    const { handle: postRevoke } = await import("../src/endpoints/organization-invites-revoke_POST");
    await postRevoke(
      buildRequest("organization-invites-revoke", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, inviteId: invite.id } })
    );

    const invitedPerson = await createAuthenticatedUser({ email: "revogado-reuso@example.com" });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await postAccept(
        buildRequest("organization-invites-accept", { method: "POST", cookie: invitedPerson.cookie, body: { token } })
      );
      expect(response.status).toBe(410);
    }

    const row = await db.selectFrom("organizationInvites").select(["status"]).where("id", "=", invite.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("revogado"); // nunca voltou a "pendente" por tentativa repetida
  });

  it("apenas admin de plataforma pode alterar organizations.status — proprietário da própria organização é bloqueado (403)", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });

    // Tentativa de alterar o próprio status diretamente pela API, sem ser
    // admin de plataforma — a organização não pode se "auto-aprovar".
    const response = await postPlatformOrgStatus(
      buildRequest("platform-organizations-status", { method: "POST", cookie: owner.cookie, body: { organizationId: org.id, status: "ativa" } })
    );
    expect(response.status).toBe(403);

    const row = await db.selectFrom("organizations").select(["status"]).where("id", "=", org.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("em_analise"); // não mudou
  });

  it("outro usuário sem nenhum vínculo com a organização também não consegue alterar seu status", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });
    const outsider = await createAuthenticatedUser();

    const response = await postPlatformOrgStatus(
      buildRequest("platform-organizations-status", { method: "POST", cookie: outsider.cookie, body: { organizationId: org.id, status: "ativa" } })
    );
    expect(response.status).toBe(403);
  });

  it("sem sessão autenticada, a alteração de status é rejeitada (401), nunca aplicada", async () => {
    const owner = await createAuthenticatedUser();
    const org = await createTestOrganization(owner.userId, { status: "em_analise" });

    const response = await postPlatformOrgStatus(
      buildRequest("platform-organizations-status", { method: "POST", body: { organizationId: org.id, status: "ativa" } })
    );
    expect(response.status).toBe(401);

    const row = await db.selectFrom("organizations").select(["status"]).where("id", "=", org.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("em_analise");
  });
});
