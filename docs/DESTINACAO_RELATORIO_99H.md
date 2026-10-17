# Fase 99H — relatórios de impacto: bloco "Destinação" da prestação de contas

Escopo oficial: `docs/DESTINACAO_E_PRESTACAO_DE_CONTAS_ESPECIFICACAO.md`, tabela de subfases (linha **99H Relatórios de impacto** — problema **P9**, "bloco Destinação; recebido × atendido; sem destinação; indicadores separados; reconciliação", contrato de `impact-report_GET`, critérios **E-01 a E-07** e **U-10**) e seções 8, 14.5 e 15. Depende de 99E a 99G. Camada **somente de leitura**: nenhuma migration, nenhuma escrita. A Fase 99 **não** está concluída (99I, 99J e 99K pendentes).

Fora do escopo da 99H (decisão de interpretação conservadora): a aba/lista de histórico com filtros de período, finalidade e situação é a **99I**; comprovantes e leitura protegida são a **99J**; a página de prestação de contas ganha apenas o bloco necessário para exibir o contrato, não a reformulação completa de 99I.

## Contrato (`GET /impact-report`, aditivo)

Novos parâmetros: `destinationDateBasis` (`registro`, padrão, a mesma data do restante do relatório, ou `efetiva`, a data da entrega no calendário do fuso de negócio) e `destinationType` (uma das oito finalidades). Permissão inalterada (`relatorios.leia`: proprietário/administrador); tudo filtrado por organização no SQL. Campos novos na resposta:

- `destination` — bloco da destinação final (`src/helpers/impactDestinationReport.tsx`):
  - `byPurpose`: por **finalidade × item × unidade**: registros, **físico**, revertido (acumulado até hoje), **físico líquido**, **atendimento contabilizável** (`LEAST(aplicada, física − revertida)` só de originais contabilizáveis — a mesma regra da 99F), **excedente** autorizado (não conta como atendimento), físico em **unidade incompatível** (não conta) e pessoas/famílias **declaradas** (rótulo: soma das quantidades declaradas, não pessoas distintas; correções documentais sobrepostas; registro totalmente revertido não conta);
  - `indicators`: operação, terceiros, devolução ao doador, perdas e descartes, **cada um separado e por unidade**, mais o atendimento (aplicado); nunca somam unidades diferentes nem se misturam com o atendimento;
  - `withoutStructuredDestination`: saídas **sem destinação estruturada** em duas subclasses — `automaticHistorical` (baixa automática histórica ligada a `need_resolutions`) e `notClassified` (herdadas); nenhuma é reclassificada;
  - `correctedRecords`, `revertedRecords` e `eventsInPeriod` (correções, estornos documentais, devoluções físicas e correções de quantidade criados no período, por data de registro).
- `itemMovements[]` ganhou `entradasDevolucao`, `ajustesDestinacao`, `saidasComDestinacao` e `saidasSemDestinacao` (`saidas` = com + sem). `ajustes` e `netChange` passam a incluir o ajuste de correção de quantidade.
- `reconciliation[]` — por item: saldo inicial + entradas + ajustes − saídas = saldo final, e saídas = com + sem destinação (`balanced`, `exitsBalanced`).
- `needs.rows[]` ganhou `attendance` (**atendimento final**, medida separada do suprimento, mesma fonte `needAttendance` da 99F), `historicalAttended` e a nova regra de `statusWarning`.

## Regras e decisões

- **Recebido × atendido nunca se somam.** `today/atEnd` continuam sendo o suprimento da rede (ledger `need_fulfillments`, inalterado); `attendance` é o atendimento final por destinações. A lista de necessidades passou a incluir também as que só têm destinações (sem ledger).
- **`statusWarning` (E-05, P7):** necessidade `atendida` **com** destinações estruturadas é comparada com o **atendido**; o registro **histórico** (sem destinação) mantém o aviso factual de suprimento anterior e é indicado como "atendimento histórico sem destinação estruturada" (atendido 0; nunca recalculado a partir de suprimento nem da baixa automática, nunca reaberto).
- **Defeito corrigido (consequência da 99G):** a ENTRADA de uma devolução física passava a contar como "doação recebida" e o ajuste positivo da correção de quantidade como "ajuste outro". Agora são identificados pelo vínculo com a reversão em `stock_destinations`: ficam fora de `donations` (cartões e lista), aparecem em `entradasDevolucao`/`ajustesDestinacao` e entram na conciliação.
- **Data de registro × data efetiva:** nunca misturadas; o chamador escolhe, o relatório devolve qual foi usada (`destination.basis`). As saídas sem destinação só têm data de registro (`windowBasis: "registro"`).
- **Revertido** é o acumulado até a geração do relatório (as reversões têm data própria e aparecem contadas à parte em `eventsInPeriod`).
- Linguagem: "destinação declarada", nunca "entregue ao beneficiário" como afirmação.

## Interface

Página de prestação de contas (`DestinationSection`): seletores "Destinação: data usada" e "Finalidade"; tabela (desktop) / cartões (móvel) por finalidade × item × unidade com físico, revertido, líquido, atendimento, excedente, unidade incompatível e declarados; indicadores separados; saídas sem destinação estruturada (duas subclasses); conciliação por item com alerta quando não fecha; estados de carregamento/erro/vazio herdados da página. Cada necessidade mostra "atendido (destinações): X de Y" ou o rótulo histórico.

## Testes (`test/impactReportDestination.test.ts`, PostgreSQL real, 15)

Agregação por finalidade × item × unidade; físico × contabilizável; excedente; unidade incompatível; indicadores separados; filtros; devolução física/correção de quantidade/estorno fora das doações e conciliação; pessoas declaradas e correções; reabertura/atendimento atual; duas subclasses sem destinação e conciliação; histórico com suprimento; necessidade só com destinações; registro × efetiva; isolamento entre organizações; permissão (200/403/400); relatório sem escrita. Sensibilidade comprovada para: exclusão da devolução do bloco de doações, fórmula do atendimento e a subclasse sem destinação. `qa:visual`: 3 cenários novos (perfil `ci`: 58).

## Limitações

- Revertido é acumulado até hoje, não "até o fim do período" (documentado no cabeçalho do bloco).
- A listagem de destinações com filtros de período/finalidade/situação, a exportação e os comprovantes ficam para 99I/99J.
- A conciliação detecta inconsistência do ledger físico, mas não prova qual doação foi entregue (estoque agregado, sem lotes).
