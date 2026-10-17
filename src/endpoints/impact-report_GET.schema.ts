import { z } from "zod";
import superjson from "superjson";
import { ApiRequestError } from "../helpers/apiRequestError.js";
import { DESTINATION_TYPES } from "../helpers/destinationRules.js";
import type { NeedAttendanceProgress } from "../helpers/needAttendance.js";
import type { DestinationReport } from "../helpers/impactDestinationReport.js";

export const REPORT_EVENT_TYPES = ["recebimento", "entrada_manual", "correcao", "estorno"] as const;
export type ReportEventType = (typeof REPORT_EVENT_TYPES)[number];

// null/"" (parâmetro ausente na query string) vira undefined.
const optionalId = z.preprocess((v) => (v === null || v === "" || v === undefined ? undefined : v), z.coerce.number().int().positive().optional());

export const schema = z.object({
  organizationId: z.coerce.number().int().positive(),
  // Intervalo SEMIABERTO: `startDate` inclusivo (início do dia), `endDate` EXCLUSIVO (início do dia seguinte).
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  itemId: optionalId,
  needId: optionalId,
  eventType: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.enum(REPORT_EVENT_TYPES).optional()),
  // Fase 99H: o bloco Destinação filtra por data de REGISTRO (padrão) ou por data EFETIVA da entrega, e opcionalmente por finalidade.
  destinationDateBasis: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.enum(["registro", "efetiva"]).default("registro")),
  destinationType: z.preprocess((v) => (v === null || v === "" ? undefined : v), z.enum(DESTINATION_TYPES).optional()),
});

export type ReceiptEvent = {
  kind: "correcao" | "reativacao" | "estorno";
  subtype: "positiva" | "negativa" | "unidade" | null;
  createdAt: string;
  inPeriod: boolean;
  quantityFrom: number | null;
  quantityTo: number | null;
  delta: number;
  unit: string;
  unitFrom: string | null;
  countedEffect: number;
  physical: { delta: number; withdrawal: boolean } | null;
  reason: string | null;
  authorName: string | null;
  approvedByName: string | null;
};

export type ReceiptGroup = {
  allocationId: number;
  opportunityTitle: string | null;
  needId: number | null;
  needTitle: string | null;
  item: { id: number; name: string; unit: string } | null;
  original: { quantity: number; unit: string; createdAt: string; inPeriod: boolean; isCountable: boolean; authorName: string | null; physicalDelta: number | null } | null;
  events: ReceiptEvent[];
  netCounted: number;
  lastActivityAt: string;
};

export type NeedProgressView = { fulfilled: number; requiredRemaining: number; surplus: number };

export type NeedReportRow = {
  id: number;
  title: string;
  itemId: number | null;
  itemName: string | null;
  unit: string;
  needed: number;
  status: string;
  updatedAt: string;
  hasActivityInPeriod: boolean;
  atEnd: NeedProgressView;
  fulfilledAtStart: number;
  periodNet: number;
  components: { recebido: number; correcoes: number; estornos: number };
  today: NeedProgressView;
  /** Fase 99H — atendimento final (destinações, hoje), medida separada do suprimento. */
  attendance: NeedAttendanceProgress;
  historicalAttended: boolean;
  statusWarning: boolean;
};

export type OutputType = {
  period: { startDate: string; endDateExclusive: string };
  generatedAt: string;
  filters: { itemId: number | null; needId: number | null; eventType: ReportEventType | null };
  organizationName: string;
  summary: {
    needsCreated: number;
    needsMarkedAtendida: number;
    donations: { total: number; network: number; manual: number };
    corrections: number;
    reversals: { total: number; accountingOnly: number; withWithdrawal: number };
    auditEventCount: number;
  };
  itemMovements: Array<{
    itemId: number;
    itemName: string;
    unit: string;
    entradas: number;
    saidas: number;
    ajustes: number;
    ajustesRede: number;
    ajustesOutros: number;
    entradasDevolucao: number;
    ajustesDestinacao: number;
    saidasComDestinacao: number;
    saidasSemDestinacao: number;
    netChange: number;
    balanceAtStart: number;
    balanceAtEnd: number;
    currentStock: number;
  }>;
  donations: {
    rows: Array<{
      id: string;
      createdAt: string;
      quantity: number;
      unit: string;
      itemId: number;
      itemName: string;
      origin: "rede" | "manual";
      reason: string | null;
      needId: number | null;
      needTitle: string | null;
      allocationId: number | null;
      opportunityTitle: string | null;
    }>;
    total: number;
    truncated: boolean;
    limit: number;
  };
  receipts: { groups: ReceiptGroup[]; totalEvents: number; truncated: boolean; limit: number };
  needs: { rows: NeedReportRow[]; truncated: boolean; limit: number };
  destination: DestinationReport;
  reconciliation: Array<{
    itemId: number;
    itemName: string;
    unit: string;
    balanceAtStart: number;
    entradas: number;
    ajustes: number;
    saidas: number;
    balanceAtEnd: number;
    computedEnd: number;
    saidasComDestinacao: number;
    saidasSemDestinacao: number;
    balanced: boolean;
    exitsBalanced: boolean;
  }>;
};

export const getImpactReport = async (query: z.input<typeof schema>, init?: RequestInit): Promise<OutputType> => {
  const validated = schema.parse(query);
  const params = new URLSearchParams({
    organizationId: String(validated.organizationId),
    startDate: validated.startDate.toISOString(),
    endDate: validated.endDate.toISOString(),
  });
  if (validated.itemId) params.set("itemId", String(validated.itemId));
  if (validated.needId) params.set("needId", String(validated.needId));
  if (validated.eventType) params.set("eventType", validated.eventType);
  if (validated.destinationDateBasis) params.set("destinationDateBasis", validated.destinationDateBasis);
  if (validated.destinationType) params.set("destinationType", validated.destinationType);
  const result = await fetch(`/_api/v1/impact-report?${params.toString()}`, {
    method: "GET",
    ...init,
    credentials: "include",
  });

  if (!result.ok) {
    const errorData = superjson.parse<{ message: string; code?: string }>(await result.text());
    throw new ApiRequestError(errorData.message || "Não foi possível carregar a prestação de contas", result.status, errorData.code ?? null);
  }

  return superjson.parse<OutputType>(await result.text());
};
