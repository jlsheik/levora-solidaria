import { z } from "zod";
import { SourceTypeArrayValues, OpportunityUrgencyArrayValues } from "./schema.js";

export const newSourceSchema = z.object({
  name: z.string().min(2), type: z.enum(SourceTypeArrayValues, { error: "Selecione o tipo da fonte" }), connectorKey: z.string().min(1),
  endpointOrAddress: z.string().optional(), accessMethod: z.string().optional(), policyNotes: z.string().optional(),
});

export const newDiscoverySchema = z.object({
  sourceId: z.coerce.number().int().positive(), title: z.string().min(3), description: z.string().optional(),
  category: z.string().optional(), quantity: z.coerce.number().positive().optional(), unit: z.string().optional(),
  condition: z.string().optional(), locationCity: z.string().optional(), locationState: z.string().optional(),
  originContact: z.string().optional(), urgency: z.enum(OpportunityUrgencyArrayValues, { error: "Selecione a urgência" }).default("media"),
});
