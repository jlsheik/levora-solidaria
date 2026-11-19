-- M35 — estado `dados_insuficientes` do motor de eventos dos agentes: a análise NÃO pôde ser concluída porque falta um dado OBRIGATÓRIO do contrato do evento (ex.: categoria da oferta,
-- campo de eventos anteriores à M35). NÃO é aprovação: o motor não conclui a simulação nesse estado.
--
-- Só amplia o conjunto aceito pelo CHECK de `status` de `agent_event_runs` (criada na 0033, tabela nova e hoje sem linhas em produção). Nenhuma linha existente é invalidada: todo status antigo
-- continua aceito. Preserva as migrations 0032 e 0033 (nenhuma foi reescrita).

ALTER TABLE agent_event_runs DROP CONSTRAINT agent_event_runs_status_check;
ALTER TABLE agent_event_runs ADD CONSTRAINT agent_event_runs_status_check CHECK (status IN ('recebido', 'validado', 'ignorado', 'bloqueado_politica', 'aguardando_aprovacao', 'rejeitado', 'autorizado_simulacao', 'simulacao_concluida', 'falha', 'dados_insuficientes'));
