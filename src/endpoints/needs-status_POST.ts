import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermission, OrganizationAccessError } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { getItemStockBalance } from "../helpers/stockBalance.js";
import { schema } from "./needs-status_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    const membership = await requirePermission(user.id, input.organizationId, "necessidades.gerencie");

    // Marcar como "atendida" pode disparar baixa automática de estoque (ver
    // abaixo) — uma mutação de estoque de verdade, não só de necessidade.
    // Exige explicitamente inventario.lance também, em vez de confiar que
    // todo papel com necessidades.gerencie sempre vai ter inventario.lance
    // (verdade hoje em src/helpers/permissions.tsx, mas não uma garantia
    // que este endpoint deveria depender silenciosamente do catálogo nunca
    // mudar).
    if (input.status === "atendida" && !roleHasPermission(membership.role, "inventario.lance")) {
      throw new OrganizationAccessError("Seu papel nesta organização não permite dar baixa em estoque, necessária para marcar esta necessidade como atendida");
    }

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

      // Vínculo automático necessidade→estoque (master prompt, "estoque
      // atualizado" nunca sem transação registrada): só dispara na
      // transição PARA "atendida" vinda de outro status, só quando a
      // necessidade está vinculada a um item de inventário, e só quando
      // ainda NÃO existe uma resolução para esta need. Reverter o status
      // depois NÃO desfaz a saída automaticamente nem a resolução — isso
      // exigiria um lançamento manual explícito (ajuste), para nunca
      // alterar o histórico de estoque em silêncio.
      const willConsumeStock = input.status === "atendida" && existing.status !== "atendida" && existing.itemId !== null && !existingResolution;
      // Entrando em "atendida" pela primeira vez (nenhuma resolução ainda),
      // mesmo sem item vinculado: cria uma resolução puramente declarativa
      // (stockTransactionId=null) — o evento administrativo continua
      // identificável historicamente, mesmo sem lastro físico.
      const willCreateDeclarativeResolution = input.status === "atendida" && !existingResolution && existing.itemId === null;
      let stockAuditEntry: { itemId: number; itemName: string; delta: number } | null = null;

      if (willConsumeStock) {
        const item = await trx
          .selectFrom("inventoryItems")
          .select(["id", "name"])
          .where("id", "=", existing.itemId!)
          .where("organizationId", "=", input.organizationId)
          .forUpdate()
          .executeTakeFirst();

        // Item foi excluído/movido depois que a necessidade foi criada —
        // não impede marcar como atendida, mas não há como dar baixa (nem
        // como criar uma resolução com lastro físico — fica sem resolução
        // nenhuma nesse caso raro, igual ao comportamento pré-existente).
        if (item) {
          const currentStock = await getItemStockBalance(trx, item.id);
          const quantity = Number(existing.quantityNeeded);
          const newStock = currentStock - quantity;

          if (newStock < 0) {
            return { type: "insufficient_stock" as const, currentStock, quantity, itemName: item.name };
          }

          const [tx] = await trx
            .insertInto("stockTransactions")
            .values({
              organizationId: input.organizationId,
              itemId: item.id,
              type: "saida",
              delta: -quantity,
              reason: `Baixa automática: necessidade "${existing.title}" marcada como atendida`,
              createdByUserId: user.id,
            })
            .returning(["id"])
            .execute();

          stockAuditEntry = { itemId: item.id, itemName: item.name, delta: -quantity };

          await trx
            .insertInto("needResolutions")
            .values({ needId: existing.id, stockTransactionId: tx.id, createdByUserId: user.id })
            .execute();
        }
      } else if (willCreateDeclarativeResolution) {
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
      if (stockAuditEntry) {
        await recordAuditLogEntry(
          {
            organizationId: input.organizationId,
            actorUserId: user.id,
            action: "inventario.saida_registrada",
            entityType: "inventory_item",
            entityId: String(stockAuditEntry.itemId),
            metadata: { delta: stockAuditEntry.delta, itemName: stockAuditEntry.itemName, motivo: "necessidade_atendida", needId: existing.id },
          },
          trx
        );
      }

      await recordAuditLogEntry(
        {
          organizationId: input.organizationId,
          actorUserId: user.id,
          action: "necessidade.status_alterado",
          entityType: "need",
          entityId: String(input.needId),
          metadata: { title: existing.title, statusAnterior: existing.status, statusNovo: input.status, baixaEstoqueAutomatica: willConsumeStock },
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

    if (result.type === "insufficient_stock") {
      return new Response(
        superjson.stringify({
          message: `Não é possível marcar como atendida: o item "${result.itemName}" tem saldo de ${result.currentStock}, insuficiente para a quantidade necessária de ${result.quantity}. Ajuste o estoque ou a quantidade antes de tentar novamente.`,
        }),
        { status: 409, headers: { "Content-Type": "application/json" } }
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
