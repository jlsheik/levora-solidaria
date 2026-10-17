# Fase 99K — validação de ponta a ponta do ciclo de destinação

Critério formal (especificação, tabela de subfases): "99K Validação de ponta a ponta — integração; todas as subfases; ponta a ponta, concorrência, `qa:security`, CI, atualização do roadmap; critérios G-01 a G-03 + todas; seção 22". Não é fase de funcionalidades novas: a única adição de produto é a **reconciliação somente leitura** de comprovantes (item 9.3), pedida para tornar as pendências visíveis sem destruir nada. Base: 99J (`16c42f81ac1d09887046009d4450072acd870cc2`), migrations inalteradas (última: `0023`).

## Como a validação é feita

`test/endToEnd99k.test.ts` (PostgreSQL real, armazenamento local descartável, 15 testes) percorre os **endpoints reais** na ordem do produto, sem inserir registros artificiais para avançar etapas, e depois de cada passo um **oráculo** calcula o mesmo número por cinco caminhos independentes: SQL puro sobre as tabelas × `GET /needs` × totais do histórico (`GET /stock-destinations`, 99I) × bloco `destination` e linhas de necessidade do relatório (`GET /impact-report`, 99H) × saldo do estoque (soma do ledger) e conciliação por item. Divergência em qualquer camada falha o teste.

## Matriz de rastreabilidade

| # | Requisito / fluxo | Teste (`endToEnd99k` salvo indicação) | Camadas | Resultado |
|---|---|---|---|---|
| A | Oferta da rede → matching → (decisão) → logística → recebimento → entrada física → destinação parcial e total → relatório → comprovante → download → remoção da referência | Jornada A | matching, API, estoque, ledger, atendimento, histórico, relatório, arquivos | passa |
| A2 | Doação local → recebimento (uma entrada, sem ledger da rede) → destinação | Jornada A2 | API, estoque, relatório | passa |
| B1 | Parcial → matching vê só o restante (`restante 60`) → completo → matching não vê → reversão reabre → matching vê o restante (`restante 30`) | Jornada B (1) | matching, atendimento | passa |
| B2 | Excedente recusado sem efeito / permissão / autorizado sem inflar o atendimento; unidade incompatível não conta | Jornada B (2) | domínio, relatório | passa |
| B3 | Cancelada preserva entregas e não reabre por reversão; reabertura explícita; histórica sem destinação inventada | Jornada B (3) | domínio, histórico | passa |
| C1 | Correção documental (sem movimento, campos proibidos = 400), estorno documental (sem entrada), devolução física parcial/total, correção de quantidade, limite reversível, histórico append-only | Jornada C (1) | domínio, banco, estoque | passa |
| C2 | Data efetiva: aba × relatório × filtro de registro | Jornada C (2) | histórico, relatório | passa |
| C3 | Concorrência: 8 destinações no mesmo item; 4 disputando completar a necessidade (1 vence); 4 disputando o saldo reversível (2 vencem) | Jornada C (3) | banco (locks, gatilhos) | passa |
| C4 | Atomicidade: falha de auditoria desfaz entrada, reversão e reabertura; mesma chave funciona depois | Jornada C (4) | transação, idempotência | passa |
| E1 | Falha do armazenamento no envio sem registro; objeto ausente sem vazar caminho; removido não volta; vínculo duplicado; idempotência e concorrência | Jornada E (1) | arquivos, banco | passa |
| E2 | Reconciliação somente leitura (pendentes/removidos), permissão e isolamento | Jornada E (2) | API, banco | passa |
| G1 | Saída de alto risco pendente → aprovação por outra pessoa → saída + destinação + atendimento numa transação | Jornada G (1) | aprovações, estoque | passa |
| G2 | Unidade fora do vocabulário não recebe destinação | Jornada G (2) | domínio | passa |
| P | Matriz de permissões do ciclo por papel | "Matriz de permissões" | autorização | passa |
| I | Isolamento entre organizações no ciclo inteiro | "Isolamento" | todas | passa |
| — | Regressões de fase: `needAttendance`, `destinationCorrections`, `destinationHistoryFilters`, `destinationProofs`, `impactReportDestination`, `stockDestinationsFlow`, recebimentos, matching, unidades | suíte completa | todas | passa (ver gates) |

