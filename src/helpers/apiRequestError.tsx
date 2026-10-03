/**
 * Erro lançado pelos clientes de endpoint (`*_POST.schema.ts`) quando a API
 * responde com status de falha. Carrega o status HTTP para que a interface
 * possa distinguir 401 (sessão), 403 (sem permissão/acesso), 404, 409
 * (conflito de estado) e 5xx sem comparar texto de mensagem.
 *
 * Só é usado pelos clientes do ciclo de vida dos membros (Fase 73); os demais
 * clientes continuam lançando `Error` simples, sem mudança de comportamento.
 */
export class ApiRequestError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}
