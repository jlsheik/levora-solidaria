# Fase 99G — correções, estornos e devoluções de destinação

Contrato desta fase (especificação: `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md`, seção 9). Depende da 99F (`docs/ATENDIMENTO_NECESSIDADE_99F.md`, migration `0021`) e da 99E (`docs/DESTINACAO_REGISTRO_99E.md`). A Fase 99 **não** está concluída: relatórios (99H), prestação de contas/histórico geral (99I), comprovantes e privacidade (99J) e a validação de ponta a ponta (99K) continuam pendentes.

## Princípio

Nada é editado nem apagado. Toda operação é um **evento novo imutável** em `stock_destinations` (`correction` ou `reversal`) que aponta para a destinação **original** (o banco recusa apontar para outro evento). O que aconteceu fisicamente fica preservado; o que muda é a leitura (visão efetiva e atendimento recalculado).

## As quatro situações (e o que cada uma move)

| Operação | Endpoint | Evento | Movimento de estoque | Atendimento da necessidade |
| --- | --- | --- | --- | --- |
| **Correção documental** (data efetiva, pessoas atendidas, observações) | `POST /stock-destination-correction` | `correction` (só os campos corrigidos; a original não muda) | **nenhum** | **nenhum** (finalidade, quantidade, unidade, necessidade e `is_countable` não são corrigíveis: o schema recusa campos extras) |
| **Estorno documental** (o registro estava errado, a entrega ocorreu) | `POST /stock-destination-reversal` `kind=estorno_documental` | `reversal` sem `stock_transaction_id` | **nenhum** (não cria saldo fictício) | reduz o aplicado revertido |
| **Devolução física** (o material voltou) | idem, `kind=devolucao_fisica` | `reversal` + **ENTRADA** de mesma quantidade (mesma transação) | entrada positiva | reduz |
| **Correção de quantidade** (parte nunca saiu) | idem, `kind=correcao_quantidade` | `reversal` + **AJUSTE positivo** de mesma quantidade | ajuste positivo | reduz |

Notas de decisão (lacunas da especificação, resolvidas pelo comportamento seguro):
- **Devolução física** só vale para uma destinação cuja movimentação original é uma **saída**. Uma destinação que apenas classifica um *ajuste negativo* como perda/descarte aceita estorno documental ou correção de quantidade, nunca devolução física (`devolucao_fisica_exige_saida`).
- **Sem aprovação nesta fase**: a especificação só exige segunda aprovação para ajuste **negativo**; todos os movimentos compensatórios aqui são **positivos**. Reverter uma saída que exigiu aprovação na 99E não contorna nada: reduz, não cria, risco. Em vez de criar aprovação inexistente, a reversão exige `inventario.lance` **e** `organizacao.gerencie` (proprietário/administrador), e o pedido idempotente é gravado já executado.
- **Permissões**: nenhuma permissão nova foi criada (a especificação chama a matriz proprietário/administrador de `destinacoes.corrija`, mas o catálogo só ganha permissões quando um endpoint as exige e a 99E já usou as existentes). Reversão = `inventario.lance` + `organizacao.gerencie`. Correção documental = `inventario.lance`, e quem não é proprietário/administrador só corrige o que **ele mesmo** registrou; data retroativa (> 7 dias) exige `organizacao.gerencie` e justificativa (≥ 10 caracteres). Leitura (`GET /stock-destinations`) = `inventario.lance`.
- **Unidade**: a reversão herda a unidade da original; se a unidade atual do item já não for a da destinação (ou não for canônica), recusa (`unidade_divergente`) e remete à regularização de unidades — nada é convertido por suposição.
- **Observações não podem ser apagadas** por correção (o valor `null` significa "não corrigir"): só substituídas; finalidades que exigem observações (≥ 10 caracteres) continuam exigindo.

## Limite reversível, concorrência e idempotência

