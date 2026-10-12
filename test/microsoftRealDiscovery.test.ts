/**
 * Fase 93 — validação contra o Discovery e o JWKS REAIS da Microsoft (endpoints públicos, SEM credenciais, SEM login).
 * Opt-in: só roda com MICROSOFT_REAL_DISCOVERY=1 (o CI e a regressão normal NUNCA dependem da rede). Isto NÃO é teste de login real:
 * não há aplicativo registrado, token, consentimento nem conta — só a FORMA do Discovery/JWKS contra o nosso código.
 */
import { describe, it, expect, afterEach } from "vitest";
import { SignJWT } from "jose";
import { __setMicrosoftTransportForTests, buildAuthorizationUrl, microsoftIssuerFor, MICROSOFT_PERSONAL_TENANT_ID, MicrosoftOidcError, verifyMicrosoftIdToken, type MicrosoftConfig } from "../src/helpers/microsoftOidc";
import { currentPepperVersion } from "../src/helpers/identityKeys";
import { oauthHash } from "../src/helpers/oauthPrimitives";

const enabled = process.env.MICROSOFT_REAL_DISCOVERY === "1";
const cfg = (tenant: string): MicrosoftConfig => ({
  clientId: "00000000-0000-4000-8000-000000000000",
  clientSecret: "nao-usado",
  redirectUri: "http://localhost:5173/_api/v1/auth/microsoft-callback",
  tenant,
  discoveryUrl: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
});

afterEach(() => __setMicrosoftTransportForTests(null));

describe.skipIf(!enabled)("Discovery/JWKS REAIS da Microsoft (somente leitura, sem credenciais)", () => {
  it("o nosso Discovery aceita o documento REAL de common, organizations e consumers e monta a URL de autorização oficial", async () => {
    for (const tenant of ["common", "organizations", "consumers"]) {
      __setMicrosoftTransportForTests(null); // transporte real + caches zerados
      const url = new URL(await buildAuthorizationUrl(cfg(tenant), { state: "s".repeat(43), nonce: "n".repeat(43), codeChallenge: "c".repeat(43) }));
      expect(url.origin + url.pathname, tenant).toBe(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    }
  }, 60_000);

  it("o JWKS REAL é lido e filtrado: kid real é encontrado (a assinatura falsa é rejeitada por ASSINATURA, não por chave desconhecida); kid inventado é desconhecido", async () => {
    const res = await fetch("https://login.microsoftonline.com/common/discovery/v2.0/keys");
    const jwks = (await res.json()) as { keys: Array<{ kid: string; kty: string; cloud_instance_name?: string; issuer?: string }> };
    expect(jwks.keys.length).toBeGreaterThan(0);
    const publicKey = jwks.keys.find((k) => k.kty === "RSA" && (k.cloud_instance_name ?? "microsoftonline.com") === "microsoftonline.com")!;
    const nonceHash = oauthHash("nonce", "n".repeat(43), currentPepperVersion());
    const forge = async (kid: string) => {
      // assinado por uma chave NOSSA qualquer: serve só para exercitar a busca do kid no JWKS real
      const { generateKeyPair } = await import("jose");
      const { privateKey } = await generateKeyPair("RS256");
      return new SignJWT({ sub: "x" }).setProtectedHeader({ alg: "RS256", kid }).sign(privateKey);
    };
    __setMicrosoftTransportForTests(null);
    const real = await verifyMicrosoftIdToken(cfg("common"), await forge(publicKey.kid), nonceHash, currentPepperVersion()).catch((e) => e);
    expect(real).toBeInstanceOf(MicrosoftOidcError);
    expect((real as MicrosoftOidcError).motivo).toBe("assinatura_invalida");
    const unknown = await verifyMicrosoftIdToken(cfg("common"), await forge("kid-que-nao-existe"), nonceHash, currentPepperVersion()).catch((e) => e);
    expect((unknown as MicrosoftOidcError).motivo).toBe("chave_desconhecida");
    // chaves de nuvens soberanas listadas no JWKS multi-nuvem NÃO são aceitas por esta aplicação
    const sovereign = jwks.keys.find((k) => k.cloud_instance_name && k.cloud_instance_name !== "microsoftonline.com");
    if (sovereign) {
      const gov = await verifyMicrosoftIdToken(cfg("common"), await forge(sovereign.kid), nonceHash, currentPepperVersion()).catch((e) => e);
      expect((gov as MicrosoftOidcError).motivo).toBe("chave_desconhecida");
    }
  }, 60_000);
  it("regra documentada pela Microsoft: emissor anunciado com {tenantid} trocado pelo tid == o iss que o código exige (common, organizations, consumers)", async () => {
    const corp = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    for (const tenant of ["common", "organizations", "consumers"]) {
      const doc = (await (await fetch(`https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`)).json()) as { issuer: string };
      const tid = tenant === "consumers" ? MICROSOFT_PERSONAL_TENANT_ID : corp;
      expect(doc.issuer.replace("{tenantid}", tid), tenant).toBe(microsoftIssuerFor(tid));
    }
  }, 60_000);
});
