import type { MembershipRole } from "./schema";

/**
 * RBAC granular (master prompt, seção 10) — catálogo real das permissões
 * que existem hoje neste sistema, não a lista completa da seção 10 do
 * master prompt (que inclui domínios como `beneficiaries.*`, `donors.*` e
 * `financial.*` que ainda não têm nenhuma tabela/endpoint implementado —
 * criar permissões para eles agora seria nomear controle de acesso sobre
 * nada, o oposto do que RBAC deveria fazer).
 *
 * Cada permissão nomeada aqui corresponde a pelo menos um endpoint real
 * que a exige via `requirePermission` (ver organizationAccess.tsx). Cada
 * papel (`membership_role`) tem um conjunto fixo — não há ainda
 * customização por organização (isso exigiria uma tabela
 * `role_permissions` por organização; hoje o mapeamento é global e vale
 * para todas as organizações igualmente, documentado explicitamente aqui
 * em vez de fingido como configurável).
 */
export const ALL_PERMISSIONS = [
  "membros.leia",
  "membros.gerencie",
  "inventario.leia",
  "inventario.lance",
  "necessidades.leia",
  "necessidades.gerencie",
  "oportunidades.leia",
  "oportunidades.gerencie",
  "atribuicoes.leia",
  "atribuicoes.decida",
  "logistica.leia",
  "logistica.gerencie",
  "arquivos.leia",
  "arquivos.envie",
  "aprovacoes.leia",
  "aprovacoes.decida",
  "auditoria.leia",
  "relatorios.leia",
  "organizacao.gerencie",
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

// proprietario e administrador têm exatamente o mesmo conjunto de
// permissões hoje — a distinção entre os dois papéis, no sistema atual,
// não é de capacidade, e sim de quem criou a organização (ver
// docs/CONVITE_DE_MEMBROS.md: convite não pode nomear "proprietario"). Se
// no futuro um fluxo exigir uma ação exclusiva de proprietário (ex.:
// transferir propriedade, excluir a organização), a diferença nasce aqui,
// numa permissão que só `proprietario` tem — não como um caso especial
// espalhado pelos endpoints.
const ADMIN_PERMISSIONS = new Set<Permission>(ALL_PERMISSIONS);

const OPERATOR_PERMISSIONS = new Set<Permission>([
  "membros.leia",
  "inventario.leia",
  "inventario.lance",
  "necessidades.leia",
  "necessidades.gerencie",
  "oportunidades.leia",
  "oportunidades.gerencie",
  "atribuicoes.leia",
  "atribuicoes.decida",
  "logistica.leia",
  "logistica.gerencie",
  "arquivos.leia",
  "arquivos.envie",
]);

const VOLUNTEER_PERMISSIONS = new Set<Permission>([
  "membros.leia",
  "inventario.leia",
  "necessidades.leia",
  "oportunidades.leia",
  "atribuicoes.leia",
  "logistica.leia",
  "arquivos.leia",
]);

export const ROLE_PERMISSIONS: Record<MembershipRole, ReadonlySet<Permission>> = {
  proprietario: ADMIN_PERMISSIONS,
  administrador: ADMIN_PERMISSIONS,
  operador: OPERATOR_PERMISSIONS,
  voluntario: VOLUNTEER_PERMISSIONS,
};

export function roleHasPermission(role: MembershipRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}