- Σ reversões (qualquer tipo) ≤ quantidade da original. O banco garante (gatilho `stock_destination_validate`, sob `FOR UPDATE` na original); a aplicação checa antes só para dar o erro claro (`excede_reversivel`, com original/revertido/reversível).
- Ordem de travas (a da 99E): chave de idempotência (consultiva) → item (`FOR UPDATE`) → necessidade (`FOR NO KEY UPDATE`) → linha da destinação original (`FOR UPDATE`) → movimento e evento → necessidade → auditoria **por último**.
- **Migration `0022_destination_correction_requests`** (tabela nova, imutável): `UNIQUE (organization_id, idempotency_key)`, `UNIQUE (event_destination_id)`, hash do conteúdo. Mesma chave + mesmo conteúdo = repetição (200, `replayed`, sem novo evento nem nova entrada); mesma chave + outro conteúdo (inclusive outro tipo de operação) = `409 chave_reutilizada`.

## Efeito sobre o atendimento e o estado da necessidade

O atendimento é **sempre recalculado** de `stock_destinations` por `needAttendance` (fórmula única da 99F; a reversão consome primeiro o excedente autorizado). Na **mesma transação** da reversão:

1. necessidade `atendida` pelo fluxo **estruturado** (tem destinações e **nenhuma** `need_resolutions` antiga) cujo atendimento cai abaixo do solicitado volta a `aberta` (auditoria `necessidade.reaberta_automaticamente`; nenhum movimento de estoque é criado pela transição); o matching passa a enxergar o saldo remanescente real;
2. necessidade **`cancelada`** (encerrada com motivo) **permanece** cancelada: nenhum evento de `need_closures` é criado — a reabertura continua sendo decisão humana;
3. necessidade `atendida` **histórica** (sem destinação) ou por resolução administrativa antiga **nunca** é reaberta pelo sistema;
4. destinação em **unidade incompatível** (não contabilizável) não altera atendimento nem estado.

Não foi criado status novo: o parcial continua sendo uma projeção (99F). O ledger `need_fulfillments` (suprimento da rede) não é tocado.

## Auditoria

`destinacao.revertida` (tipo, quantidade, total revertido, reversível restante, motivo, movimento físico, atendimento antes/depois, necessidade reaberta, chave), `inventario.entrada_registrada` / `inventario.ajuste_registrado` para o movimento físico (conciliação do estoque), `necessidade.reaberta_automaticamente` e `destinacao.corrigida` (valor anterior e novo de cada campo). Ator vem da sessão; nenhum campo sensível é aceito do cliente.

## Interface

Inventário → "Destinações registradas" (`DestinationHistory`; operador, administrador, proprietário): cartão por destinação com estado (ativa / parcialmente revertida / revertida), finalidade, quantidade, data **efetiva** (com correções), necessidade, saldo reversível, devolvido ao estoque × estorno documental × correção de quantidade e a linha do tempo de eventos (cada um diz se houve movimento físico). Diálogo de reversão explica a consequência de cada tipo (entrada/ajuste × nenhum movimento), limita a quantidade ao reversível, exige motivo e reutiliza a mesma chave de idempotência em novas tentativas; só confirma depois do servidor. Diálogo de correção documental mostra só os campos corrigíveis.

## Testes (`test/destinationCorrections.test.ts`, PostgreSQL real, 30)

A (efeito físico de cada tipo, devolução parcial/total, terceira devolução recusada, validação), B (excedente consumido primeiro, reabertura/permanência da necessidade, cancelada preservada, resolução antiga, unidade incompatível, ledger intacto), C (correção: original intacta, recusas, quem pode, sobreposição pura), D (permissões, isolamento entre organizações, leitura, quantidade aplicada não manipulável), E (idempotência, 4 chaves simultâneas, 6 devoluções simultâneas, reversão × nova destinação), F (falhas injetadas na auditoria e na gravação da reversão com rollback completo), G (invariantes do banco: soma das reversões, tipo de movimento, forma de correção, imutabilidade). Adaptações: contagem de tabelas (32) e de cenários `qa:visual`.

## Limitações conhecidas

- Não há reversão com segunda aprovação (não exigida pela especificação para movimentos positivos); se a política mudar, o ponto de entrada é `reverseDestination`.
- A listagem pagina por "mostrar mais" (limite crescente); não há filtro por finalidade/período na interface (a API aceita `itemId` e `needId`).
- Comprovantes (`proof_file_id`) não são corrigíveis nesta fase (99J).
- Reabrir uma necessidade `cancelada` após uma reversão continua manual (`POST /need-closure`).
