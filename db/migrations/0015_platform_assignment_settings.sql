-- Fase 98 — configuração GLOBAL (única linha) do prazo de resposta das atribuições automáticas. Mesma política para todas as organizações (nada por organização, para não
-- criar condições desiguais de distribuição). Sem linha = padrão de 72 horas (o código assume o padrão; a linha só existe depois da primeira alteração por um admin da
-- plataforma, que também é auditada). Faixa segura validada no banco e no servidor: 1 a 720 horas (30 dias).
CREATE TABLE platform_assignment_settings (
  id SMALLINT PRIMARY KEY CONSTRAINT platform_assignment_settings_singleton_chk CHECK (id = 1),
  response_deadline_hours INTEGER NOT NULL DEFAULT 72 CONSTRAINT platform_assignment_settings_hours_chk CHECK (response_deadline_hours BETWEEN 1 AND 720),
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
