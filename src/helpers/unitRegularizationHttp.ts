import superjson from "superjson";
import type { CaseOutcome } from "./unitRegularization.js";

const json = (status: number, body: unknown) => new Response(superjson.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Mapeia o resultado de uma operação de caso para a resposta HTTP (mensagens para a pessoa, sem detalhes internos). `ok` é tratado por quem chama. */
export function caseFailureResponse(outcome: Exclude<CaseOutcome, { type: "ok" }>): Response {
  switch (outcome.type) {
    case "not_found":
      return json(404, { message: "Caso de regularização não encontrado" });
    case "invalid_state":
      return json(409, { message: `Este caso não aceita mais esta ação (situação atual: ${outcome.status}).` });
    case "source_not_receivable":
      return json(409, { message: `O recurso deste caso já não está num estado em que o recebimento possa ser concluído (situação: ${outcome.status}).` });
    case "item_changed":
      return json(409, { message: "A unidade do item mudou desde a abertura do caso; encerre o caso e registre o recebimento novamente." });
    case "forbidden_same_person":
      return json(403, { message: "A conferência precisa ser validada por outra pessoa com permissão de administração." });
    case "needs_second_validation":
      return json(409, { message: "A conferência foi registrada e aguarda a validação de outra pessoa." });
    case "still_incompatible":
      return json(409, { message: `A unidade informada continua incompatível com a do item. ${outcome.detail} Use a conferência física.` });
    case "invalid_unit":
      return json(400, { message: outcome.message });
    case "has_dependents":
      return json(409, { message: outcome.message });
    case "claim_failed":
      return json(409, { message: "O recurso deste caso já não pode ser recebido (já recebido ou cancelado)." });
  }
}

export const okJson = (body: unknown) => json(200, body);
