import { describe, it, expect } from "vitest";
import { ALL_PERMISSIONS, ROLE_PERMISSIONS, roleHasPermission } from "../src/helpers/permissions";
import { MembershipRoleArrayValues } from "../src/helpers/schema";

describe("catálogo de permissões (RBAC granular)", () => {
  it("todo papel conhecido tem um conjunto de permissões definido", () => {
    for (const role of MembershipRoleArrayValues) {
      expect(ROLE_PERMISSIONS[role]).toBeDefined();
      expect(ROLE_PERMISSIONS[role].size).toBeGreaterThan(0);
    }
  });

  it("administrador tem as mesmas permissões do proprietário, exceto propriedade.gerencie (exclusiva de proprietário)", () => {
    const withoutOwnership = [...ROLE_PERMISSIONS.proprietario].filter((p) => p !== "propriedade.gerencie").sort();
    expect([...ROLE_PERMISSIONS.administrador].sort()).toEqual(withoutOwnership);
    expect(roleHasPermission("proprietario", "propriedade.gerencie")).toBe(true);
    expect(roleHasPermission("administrador", "propriedade.gerencie")).toBe(false);
    expect(roleHasPermission("operador", "propriedade.gerencie")).toBe(false);
    expect(roleHasPermission("voluntario", "propriedade.gerencie")).toBe(false);
  });

  it("proprietario tem todas as permissões do catálogo", () => {
    for (const permission of ALL_PERMISSIONS) {
      expect(roleHasPermission("proprietario", permission)).toBe(true);
    }
  });

  it("voluntário só tem permissões de leitura (nunca lance/gerencie/decida/envie)", () => {
    for (const permission of ROLE_PERMISSIONS.voluntario) {
      expect(permission.endsWith(".leia")).toBe(true);
    }
  });

  it("voluntário não tem nenhuma permissão administrativa (membros.gerencie, aprovacoes.*, auditoria.leia, relatorios.leia)", () => {
    expect(roleHasPermission("voluntario", "membros.gerencie")).toBe(false);
    expect(roleHasPermission("voluntario", "aprovacoes.leia")).toBe(false);
    expect(roleHasPermission("voluntario", "aprovacoes.decida")).toBe(false);
    expect(roleHasPermission("voluntario", "auditoria.leia")).toBe(false);
    expect(roleHasPermission("voluntario", "relatorios.leia")).toBe(false);
  });

  it("operador tem permissões operacionais mas não administrativas", () => {
    expect(roleHasPermission("operador", "inventario.lance")).toBe(true);
    expect(roleHasPermission("operador", "logistica.gerencie")).toBe(true);
    expect(roleHasPermission("operador", "atribuicoes.decida")).toBe(true);
    expect(roleHasPermission("operador", "membros.gerencie")).toBe(false);
    expect(roleHasPermission("operador", "auditoria.leia")).toBe(false);
    expect(roleHasPermission("operador", "aprovacoes.decida")).toBe(false);
    expect(roleHasPermission("operador", "relatorios.leia")).toBe(false);
  });

  it("só proprietário/administrador têm organizacao.gerencie (capacidade/logística/área de atendimento para matching)", () => {
    expect(roleHasPermission("proprietario", "organizacao.gerencie")).toBe(true);
    expect(roleHasPermission("administrador", "organizacao.gerencie")).toBe(true);
    expect(roleHasPermission("operador", "organizacao.gerencie")).toBe(false);
    expect(roleHasPermission("voluntario", "organizacao.gerencie")).toBe(false);
  });

  it("só proprietário/administrador têm automacao.leia e automacao.gerencie (alertas, exceções, pausa)", () => {
    for (const permission of ["automacao.leia", "automacao.gerencie"] as const) {
      expect(roleHasPermission("proprietario", permission)).toBe(true);
      expect(roleHasPermission("administrador", permission)).toBe(true);
      expect(roleHasPermission("operador", permission)).toBe(false);
      expect(roleHasPermission("voluntario", permission)).toBe(false);
    }
  });

  it("todo papel que tem uma permissão de gerência/ação também tem a leitura correspondente (nenhum papel escreve sem poder ler)", () => {
    const writeToReadPairs: Array<[string, string]> = [
      ["inventario.lance", "inventario.leia"],
      ["necessidades.gerencie", "necessidades.leia"],
      ["oportunidades.gerencie", "oportunidades.leia"],
      ["logistica.gerencie", "logistica.leia"],
      ["atribuicoes.decida", "atribuicoes.leia"],
      ["aprovacoes.decida", "aprovacoes.leia"],
      ["membros.gerencie", "membros.leia"],
    ];
    for (const role of MembershipRoleArrayValues) {
      for (const [writePermission, readPermission] of writeToReadPairs) {
        if (ROLE_PERMISSIONS[role].has(writePermission as never)) {
          expect(ROLE_PERMISSIONS[role].has(readPermission as never)).toBe(true);
        }
      }
    }
  });
});
