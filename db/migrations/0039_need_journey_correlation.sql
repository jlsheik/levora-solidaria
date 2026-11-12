-- M40 — correlação persistida da JORNADA da necessidade (necessidade → correspondência → atribuição → recebimento → destinação → auditoria).
--
--   * `needs.correlation_id`: UUID gerado NO SERVIDOR no cadastro da necessidade (origem da jornada). Os registros de auditoria dos fluxos que realmente envolvem a necessidade
--     (atribuição, decisão, logística, recebimento, correção/estorno, destinação, encerramento) herdam esse identificador pela necessidade já persistida (`need_id`).
--     Necessidades existentes ficam NULL: nenhuma correlação é fabricada para o passado.
--
-- Nenhum objeto desta migration existe antes dela. Preserva 0032–0038. Sem backfill. Coluna nula + CHECK de formato (satisfeito por construção).

ALTER TABLE needs ADD COLUMN correlation_id TEXT CONSTRAINT needs_correlation_chk CHECK (correlation_id IS NULL OR correlation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
CREATE INDEX idx_needs_correlation ON needs (correlation_id) WHERE correlation_id IS NOT NULL;
