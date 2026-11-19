import { randomUUID } from "node:crypto";

/**
 * M39 — identificador de CORRELAÇÃO: liga, de forma persistida, operação → evento → execução do agente → exceção → auditoria.
 * Regras: gerado NO SERVIDOR (UUID v4) na origem da operação; nunca aceito de cliente externo; não carrega dados (é aleatório, não contém organização, usuário nem recurso);
 * é DIFERENTE do identificador do recurso (`entity_id`) e do identificador de uma operação pontual (`metadata.correlacao`, M36/M37). Registros históricos não ganham correlação retroativa.
 */
export const CORRELATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newCorrelationId(): string {
  return randomUUID();
}

export function isCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}
