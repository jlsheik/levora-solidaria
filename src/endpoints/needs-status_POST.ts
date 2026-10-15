import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission } from "../helpers/organizationAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./needs-status_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    const result = await db.transaction().execute(async (trx) => {
      // FOR UPDATE (achado de auditoria, Fase 35): trava a linha da need ANTES
      // de decidir `willConsumeStock` a partir do seu status. Sem isso, duas
      // requisições concorrentes marcando a MESMA need como "atendida" podiam
      // ambas ler `status="aberta"` (READ COMMITTED, antes de qualquer commit)
      // e ambas decidir dar baixa — baixa de estoque em dobro para a mesma
      // necessidade, reproduzido deterministicamente na auditoria. Travar a
      // linha aqui serializa as duas transações; quando a segunda finalmente
      // adquire a trava (depois do commit da primeira), o Postgres reavalia
      // FOR UPDATE contra a versão JÁ ATUALIZADA da linha — a segunda
      // requisição enxerga `status="atendida"` de verdade, não a leitura
      // obsoleta de antes de travar, e corretamente decide não dar baixa de
      // novo (mesmo comportamento de idempotência já coberto por teste, agora
      // também seguro sob concorrência real).
      const existing = await trx
        .selectFrom("needs")
        .select(["id", "status", "title", "itemId", "quantityNeeded", "unit"])
        .where("id", "=", input.needId)
        .where("organizationId", "=", input.organizationId)
        // FOR NO KEY UPDATE (Fase 81): continua serializando duas mudanças de status da MESMA need (conflita com ele mesmo, com
        // FOR UPDATE e com qualquer UPDATE da linha — o que a Fase 35 exige), mas NÃO conflita com o FOR KEY SHARE que a FK de
        // need_fulfillments toma ao registrar um recebimento. Com FOR UPDATE, este fluxo (need → item) e o recebimento
        // (item → FK → need) fechavam um ciclo: deadlock real (40P01), reproduzido pelo endpoint real.
        .forNoKeyUpdate()
        .executeTakeFirst();

      if (!existing) return { type: "not_found" as const };

      // Resolução administrativa (Fase 40, achado da Fase 38): a baixa de
      // estoque próprio deve acontecer NO MÁXIMO UMA VEZ em toda a vida da
      // need, nunca uma vez por transição de status — reabrir e reatender
      // (needs.status continua livre, Fase 35/37) não deve gerar uma
      // segunda baixa. `need_resolutions` (UNIQUE(need_id)) é o registro
      // estrutural de "esta need já foi administrativamente resolvida uma
      // vez". A checagem abaixo acontece DEPOIS de travar a linha da need
      // (FOR UPDATE, acima) — a mesma trava que já serializa a Fase 35
      // também serializa esta decisão, então duas requisições concorrentes
      // (inclusive uma delas chegando logo após uma reabertura) nunca veem
      // "sem resolução ainda" ao mesmo tempo.
      const existingResolution = input.status === "atendida"
        ? await trx.selectFrom("needResolutions").select(["id"]).where("needId", "=", existing.id).executeTakeFirst()
        : undefined;

      // Fase 99E: marcar como "atendida" NUNCA mais baixa estoque (a baixa automática de toda a quantidade criava uma saída sem finalidade e confundia "atendida" com
      // "saiu do estoque"). Toda saída física nasce no registro de destinação (POST /stock-destinations). Entrando em "atendida" pela primeira vez (sem resolução ainda), fica só a
      // resolução ADMINISTRATIVA declarativa (stockTransactionId = null), com ou sem item vinculado: o evento continua identificável e o relatório sinaliza se a quantidade
      // destinada ainda não alcança a necessária. A nova regra de atendimento (derivado das destinações, com entrega parcial) é da Fase 99F.
      const willCreateDeclarativeResolution = input.status === "atendida" && !existingResolution;
      if (willCreateDeclarativeResolution) {
        await trx
          .insertInto("needResolutions")
          .values({ needId: existing.id, stockTransactionId: null, createdByUserId: user.id })
          .execute();
      }

      const [updated] = await trx
        .updateTable("needs")
        .set({ status: input.status, updatedAt: new Date() })
        .where("id", "=", input.needId)
        .returning(["id", "status"])
        .execute();

      // As duas gravações de auditoria ficam juntas, no fim da transação —
      // recordAuditLogEntry segura um advisory lock global até o commit
      // (ver comentário em auditLog.tsx), então quanto menos trabalho
      // acontecer DEPOIS dela dentro desta transação, menos tempo outras
      // transações que também precisam gravar em audit_log ficam esperando.
      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.status_alterado",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status, baixaEstoqueAutomatica: false, resolucaoDeclarativa: willCreateDeclarativeResolution },
        },
        trx
      );

      return { type: "success" as const, need: updated };
    });

    if (result.type === "not_found") {
      return new Response(
        superjson.stringify({ message: "Necessidade não encontrada nesta organização" }),
        { status: 404, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(superjson.stringify({ need: result.need }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao atualizar necessidade:", error);
    return buildErrorResponse(error, "Não foi possível atualizar a necessidade");
  }
}
