/**
 * Substituto real do adaptador de IA da Levora Solidária, no lugar do
 * pacote proprietário "@floot/ai" que só existe dentro da plataforma Floot.
 *
 * Por que este arquivo existe: helpers/opportunityMatching.tsx usa IA
 * apenas como apoio ao motor de correspondência (nunca como decisão —
 * ver ALGORITHM_VERSION e a lógica de fallback nesse arquivo). Fora do
 * Floot não existe mais um provedor de IA embutido, então esta é a
 * integração real com um provedor externo (Anthropic), configurada por
 * variável de ambiente, seguindo a regra do projeto contra fake features:
 * nenhuma simulação de resposta de IA — se a chave não estiver configurada,
 * o adaptador informa isso explicitamente (erro claro) e quem chama decide
 * o que fazer (no caso do motor de matching, ele já cai para o escore por
 * palavra-chave, nunca inventa uma pontuação).
 *
 * Configuração (.env):
 *   ANTHROPIC_API_KEY=sk-ant-...      (obrigatório para IA real)
 *   LEVORA_AI_MODEL=claude-haiku-4-5-20251001   (opcional, tem default)
 */

export class FlootAiOutOfCreditsError extends Error {
  constructor(message?: string) {
    super(message ?? "Provedor de IA sem crédito/limite disponível");
    this.name = "FlootAiOutOfCreditsError";
  }
}

export class AiNotConfiguredError extends Error {
  constructor() {
    super(
      "IA não configurada: defina ANTHROPIC_API_KEY no ambiente para habilitar o apoio de IA no matching. " +
        "O sistema continua funcionando com o escore determinístico (por palavra-chave), sem IA."
    );
    this.name = "AiNotConfiguredError";
  }
}

interface ChatInput {
  model?: string;
  input: string;
}

interface ChatOutput {
  output_text: string;
}

const DEFAULT_MODEL = process.env.LEVORA_AI_MODEL || "claude-haiku-4-5-20251001";
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

export class AiTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Chamada de IA excedeu o tempo limite de ${timeoutMs}ms`);
    this.name = "AiTimeoutError";
  }
}

// Fase 64 — achado real da Fase 63: opportunityMatching.tsx chama esta
// função DENTRO de uma transação do Postgres (db.transaction(), uma
// conexão do pool de só 3 presa até o COMMIT), e até aqui esta chamada
// HTTP nunca teve nenhum limite de tempo — uma lentidão ou travamento do
// provedor de IA prenderia essa conexão indefinidamente, recriando a
// mesma classe de esgotamento de pool que a Fase 62 encontrou no
// scheduler. Investigado se seria seguro separar a chamada de IA da
// transação (ela não usa `trx` nem precisa de nenhum dado só disponível
// dentro dela — já recebe `opportunityText`/`candidates` já resolvidos em
// memória): não é seguro sem uma reestruturação maior, porque o
// `SELECT ... FOR UPDATE` da oportunidade protege a consistência de
// `remaining`/`existingOrgIds` contra execuções concorrentes do mesmo
// matching, e esse lock só existe enquanto a transação está aberta —
// encerrar e reabrir a transação ao redor da chamada de IA reintroduziria
// uma corrida real sobre quanto da oportunidade já foi alocado, exigindo
// revalidação explícita do estado no ponto de escrita (fora do escopo
// desta fase, que proíbe alterar semântica do Matching 1.4). A correção
// escolhida, menor e segura, é limitar o tempo máximo que a chamada pode
// manter a conexão presa: 8 segundos — generoso para a latência real do
// modelo usado (Haiku, até 1024 tokens de saída, lote de no máximo 20
// candidatos), bem abaixo de "sem limite nenhum", e sem efeito no
// resultado funcional (o fallback determinístico por palavra-chave já
// existia para qualquer falha de IA, incluindo timeout).
const AI_CHAT_TIMEOUT_MS = 8_000;

async function chat(params: ChatInput): Promise<ChatOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError();
  }

  const model = params.model && params.model !== "gpt-5.6-luna" ? params.model : DEFAULT_MODEL;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_CHAT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: params.input }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    // AbortController.abort() faz o fetch rejeitar com um DOMException
    // "AbortError" — convertido aqui num erro nomeado e específico para
    // que quem chama (e os logs) distingam timeout de qualquer outra
    // falha de rede, sem mudar o tratamento (opportunityMatching.tsx já
    // trata qualquer erro daqui como "seguir sem IA").
    if (err instanceof Error && err.name === "AbortError") {
      throw new AiTimeoutError(AI_CHAT_TIMEOUT_MS);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429 || response.status === 402) {
    throw new FlootAiOutOfCreditsError(`Provedor de IA retornou ${response.status}`);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Falha na chamada de IA (${response.status}): ${body.slice(0, 500)}`);
  }

  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  return { output_text: text };
}

export const flootAi = { chat };
