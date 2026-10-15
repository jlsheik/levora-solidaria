import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePermissionToRead } from "../helpers/organizationAccess.js";
import { roleHasPermission } from "../helpers/permissions.js";
import { schema, type OutputType, type RegularizationCase } from "./unit-regularization-cases_GET.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

const LIMIT = 200;

const STATUS_LABEL: Record<RegularizationCase["status"], string> = {
  aberto: "Aberto",
  conferido: "Conferido, aguardando validação",
  resolvido: "Resolvido",
  corrigido: "Cadastro corrigido",
  encerrado: "Encerrado sem resolução",
};

function nextAction(status: RegularizationCase["status"], itemUnit: string): string {
  switch (status) {
    case "aberto":
      return `Conferir a quantidade na unidade do item ("${itemUnit}"), corrigir a unidade da oferta se o cadastro estiver errado, ou encerrar o caso se não for possível resolver.`;
    case "conferido":
      return "Aguardando validação por outra pessoa com permissão de administração.";
    case "resolvido":
      return "Concluído: o recebimento foi lançado no estoque.";
    case "corrigido":
      return "Unidade corrigida: registre o recebimento normalmente.";
    case "encerrado":
      return "Encerrado sem resolução: nada foi lançado no estoque.";
  }
}

/**
 * Fase 99C — fila de pendências de unidade da organização. Leitura para quem lança logística (proprietário, administrador, operador): `logistica.gerencie`. Sempre escopada pela
 * organização; um caso de outra organização nunca aparece. Sem dados pessoais além do nome de exibição de quem agiu (membros da própria organização). Uma só consulta de casos
 * e uma de eventos (sem N+1).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    const url = new URL(request.url);
    const input = schema.parse({
      organizationId: url.searchParams.get("organizationId"),
      status: url.searchParams.get("status") ?? undefined,
      source: url.searchParams.get("source") ?? undefined,
      category: url.searchParams.get("category") ?? undefined,
      order: url.searchParams.get("order") ?? undefined,
    });
    const membership = await requirePermissionToRead(user.id, input.organizationId, "logistica.gerencie");
    const canManage = roleHasPermission(membership.role, "organizacao.gerencie");

    let q = db
      .selectFrom("unitRegularizationCases as c")
      .innerJoin("inventoryItems as i", "i.id", "c.itemId")
      .leftJoin("opportunityAllocations as a", "a.id", "c.allocationId")
      .leftJoin("opportunityRegistry as r", "r.id", "a.opportunityRegistryId")
      .leftJoin("donationOpportunities as d", "d.id", "c.donationOpportunityId")
      .leftJoin("users as uo", "uo.id", "c.openedByUserId")
      .leftJoin("users as uc", "uc.id", "c.conferredByUserId")
      .leftJoin("users as uv", "uv.id", "c.validatedByUserId")
      .select([
        "c.id", "c.status", "c.sourceType", "c.divergenceKind", "c.category", "c.offeredQuantity", "c.offeredUnit", "c.informedQuantity", "c.itemUnit", "c.checkedQuantity",
        "c.checkedUnit", "c.divergenceReason", "c.createdAt", "c.withoutSecondValidation", "c.closedReason", "i.name as itemName", "r.title as registryTitle", "d.title as donationTitle",
        "uo.displayName as openedByName", "uc.displayName as conferredByName", "uv.displayName as validatedByName",
      ])
      .where("c.organizationId", "=", input.organizationId);
    if (input.status === "ativos") q = q.where("c.status", "in", ["aberto", "conferido"]);
    else if (input.status !== "todos") q = q.where("c.status", "=", input.status);
    if (input.source) q = q.where("c.sourceType", "=", input.source);
    if (input.category) q = q.where("c.category", "=", input.category);
    const rows = await q.orderBy("c.createdAt", input.order === "antigos" ? "asc" : "desc").orderBy("c.id", "asc").limit(LIMIT + 1).execute();
    const truncated = rows.length > LIMIT;
    const page = rows.slice(0, LIMIT);

    const ids = page.map((r) => r.id);
    const eventRows = ids.length
      ? await db
          .selectFrom("unitRegularizationEvents as e")
          .leftJoin("users as u", "u.id", "e.actorUserId")
          .select(["e.id", "e.caseId", "e.eventType", "e.fieldRef", "e.previousValue", "e.newValue", "e.quantityBefore", "e.quantityAfter", "e.reason", "e.createdAt", "u.displayName as actorName"])
          .where("e.organizationId", "=", input.organizationId)
          .where("e.caseId", "in", ids)
          .orderBy("e.id", "asc")
          .execute()
      : [];
    const eventsByCase = new Map<string, RegularizationCase["events"]>();
    for (const e of eventRows) {
      const list = eventsByCase.get(String(e.caseId)) ?? [];
      list.push({ id: Number(e.id), eventType: e.eventType, actorName: e.actorName, fieldRef: e.fieldRef, previousValue: e.previousValue, newValue: e.newValue, quantityBefore: e.quantityBefore === null ? null : Number(e.quantityBefore), quantityAfter: e.quantityAfter === null ? null : Number(e.quantityAfter), reason: e.reason, createdAt: e.createdAt.toISOString() });
      eventsByCase.set(String(e.caseId), list);
    }

    const active = await db
      .selectFrom("unitRegularizationCases")
      .select((eb) => eb.fn.countAll<string>().as("n"))
      .where("organizationId", "=", input.organizationId)
      .where("status", "in", ["aberto", "conferido"])
      .executeTakeFirstOrThrow();

    const cases: RegularizationCase[] = page.map((r) => {
      const isActive = r.status === "aberto" || r.status === "conferido";
      return {
        id: r.id,
        status: r.status,
        statusLabel: STATUS_LABEL[r.status],
        sourceType: r.sourceType,
        sourceLabel: r.sourceType === "allocation" ? "Atribuição da rede Levora" : "Doação local",
        divergenceKind: r.divergenceKind,
        divergenceLabel: r.divergenceKind === "unidade_ausente" ? "Oferta sem unidade informada" : r.divergenceKind === "unidade_diferente" ? "Unidade diferente da do item" : "Unidade sem equivalência comprovada",
        category: r.category,
        blockedStage: "Recebimento (nada foi lançado no estoque)",
        resourceTitle: r.registryTitle ?? r.donationTitle ?? "Recurso",
        itemName: r.itemName,
        itemUnit: r.itemUnit,
        offeredQuantity: r.offeredQuantity === null ? null : Number(r.offeredQuantity),
        offeredUnit: r.offeredUnit,
        informedQuantity: Number(r.informedQuantity),
        checkedQuantity: r.checkedQuantity === null ? null : Number(r.checkedQuantity),
        checkedUnit: r.checkedUnit,
        divergenceReason: r.divergenceReason,
        openedAt: r.createdAt.toISOString(),
        openedByName: r.openedByName,
        conferredByName: r.conferredByName,
        validatedByName: r.validatedByName,
        withoutSecondValidation: r.withoutSecondValidation,
        closedReason: r.closedReason,
        nextAction: nextAction(r.status, r.itemUnit),
        canConfer: isActive && r.status === "aberto",
        canValidate: canManage && r.status === "conferido",
        canClose: canManage && isActive,
        // a oferta da rede só é corrigida pela plataforma; a doação local, pela própria organização (proprietário/administrador)
        canCorrect: canManage && isActive && r.sourceType === "local_donation",
        events: eventsByCase.get(String(r.id)) ?? [],
      };
    });

    const output: OutputType = { cases, activeCount: Number(active.n), truncated };
    return new Response(superjson.stringify(output), { headers: { "Content-Type": "application/json" } });
  } catch (error: unknown) {
    console.error("Erro ao listar as pendências de unidade:", error);
    return buildErrorResponse(error, "Falha ao carregar as pendências de unidade");
  }
}
