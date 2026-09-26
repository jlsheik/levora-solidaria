# Agentes de IA

Master prompt, seção 142 (documentação obrigatória) e seções 16-22, 34-36,
43-44 (Scout Agent, Verification Agent, Qualification Agent, Outreach
Agent, Negotiation Agent, Agente de Estoque, Agente de Necessidades,
Agente de Impacto, AI Orchestrator, permissões de ferramentas por agente).

## O que existe de verdade hoje

**Um único ponto de apoio de IA**, não uma arquitetura de múltiplos
agentes: `src/helpers/opportunityMatching.tsx` usa IA como **apoio
opcional** ao motor de correspondência determinístico, nunca como decisão
autônoma. Fluxo real:

1. O motor tenta primeiro pontuação por palavra-chave
   (`keywordScore`/`normalize`, funções puras, testadas em
   `test/opportunityMatching.test.ts`).
2. Só quando a palavra-chave não encontra nenhuma correspondência para uma
   necessidade candidata, o sistema consulta a IA (`aiCategoryScores`) para
   avaliar equivalência semântica — ex.: "tenho 30 cadeiras" vs. necessidade
   cadastrada como "mobiliário escolar".
3. A IA retorna um score (0-100) e uma justificativa textual por
   necessidade candidata, **nunca decide sozinha**: o score dela entra na
   mesma fórmula ponderada que os outros critérios (categoria, urgência,
   quantidade, proximidade), e a decisão final (`aceita`/`proposta`/
   descartado) segue as mesmas faixas de confiança (90%/70%) que já
   existiam sem IA.
4. Se a IA falhar (sem crédito, rede, formato de resposta inesperado), o
   motor **nunca bloqueia nem inventa um score** — segue só com a
   pontuação por palavra-chave (`FlootAiOutOfCreditsError` e outros erros
   são capturados e logados, matching continua).
5. Cada avaliação, com ou sem IA, é registrada em `match_evaluations` com
   `algorithm_version` e `ai_model_used` (nulo quando IA não foi usada) —
   rastreável, nunca "a IA decidiu" sem registro do que exatamente foi
   perguntado e respondido.

## Regra de versionamento (`ALGORITHM_VERSION`)

`ALGORITHM_VERSION` (`src/helpers/opportunityMatching.tsx`, única fonte de
verdade — `match_evaluations.algorithm_version`,
`opportunity_allocations.notes` e `audit_log.metadata.algoritmo` sempre a
consomem, nunca têm literal próprio) representa a versão das **regras
comportamentais do motor**, não apenas a fórmula matemática de agregação.
Qualquer mudança capaz de alterar o resultado final do matching (decisão ou
alocação) para uma mesma entrada exige nova versão. Exemplos: alteração de
critério, da regra de cálculo de um critério, de peso, da fórmula de
agregação, de threshold, de elegibilidade de candidato, ou do desempate.
Mudanças puramente internas (refatoração, comentário, nome de variável) que
não alteram o comportamento observável não exigem bump.

**Nota histórica**: os registros gravados com `algorithm_version = "1.1"`
não são necessariamente homogêneos. Entre a introdução de "1.1" (commit
`a07d2cc`) e sua substituição por "1.2", pelo menos duas correções de bug
alteraram resultados reais do motor (compatibilidade de unidade em
capacidade e exigência de cidade+UF em área de atendimento, commit
`ed45102`; comparação de proximidade por cidade+UF e desempate
determinístico, commit `cdfa0de`) sem que a versão fosse incrementada. Esses
registros antigos **não foram e não serão reescritos** — reescrever
histórico destruiria a própria rastreabilidade que este campo existe para
proteger. Uma investigação sobre uma decisão antiga registrada como "1.1"
pode precisar correlacionar `created_at` com o histórico de commits/deploy
para saber qual comportamento estava realmente vigente.

**"1.2" (estado anterior, já validado)**: proximidade cidade+UF e desempate
determinístico corrigidos (commit `cdfa0de`) — score, pesos, thresholds e
fórmula inalterados desde então.

**"1.3" (estado atual)**: motor idêntico ao "1.2" em score, pesos, fórmula e
thresholds — **nenhuma dessas quatro coisas mudou**. A única mudança de
comportamento observável é de **completude do rastro de auditoria**:
quando a quantidade da oportunidade já foi totalmente distribuída para
candidatos anteriores na mesma execução (`remaining <= 0`), um candidato
que já havia sido pontuado e já era estruturalmente elegível
(`finalScore >= MEDIUM_CONFIDENCE_THRESHOLD`) antes só desaparecia do
motor sem deixar nenhum registro — indistinguível de "nunca foi
candidato". A partir de "1.3", esse candidato passa a gerar uma
`match_evaluations` com `decision = "elegivel_sem_quantidade"` — nunca
"descartado" (não foi reprovado pelo score) — sem nunca criar uma
`opportunity_allocations` (a regra "sem quantidade, sem alocação" nunca
mudou, só a rastreabilidade de quem chegou a ser considerado). Registros
antigos gravados como "1.0"/"1.1"/"1.2" **não foram e não serão
reescritos**, pelo mesmo motivo já explicado acima.

