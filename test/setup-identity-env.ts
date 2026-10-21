/**
 * Chaves de IDENTIDADE só para os testes (Fase 90). Valores FIXOS e públicos de propósito: não protegem nada, existem apenas
 * para a camada de MFA ter pepper/chave de cifra determinísticos. Nunca reutilizar fora de teste. Roda ANTES de test/setup.ts.
 */
process.env.IDENTITY_CODE_PEPPER_V1 = "teste-pepper-v1-0123456789abcdef0123456789abcdef";
process.env.IDENTITY_CODE_PEPPER_CURRENT = "1";
process.env.MFA_ENCRYPTION_KEY_V1 = Buffer.alloc(32, 7).toString("base64");
process.env.MFA_ENCRYPTION_KEY_CURRENT = "1";
delete process.env.PLATFORM_MFA_REQUIRED;
delete process.env.LEVORA_ENVIRONMENT;
