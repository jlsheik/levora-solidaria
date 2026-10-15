# Fase 99E — registro atômico de saída física + destinação

Contrato de produto: `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md` (seções 6 a 9). Esta fase conecta, numa **única transação PostgreSQL**, a saída de estoque (`stock_transactions`) e a destinação original (`stock_destinations`, Fase 99D), com idempotência persistente (`stock_exit_requests`, migration `0020`), risco/segunda aprovação, datas no fuso de negócio e auditoria. **Não** muda o ledger `need_fulfillments`, **não** muda o significado de `atendida` (Fase 99F), **não** implementa correções/reversões, relatórios nem comprovantes.

## 1. Mapa dos escritores de saída (auditoria do código)

| Escritor | Antes | Agora |
|---|---|---|
| `stock-transactions_POST` (`type: "saida"`) | saída com motivo livre | **recusa `saida`** (400, orienta para a destinação); `entrada` e `ajuste` seguem aqui (o ajuste continua no fluxo próprio, com dupla aprovação de alto risco) |
| `needs-status_POST` → `atendida` | baixa automática de toda a `quantity_needed` (saída sem finalidade) | **nunca baixa estoque**; só cria a resolução administrativa declarativa (`stock_transaction_id = NULL`), com ou sem item vinculado |
| `approval-requests-decide_POST` | executava só ajustes e o ledger | passa a executar também a saída com destinação aprovada (`saida_destinacao_alto_risco`) |
| **`stock-destinations_POST` (novo)** | — | **único caminho de saída física**: `src/helpers/stockExit.tsx` |
| correções/estornos do recebimento (`needFulfillmentCorrections`) | `ajuste` | inalterado (ajuste ≠ saída; nenhuma segunda saída é criada) |

Teste estático (`stockDestinationsFlow`, caso 49): a única escrita de movimento `saida` em `src/`, `scripts/` e `db/` é `stockExit.tsx`. Invariante sobre o banco: toda saída nova tem exatamente uma destinação original e toda destinação normal aponta para uma saída real.

## 2. Fluxo do pedido (`POST /stock-destinations`)

1. Autentica; `inventario.lance` na organização (proprietário, administrador, operador). Quem tem também `organizacao.gerencie` pode autorizar data retroativa. Voluntário e não-membro: 403.
2. Valida o corpo (zod): as **oito finalidades** (lista fechada); necessidade e pessoas atendidas só nas três de atendimento; pessoas e unidade (famílias/pessoas) juntas; descrição ≥ 10 caracteres para uso operacional, doação a terceiro, devolução ao doador, perda e descarte; quantidade positiva com no máximo 3 casas; chave de idempotência obrigatória.
3. **Trava consultiva** da chave → busca o pedido existente: mesmo hash ⇒ devolve o resultado original (`replayed: true`) ou o pedido de aprovação pendente; hash diferente ⇒ 409 `chave_reutilizada`; pedido já rejeitado/expirado ⇒ 409 `pedido_encerrado`.
4. **Trava o item** (`FOR UPDATE`), **recalcula o saldo** sob a trava e valida: item da organização (404), **unidade canônica confiável** (o item precisa estar exatamente no rótulo canônico do vocabulário; senão 422 — nenhuma conversão), saldo suficiente (409), necessidade (mesma organização, `aberta`, do mesmo item quando tem item; `is_countable` só se a unidade da necessidade é a **mesma unidade canônica** do item; unidade incompatível registra a saída mas **não conta** como atendimento e a resposta avisa), data efetiva (seção 4).
5. **Risco** (seção 3). Com risco: cria o pedido de aprovação (mecanismo existente `approval_requests`), grava o pedido idempotente `pendente_aprovacao` e audita `destinacao.pendente_aprovacao` — **nada é baixado e nenhuma destinação existe**.
6. Sem risco: insere a **saída** (`type = 'saida'`, `delta = −quantidade`, motivo gerado a partir da finalidade), a **destinação original** ligada a ela (quantidade igual, unidade do item, data efetiva, `created_at` do servidor, autor), o pedido `executada` e audita por último (`inventario.saida_registrada` + `destinacao.registrada`). Tudo reverte junto se qualquer passo falhar (testado com falhas injetadas no banco).

**Ordem de travas (única):** chave de idempotência → item → necessidade (`FOR NO KEY UPDATE`) → linhas criadas → auditoria (última, advisory lock global). A aprovação trava o pedido de aprovação primeiro (já era a ordem do endpoint) e depois o pedido idempotente → item → necessidade. Não há N+1: uma busca do pedido, uma do item, uma soma de saldo, uma da necessidade.

