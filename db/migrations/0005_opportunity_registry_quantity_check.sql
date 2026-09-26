-- Fecha uma lacuna estrutural encontrada na auditoria do motor de matching
-- (fase 22): opportunity_registry.quantity não tinha nenhuma constraint no
-- banco, ao contrário de needs.quantity_needed e
-- opportunity_allocations.quantity_allocated (ambas já com CHECK > 0).
-- Nenhum caminho atual conseguia gravar zero (a validação do Zod em
-- opportunity-registry_POST.schema.ts já usa .positive()), mas dependia
-- inteiramente dessa única camada — sem uma segunda proteção no banco.
ALTER TABLE opportunity_registry
  ADD CONSTRAINT opportunity_registry_quantity_positive_chk CHECK (quantity IS NULL OR quantity > 0);