Sensibilidade (mutação → o E2E falha): fórmula do atendimento no relatório (6 testes), reabertura automática ao reverter (3), filtro de necessidade da aba (1).

## Invariantes verificados em todos os passos

Sem soma de unidades diferentes; sem dupla contagem do ledger da rede no atendimento; sem dupla contagem de entradas/devoluções; estorno documental nunca cria entrada; aplicado ≤ solicitado; conciliação (saldo inicial + entradas + ajustes − saídas = saldo final; saídas = com + sem destinação) fecha; nenhuma destinação histórica inventada; data efetiva igual na aba e no relatório; eventos de comprovante não alteram estoque, atendimento nem a contagem de correções; a contagem de comprovantes reflete a referência **vigente** (remoção a reduz).

## Defeitos encontrados

Nenhum defeito de integridade (estoque, atendimento, isolamento, concorrência, atomicidade) foi encontrado na cadeia 99F–99J; as falhas iniciais do E2E eram premissas de teste incorretas (a atribuição automática liga a necessidade pela avaliação do matching, não por `allocation.need_id`; 20 de 50 kg é 40% do saldo e exige segunda aprovação). A auditoria das limitações da 99J gerou uma lacuna de **visibilidade**: arquivos enviados e nunca vinculados não tinham como ser listados. Corrigida com `GET /destination-proofs-reconciliation` (somente leitura) e painel na aba Destinação.

## Limitações e decisão de prontidão

| Limitação | Classificação |
|---|---|
| Análise antimalware: **não existe** nenhuma integração; só há verificação do tipo pelos primeiros bytes, limite de 8 MB e armazenamento privado. Nada no produto afirma que os arquivos são analisados | **Bloqueadora para produção** com uploads de terceiros sem decisão operacional (aceitar o risco, isolar o download como attachment, ou integrar ferramenta) — decisão do projeto, sem dependência nova criada aqui |
| Retenção, exclusão e anonimização do conteúdo dos comprovantes: não há política aprovada; não existe rotina de exclusão de conta; a remoção desvincula e preserva o objeto | Dependente de decisão jurídica/operacional; **bloqueadora para declarar conformidade com a LGPD** (o produto não a declara) |
| Arquivos pendentes nunca vinculados: sem limpeza automática | Mitigada (listados, somente leitura, em `GET /destination-proofs-reconciliation`; órfãos físicos pelo diagnóstico `storageIntegrity`); a remoção depende da política de retenção |
| Sem barra de progresso percentual; comprovante só após o registro da saída | Melhoria, fora do escopo formal da 99K (roadmap) |
| Exportação; visão por data de corte (revertido/situação são o acumulado até hoje) | Sem atribuição na especificação; fora do escopo |
| CI oficial: o workflow só roda para PRs com base `master`; as PRs #11–#16 são encadeadas | Sem checks oficiais para #12–#16; o run `38685468312` cobre apenas a 99F (#11) |

**Decisão:** o ciclo de destinação está **validado localmente** de ponta a ponta com os gates abaixo, sem defeito de integridade conhecido. A Fase 99 **não** deve ser declarada pronta para produção enquanto (1) a decisão sobre antimalware/exposição de arquivos de terceiros, (2) a política de retenção/exclusão e (3) a validação oficial do GitHub da cadeia (após retargetar as PRs para `master`, em sequência, quando a integração for autorizada) não estiverem resolvidas.

## Critérios de liberação (próximos passos)

1. Integrar 99F→99K em sequência (retargetando cada PR para `master` e conferindo que o diff contém só a fase), com os checks oficiais verdes em cada commit.
2. Decisão registrada sobre antimalware e exposição de comprovantes.
3. Parecer jurídico sobre retenção/exclusão/anonimização e, se aprovado, implementação com auditoria.
4. Roteiro de operação para a conciliação de pendentes (quem decide remover e como).
