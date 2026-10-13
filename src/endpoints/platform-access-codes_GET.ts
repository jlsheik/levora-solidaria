import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { buildErrorResponse } from "../helpers/errorResponse.js";
import { deriveCodeStatus, maskAccessCode } from "../helpers/registrationCodes.js";
import { jsonResponse } from "../helpers/authResponses.js";
import { NotAuthenticatedError } from "../helpers/getSetServerSession.js";
import { schema } from "./platform-access-codes_GET.schema.js";

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Lista os códigos de acesso para a PLATAFORMA (owner/admin ativos; verificado no backend). Nunca devolve o código completo nem o
 * hash — só o mascarado (`LEV-••••-…-A7K2`). A interface administrativa vê o motivo/estado detalhado (ao contrário do cadastro
 * público, que responde igual para qualquer código inutilizável).
 */
export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);
    const url = new URL(request.url);
    const input = schema.parse({
      status: url.searchParams.get("status") || undefined,
      q: url.searchParams.get("q") || undefined,
      createdFrom: url.searchParams.get("createdFrom") || undefined,
      createdTo: url.searchParams.get("createdTo") || undefined,
      limit: url.searchParams.get("limit") || undefined,
      offset: url.searchParams.get("offset") || undefined,
    });
    const now = new Date();

    let query = db
      .selectFrom("registrationAccessCodes as c")
      .innerJoin("users as creator", "creator.id", "c.createdByUserId")
      .leftJoin("users as redeemer", "redeemer.id", "c.redeemedByUserId")
      .leftJoin("users as revoker", "revoker.id", "c.revokedByUserId");

    if (input.status === "redeemed") query = query.where("c.redeemedAt", "is not", null);
    if (input.status === "revoked") query = query.where("c.revokedAt", "is not", null);
    if (input.status === "active") query = query.where("c.redeemedAt", "is", null).where("c.revokedAt", "is", null).where("c.expiresAt", ">", now);
    if (input.status === "expired") query = query.where("c.redeemedAt", "is", null).where("c.revokedAt", "is", null).where("c.expiresAt", "<=", now);
    if (input.createdFrom) query = query.where("c.createdAt", ">=", input.createdFrom);
    if (input.createdTo) query = query.where("c.createdAt", "<", input.createdTo);
    if (input.q) {
      const like = `%${escapeLike(input.q)}%`;
      const last4 = input.q.trim().toUpperCase();
      query = query.where((eb) =>
        eb.or([
          eb("c.label", "ilike", like),
          ...(last4.length === 4 ? [eb("c.codeLast4", "=", last4)] : []),
          eb("redeemer.displayName", "ilike", like),
          eb("redeemer.email", "ilike", like),
        ])
      );
    }

    const total = await query.select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow();
    const rows = await query
      .select([
        "c.id",
        "c.codeLast4",
        "c.label",
        "c.createdAt",
        "c.expiresAt",
        "c.revokedAt",
        "c.redeemedAt",
        "creator.id as creatorId",
        "creator.displayName as creatorName",
        "redeemer.id as redeemerId",
        "redeemer.displayName as redeemerName",
        "redeemer.email as redeemerEmail",
        "revoker.displayName as revokerName",
      ])
      .orderBy("c.createdAt", "desc")
      .orderBy("c.id", "desc")
      .limit(input.limit)
      .offset(input.offset)
      .execute();

    return jsonResponse(200, {
      total: Number(total.n),
      codes: rows.map((r) => ({
        id: r.id,
        masked: maskAccessCode(r.codeLast4),
        last4: r.codeLast4,
        label: r.label,
        status: deriveCodeStatus({ redeemedAt: r.redeemedAt, revokedAt: r.revokedAt, expiresAt: r.expiresAt }, now),
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
        createdBy: { id: r.creatorId, displayName: r.creatorName },
        redeemedAt: r.redeemedAt,
        redeemedBy: r.redeemerId === null ? null : { id: r.redeemerId, displayName: r.redeemerName, email: r.redeemerEmail },
        revokedAt: r.revokedAt,
        revokedBy: r.revokerName,
      })),
    });
  } catch (error: unknown) {
    if (error instanceof NotAuthenticatedError) return jsonResponse(401, { error: "Not authenticated" });
    console.error("Erro ao listar códigos de acesso:", error instanceof Error ? error.name : "erro");
    return buildErrorResponse(error, "Não foi possível listar os códigos");
  }
}
