import { db } from "../helpers/db.js";
import { getServerUserSession } from "../helpers/getServerUserSession.js";
import { requirePlatformAdmin } from "../helpers/platformAccess.js";
import { recordAuditLogEntry } from "../helpers/auditLog.js";
import { schema } from "./sources_POST.schema.js";
import superjson from "superjson";
import { buildErrorResponse } from "../helpers/errorResponse.js";

export async function handle(request: Request) {
  try {
    const { user } = await getServerUserSession(request);
    await requirePlatformAdmin(user.id);

    const json = superjson.parse(await request.text());
    const input = schema.parse(json);

    // Regra de segurança imposta pelo servidor, não pela interface: uma
    // fonte só nasce "ativa"/"conectada" quando é o conector manual (que
    // não depende de credencial nenhuma). Qualquer outro tipo nasce
    // "não configurada" até que uma verificação real de autenticação passe
    // — isso nunca pode ser contornado só marcando um campo no formulário.
    const isManual = input.connectorKey === "manual";

    const source = await db.transaction().execute(async (trx) => {
      const [created] = await trx
        .insertInto("sources")
        .values({
          name: input.name,
          type: input.type,
          connectorKey: input.connectorKey,
          endpointOrAddress: input.endpointOrAddress || null,
          accessMethod: input.accessMethod || null,
          credentialRef: input.credentialRef || null,
          authorizingOrganizationId: input.authorizingOrganizationId || null,
          policyNotes: input.policyNotes || null,
          runFrequencyMinutes: input.runFrequencyMinutes || null,
          rateLimitPerRun: input.rateLimitPerRun || null,
          status: isManual ? "ativa" : "nao_configurada",
          connectionState: isManual ? "conectado" : "nao_conectado",
          createdByUserId: user.id,
        })
        .returning(["id", "name", "status"])
        .execute();

      await recordAuditLogEntry(
        {
          organizationId: null,
          actorUserId: user.id,
          action: "fonte.registrada",
          entityType: "source",
          entityId: String(created.id),
          metadata: { name: created.name, type: input.type, connectorKey: input.connectorKey, status: created.status },
        },
        trx
      );

      return created;
    });

    return new Response(superjson.stringify({ source }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("Erro ao cadastrar fonte:", error);
    return buildErrorResponse(error, "Não foi possível cadastrar a fonte");
  }
}
