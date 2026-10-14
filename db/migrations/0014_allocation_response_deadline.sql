-- Fase 98 — prazo de resposta das atribuições AUTOMÁTICAS e motivo de encerramento das atribuições.
--
-- response_due_at: instante (relógio do BANCO) em que vence o prazo de uma atribuição criada automaticamente pelo matching com nota alta (nasce 'aceita' sem ação humana).
--   É gravado NO MOMENTO DA CRIAÇÃO (now() + prazo global vigente), então mudar o prazo global depois não altera atribuições em andamento. NULL = sem prazo: toda
--   atribuição que já existe (e as manuais e as propostas) fica NULL, e uma atribuição sem prazo nunca expira por esta regra. Não há backfill de origem: sem evidência
--   confiável de que uma linha antiga foi automática, ela não vira candidata à expiração.
-- closed_at / closed_reason: quando e POR QUE o sistema encerrou a atribuição (expiração do prazo, reserva vencida, oferta cancelada/expirada). Distingue expiração e
--   cancelamento administrativo de recusa/cancelamento da organização (que continuam registrados como antes: status 'recusada' / evento 'cancelado' da logística).
--   O motivo 'prazo_expirado' + closed_at alimenta a pausa de 7 dias de não reatribuição automática da mesma organização à mesma oportunidade.
-- Colunas novas NULLABLE, sem DEFAULT e sem backfill; o CHECK do motivo só vale para valores novos (NULL passa).
ALTER TABLE opportunity_allocations
  ADD COLUMN response_due_at TIMESTAMPTZ,
  ADD COLUMN closed_at TIMESTAMPTZ,
  ADD COLUMN closed_reason TEXT CONSTRAINT opportunity_allocations_closed_reason_chk CHECK (closed_reason IS NULL OR closed_reason IN (
    'prazo_expirado', 'reserva_expirada', 'oferta_cancelada_admin', 'oferta_expirada_admin', 'oferta_expirada_automatica', 'oferta_encerrada'
  ));

-- Índice parcial para a tarefa de expiração (só atribuições aceitas com prazo).
CREATE INDEX idx_opportunity_allocations_response_due ON opportunity_allocations(response_due_at) WHERE response_due_at IS NOT NULL AND status = 'aceita';