A partir de "1.3", cada nova avaliação identifica de forma inequívoca a
versão comportamental vigente no momento em que foi calculada — mas, como
sempre, isso não retroage a avaliações já gravadas sob uma versão anterior.

**Nota separada — exclusão mútua do agendador não é o motor**: a proteção
contra sobreposição de execuções das tarefas agendadas
(`src/helpers/scheduledTaskLock.tsx`, ver `docs/OPERATIONS.md`) é uma
camada de execução operacional (advisory lock do Postgres), completamente
fora do motor de matching — não altera nenhum critério, peso, fórmula ou
decisão, e por isso **não é, por si só, motivo de bump de
`ALGORITHM_VERSION`**.

## Adaptador (`src/helpers/aiClient.tsx`)

Integração real com a API da Anthropic, configurada por variável de
ambiente (`ANTHROPIC_API_KEY`, `LEVORA_AI_MODEL`). Sem a chave configurada,
lança `AiNotConfiguredError` — o motor de matching já trata esse erro como
"seguir sem IA", nunca finge uma resposta.

## O que o master prompt descreve que NÃO existe

Nenhum dos agentes nomeados abaixo existe como componente separado de
código — não há orquestrador de múltiplos agentes, não há ferramentas
(`tool calling`) que um agente possa invocar sobre o banco, não há
histórico de execução de agente além do que `match_evaluations` já
registra para o matching:

- **Scout Agent** (descoberta automática de oportunidades) — não existe.
  A descoberta hoje é só manual (ver
  `src/helpers/connectorsManual.tsx` e README, "Estado conhecido/lacunas").
- **Verification Agent** (checagem de sinais de fraude/legitimidade) —
  não existe.
- **Qualification Agent** (match_score/urgency_score/logistics_score/risk_score
  separados) — parcialmente coberto pelos critérios do motor de matching
  (`criteria` em `match_evaluations`), mas não como agente separado nem
  com `risk_score` dedicado.
- **Outreach Agent / Negotiation Agent** (contato automático com doador,
  negociação de quantidade/condições) — não existe. Não há integração de
  canal de comunicação com doadores (ver `docs/WHATSAPP.md`).
- **Agente de Estoque** (detectar estoque parado, itens perto da validade,
  sugerir remanejamento) — não existe.
- **Agente de Necessidades** (sugerir déficit e alimentar o Scout Agent) —
  não existe.
- **Agente de Impacto** (métricas de impacto) — parcialmente coberto por
  `impact-report_GET.ts` (relatório de período, dados agregados reais, sem
  métrica inventada como "1 cobertor = 1 pessoa salva" — a regra do master
  prompt contra métricas enganosas já é seguida), mas sem ser um "agente"
  automatizado, é um relatório sob demanda.
- **AI Orchestrator com Policy Engine** (seção 43: todo pedido de ação de
  um agente passa por validação de política antes de executar) — não
  existe como camada separada, porque não há agente que peça para
  executar uma ação livre; a única IA do sistema hoje só retorna um score,
  nunca invoca uma ferramenta de mutação de dado diretamente.
- **Tabela de custo de execução de IA** (`ai_runs`, tokens, custo estimado,
  limite mensal por organização — seção 77-78 do master prompt) — não
  existe. Cada chamada à IA no matching não registra tokens consumidos nem
  custo.

## Princípios já seguidos, mesmo sem a arquitetura completa

- IA nunca decide sozinha algo de alto risco (o matching sempre tem regra
  determinística por trás, ver `docs/RBAC_PERMISSOES.md`/matching acima).
- Toda inferência é diferenciada de fato confirmado (`match_evaluations.decision`
  distingue `atribuido_automatico` de `proposto`, e a interface mostra a
  justificativa da IA como texto explicativo, não como afirmação).
- Sem registro estruturado por execução (modelo, versão de instruções,
  resultado) fora de `match_evaluations` — que já cobre isso para o único
  uso de IA que existe.

## Quando construir os agentes reais

Cada agente da lista acima, quando construído, deve seguir o mesmo padrão
já estabelecido pelo matching: ferramentas explícitas e limitadas (seção 44
do master prompt — "Scout pode: search_public_sources, create_opportunity;
não pode: alter inventory"), toda execução passando por validação de
política antes de tocar no banco, e um registro estruturado da execução.
Construir qualquer um desses agentes sem essas três coisas violaria a regra
do projeto contra fake features tanto quanto uma integração simulada.