## 3. Risco e segunda aprovação

- **`perda` e `descarte`: sempre** exigem segunda validação independente.
- **Qualquer saída ≥ 30% do saldo físico imediatamente anterior** (do item, na unidade canônica, sob a trava; comparação em milésimos inteiros) exige segunda aprovação. O limite é **relativo**: nenhum número absoluto (20 quilos, 20 caixas e 20 peças não têm o mesmo peso).
- Prevalece a exigência mais rigorosa; o autor **nunca** aprova o próprio pedido (regra do endpoint de decisão); só `aprovacoes.decida` (proprietário/administrador) decide.
- **Exceção de organização com um único administrador:** o sistema **não** a suporta hoje (nem para ajustes) e ela não foi criada: um único proprietário não consegue aprovar a própria perda. É limitação documentada.
- **Na aprovação** (transação da decisão): revalida tudo sobre o estado **atual** — item, unidade, saldo, necessidade, data. Saldo que caiu abaixo da quantidade ⇒ 409 `saldo_insuficiente` sem efeito e o pedido continua pendente; saldo que mudou ⇒ o risco é reavaliado e fica na auditoria (`saldoAnterior`, `riscoAvaliado`). Aprovação confirmada grava saída + destinação + desfecho do pedido + auditoria juntos (o autor do pedido consta como criador; o aprovador, na auditoria); aprovar de novo ⇒ 409; duas aprovações concorrentes ⇒ uma saída. Rejeição encerra o pedido sem movimentar estoque.

## 4. Datas e fuso de negócio

`src/helpers/businessDate.ts` (única política, usada pelo servidor, pela interface e pelos testes): timestamps em UTC; a **data civil de negócio** é calculada em `America/Sao_Paulo` (configuração global desta versão, sem fuso por organização) a partir do relógio do **banco**. Regras: formato `AAAA-MM-DD` de data real do calendário; **futura rejeitada** (422); de hoje até **7 dias corridos atrás, inclusive** (hoje − 7 é aceito) é a janela normal; **8 dias ou mais** exige proprietário/administrador **e** justificativa ≥ 10 caracteres, e fica na destinação (`late_registration_reason`, `authorized_by_user_id`) e na auditoria. O cálculo é por **diferença de data civil**, não por 168 horas. O navegador só informa a data escolhida; o `created_at` é sempre do servidor (o banco também limita `delivered_on` a no máximo um dia à frente do registro em UTC). Testes cobrem a virada às 23:59:59/00:00:00 de São Paulo, o limite exato e o primeiro dia fora.

## 5. Idempotência

`stock_exit_requests` (`0020`): `UNIQUE (organization_id, idempotency_key)`, hash SHA-256 do conteúdo canônico (sem a chave), desfecho (`pendente_aprovacao | executada | rejeitada`) com FKs compostas para a saída e a destinação; gatilho impede alterar chave/hash/autor e qualquer mudança depois de um desfecho. O cliente gera a chave ao abrir o diálogo e a reenvia em qualquer nova tentativa (rede, duplo clique, outra aba); retry com a mesma chave devolve o resultado original; a mesma chave com conteúdo diferente é recusada; nova chave = nova saída legítima; requisições simultâneas com a mesma chave são serializadas (trava consultiva + índice único) e devolvem uma só saída.

## 6. Interface

Em Estoque, cada item ganhou **Registrar destinação** (diálogo `DestinationDialog`): saldo e unidade do item visíveis; oito finalidades com descrição; necessidade (só atendimento, só abertas do mesmo item ou sem item); pessoas atendidas agregadas (≠ quantidade física); data efetiva (com justificativa se retroativa); observações; aviso **antes** de enviar quando a saída exige segunda aprovação; mensagens de saldo insuficiente, unidade não confiável, data inválida/retroativa; erro no diálogo com a **mesma chave** mantida para nova tentativa; carregamento/erro/vazio das necessidades. "Saída" saiu do diálogo de movimentação (ficam entrada e ajuste). As solicitações pendentes aparecem no painel de aprovações existente. Comprovante **não** é exigido (99J).

## 7. O que continua pendente

99F (atendido derivado das destinações, `atendida`, `cancelada` com `need_closures`, excedente), 99G (correções, estornos, devoluções físicas), 99H (relatórios), 99I (aba de histórico e prestação de contas), 99J (comprovantes e autorização de leitura), 99K (validação de ponta a ponta). Limitações: sem exceção de administrador único; sem listagem de destinações nem de pedidos pendentes do próprio solicitante (só no painel de aprovações); o excedente além da quantidade necessária da necessidade ainda não é verificado.
