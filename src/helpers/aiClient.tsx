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

async function chat(params: ChatInput): Promise<ChatOutput> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new AiNotConfiguredError();
  }

  const model = params.model && params.model !== "gpt-5.6-luna" ? params.model : DEFAULT_MODEL;

  const response = await fetch(ANTHROPIC_API_URL, {
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
  });

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
