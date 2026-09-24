/**
 * Contrato comum a todo conector de descoberta de oportunidades.
 *
 * Qualquer fonte nova (site público, Facebook/Meta, X, e-mail autorizado,
 * formulário, etc.) deve implementar esta interface para se conectar ao
 * núcleo da Levora Solidária sem alterá-lo. Hoje só existe UMA implementação
 * real: `manualConnector` (helpers/connectorsManual.tsx) — descoberta feita
 * por um humano autorizado, não automação.
 *
 * Nenhum conector para uma fonte sem credencial configurada deve ser
 * registrado como `status: 'ativa'`. Enquanto não configurado, a fonte fica
 * `status: 'nao_configurada'` e a interface mostra literalmente
 * "Conector não configurado" — nunca um resultado simulado.
 */

import type { SourceType } from "./schema";

/** Uma oportunidade normalizada, pronta para virar uma linha em
 * `opportunity_registry`. Todo conector deve produzir exatamente este
 * formato, seja a fonte humana ou automatizada. */
export interface NormalizedDiscovery {
  title: string;
  description?: string;
  category?: string;
  quantity?: number;
  unit?: string;
  condition?: string;
  locationCity?: string;
  locationState?: string;
  availability?: string;
  originReference?: string;
  originContact?: string;
  /** Referência externa estável usada para deduplicação (ex: URL do
   * anúncio, ID do post, hash do conteúdo). Sem isso, o conector não pode
   * detectar duplicidade — obrigatório. */
  dedupeKey: string;
  /** Confiança do próprio conector na qualidade da descoberta, 0–100.
   * Para entrada manual, é a confiança que o operador declarou; para um
   * conector automatizado, deve refletir um cálculo real (nunca um número
   * fixo "porque sim"). */
  confidence?: number;
  evidenceUrl?: string;
}

export interface ConnectorRunContext {
  sourceId: number;
  /** Quem disparou esta execução — obrigatório para auditoria. */
  triggeredByUserId: number | null;
  /** Limite de itens a processar nesta execução (rate_limit_per_run). */
  maxItems?: number;
}

export interface ConnectorRunResult {
  discoveries: NormalizedDiscovery[];
  /** Itens descartados por deduplicação, com o motivo. */
  duplicatesSkipped: Array<{ dedupeKey: string; reason: string }>;
  errors: Array<{ message: string; occurredAt: string }>;
  /** Estado de conexão após a execução — usado para atualizar
   * `sources.connection_state` e `sources.status`. */
  connectionState: "conectado" | "nao_conectado" | "expirado" | "erro";
}

export interface SourceConnector {
  /** Chave estável usada em `sources.connector_key`. */
  readonly key: string;
  readonly sourceType: SourceType;

  /** 1. Identificação: descrição legível do que este conector faz. */
  describe(): string;

  /** 2. Autenticação: verifica se a credencial referenciada em
   * `sources.credential_ref` está presente e válida. Deve retornar
   * `configured: false` em vez de lançar erro quando a fonte simplesmente
   * não foi configurada ainda — isso é o caminho normal, não uma falha. */
  checkAuthentication(sourceId: number): Promise<{ configured: boolean; detail?: string }>;

  /** 3+4. Descoberta e coleta dos dados brutos da fonte. Deve respeitar
   * `context.maxItems` e a política da fonte (`sources.policy_notes`,
   * `sources.rate_limit_per_run`). */
  run(context: ConnectorRunContext): Promise<ConnectorRunResult>;

  /** 12. Renovação de credencial — para conectores com token que expira. O
   * conector manual não implementa (não tem credencial). */
  renewCredential?(sourceId: number): Promise<{ renewed: boolean; detail?: string }>;

  /** 13. Monitoramento — snapshot de saúde para a tela de fontes. */
  getHealth(sourceId: number): Promise<{
    connectionState: "conectado" | "nao_conectado" | "expirado" | "erro";
    lastError: string | null;
  }>;

  /** 11. Desligamento — encerra qualquer sessão/recurso mantido pelo
   * conector para esta fonte (sessões, sockets, tokens em memória). */
  shutdown(sourceId: number): Promise<void>;
}
