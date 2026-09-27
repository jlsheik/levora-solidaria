-- Fase 40 — entidade própria para a resolução administrativa da need
-- (ver docs/plano-implementacao.md, Fase 39: reabrir uma need NUNCA
-- representa um novo ciclo físico; a intenção original era uma resolução
-- por necessidade, nunca uma por transição de status). Achado da Fase 38,
-- reproduzido deterministicamente: como `needs-status_POST.ts` só olhava o
-- status IMEDIATAMENTE anterior, o ciclo `aberta→atendida→aberta→atendida`
-- gerava uma SEGUNDA baixa de estoque próprio para a mesma necessidade,
-- sem nenhum registro estrutural que permitisse detectar "isto já
-- aconteceu".
--
-- `need_resolutions` NÃO é o Modelo B, e não deve ser confundida com ele:
--   `need_fulfillments`  → recebimentos de doações da REDE Levora, sempre
--                          ligados a uma allocation (append-only, ledger
--                          de eventos com correction/reversal — congelado,
--                          intocado por esta migration).
--   `need_resolutions`   → resolução ADMINISTRATIVA da própria need via
--                          `needs-status_POST` (consumo do ESTOQUE PRÓPRIO
--                          da organização, ou uma declaração puramente
--                          administrativa quando a need não tem item
--                          vinculado) — nunca ligada a uma allocation,
--                          nunca gerada pelo motor de matching.
--
-- Multi-tenancy: sem organization_id redundante — need_id já aponta para
-- uma need, que já pertence a uma organização; a organização é sempre
-- derivada de lá (única fonte de verdade), nunca duplicada aqui.
--
-- UNIQUE(need_id): no máximo UMA resolução por need, por toda a vida da
-- necessidade — é a garantia estrutural de que reabrir e reatender não
-- produz uma segunda baixa, independentemente de quantos ciclos
-- administrativos (aberta→atendida→aberta→...) acontecerem depois.
--
-- stock_transaction_id nullable: NULL quando a need não tem item
-- vinculado (resolução puramente declarativa, sem lastro físico — mesmo
-- espírito de `need_fulfillments.stock_transaction_id`, mas aqui é sempre
-- o mesmo `stock_transactions.type='saida'` já criado por
-- `needs-status_POST.ts` desde a Fase 10). Índice único parcial garante
-- que o MESMO movimento físico nunca seja reaproveitado por duas
-- resoluções.
--
-- Append-only: mesma trigger (`audit_log_block_mutation`) já usada por
-- `audit_log`/`stock_transactions`/`need_fulfillments` — uma resolução,
-- uma vez criada, nunca é alterada nem apagada; "desfazer" continua
-- exigindo uma ação administrativa visível (mudar `needs.status`), nunca
-- uma reescrita silenciosa deste histórico.
CREATE TABLE need_resolutions (
  id SERIAL PRIMARY KEY,
  need_id INTEGER NOT NULL REFERENCES needs(id) ON DELETE RESTRICT,
  stock_transaction_id BIGINT REFERENCES stock_transactions(id) ON DELETE RESTRICT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (need_id)
);

CREATE UNIQUE INDEX idx_need_resolutions_stock_transaction
  ON need_resolutions(stock_transaction_id) WHERE stock_transaction_id IS NOT NULL;

CREATE TRIGGER need_resolutions_no_update BEFORE UPDATE ON need_resolutions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
CREATE TRIGGER need_resolutions_no_delete BEFORE DELETE ON need_resolutions FOR EACH ROW EXECUTE FUNCTION audit_log_block_mutation();
