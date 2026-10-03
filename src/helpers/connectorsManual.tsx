import type { SourceConnector, ConnectorRunContext, ConnectorRunResult } from "./connectorsTypes";

/**
 * Único conector real disponível hoje: descoberta manual por um operador de
 * plataforma autorizado (`platform_access` ativo). Não acessa nenhuma rede
 * externa — a "coleta" é a submissão de um formulário por um humano, feita
 * diretamente pelo endpoint `opportunities-registry_POST`. `run()` existe
 * apenas para cumprir o contrato `SourceConnector` e não tem nada a
 * executar em segundo plano: não há fila, não há agendamento, porque não
 * há nada automático a rodar.
 */
export const manualConnector: SourceConnector = {
  key: "manual",
  sourceType: "manual",

  describe() {
    return "Descoberta manual: um operador de plataforma registra à mão uma oportunidade que encontrou.";
  },

  async checkAuthentication() {
    return { configured: true, detail: "Não requer credencial — é entrada humana direta." };
  },

  async run(_context: ConnectorRunContext): Promise<ConnectorRunResult> {
    return {
      discoveries: [],
      duplicatesSkipped: [],
      errors: [],
      connectionState: "conectado",
    };
  },

  async getHealth() {
    return { connectionState: "conectado", lastError: null };
  },

  async shutdown() {
    // Nada a encerrar — não há sessão externa.
  },
};
