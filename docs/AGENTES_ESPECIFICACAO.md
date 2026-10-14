# Especificação — agentes da Levora Solidária (custo mínimo)

**Status: ESPECIFICAÇÃO PARA APROVAÇÃO. Nenhum código foi escrito.**
Substitui, como plano de trabalho, a lista de agentes "inexistentes" de
`docs/AI_AGENTS.md`, sem alterar o master prompt (que continua sendo o
contrato). Fontes: master prompt seções 2–5, 17–22, 34–36, 40–45, 53,
60–62, 66, 71–79, 81, 91–92, 94–95, 102–105, 127–135; `docs/ROADMAP_ATUAL.md`;
`docs/AI_AGENTS.md`; `docs/STAGING_ZERO_COST.md`; `db/schema.sql`;
`src/helpers/aiClient.tsx`; `src/helpers/scheduler.tsx`.

## 0. Princípio que governa tudo: custo mínimo

O projeto não tem capital (`docs/STAGING_ZERO_COST.md`) e precisa durar. A
regra é: **o sistema inteiro funciona com custo de IA igual a zero**; a IA é
um acelerador opcional, com teto, nunca uma dependência.

| # | Regra de custo | Consequência |
|---|---|---|
| C1 | Regra determinística primeiro, IA só quando a regra não resolve | Mesmo padrão que o matching já usa (`AI_AGENTS.md`) |
| C2 | Todo agente tem **modo sem IA** completo e testado | Sem chave, sem crédito ou com teto atingido, nada para |
| C3 | Nenhum serviço novo de infraestrutura | Sem Redis, filas externas, vetor, brokers: só Postgres + `node-cron` já existentes |
| C4 | IA apenas no modelo mais barato (hoje Haiku, `LEVORA_AI_MODEL`), saída curta, JSON estruturado | `max_tokens` e lote já limitados em `aiClient.tsx` |
| C5 | **Cache por hash de conteúdo**: o mesmo texto nunca é enviado duas vezes | Tabela `ai_cache` |
| C6 | IA só roda **sob evento** (algo mudou), nunca por varredura periódica | Sem custo quando nada acontece |
| C7 | Teto mensal duro por organização e global; ao atingir, **cai para o modo sem IA** e alerta | `ai_runs` + `ai_budgets` |
| C8 | Minimização de dados: só o texto necessário vai ao provedor; nunca dado de beneficiário | Seção 73 do master prompt |
| C9 | Canais pagos ficam **adiados**: WhatsApp Business cobra por conversa; usa-se e-mail, link e QR primeiro | Outreach só depois de decisão de orçamento |
| C10 | Sem mapas/rotas por API paga: distância por cidade+UF (já existe) e, se preciso, dados abertos | Sem custo por requisição |

Estimativa de gasto de IA **não é feita aqui** porque depende da tabela de
preços vigente do provedor; a fase de implementação deve calcular o custo
por execução real a partir de `ai_runs` e comparar com o teto antes de
ligar qualquer agente da camada C.

## 1. Estado atual (medido nos arquivos)

- **IA**: um único ponto, `opportunityMatching.tsx` via `aiClient.tsx`
  (Haiku, `max_tokens: 1024`, lote máximo de 20, timeout). Sem chave
  configurada o motor segue sem IA (`AiNotConfiguredError` tratado).
- **Agendador**: `node-cron` em processo, jobs declarados em
  `src/static/__dev/scheduled-jobs.json`, com advisory lock e pools
  separados (`scheduledTaskLock.tsx`). Roadmap seção 1 lista 5 tarefas.
- **Tabelas existentes (23)**: `users`, `user_passwords`, `sessions`,
  `login_attempts`, `organizations`, `memberships`, `audit_log`,
  `organization_capacities`, `organization_matching_settings`,
  `organization_service_areas`, `inventory_items`, `stock_transactions`,
  `needs`, `need_resolutions`, `donation_opportunities`, `sources`,
  `opportunity_registry`, `opportunity_allocations`, `background_task_runs`,
  `match_evaluations`, `need_fulfillments`, `logistics_events`,
  `approval_requests`, `organization_invites`, `files`.
- **Não existem**: doadores, voluntários, beneficiários, conversas e
  consentimento, alertas e revisões de risco, regras/políticas, `ai_runs`,
  `ai_cache`, transferências entre organizações, doadores recorrentes,
  base de conhecimento, registro de agentes.
- **Pré-requisito aberto**: papéis de agente dependem da gestão de membros
  (`docs/MEMBROS_ESPECIFICACAO.md`, roadmap seção 3, PRÓXIMO).

## 2. Invariantes (valem para todo agente)

1. Agente **nunca** acessa o banco direto: só via camada de ferramentas (§3.3).
2. Agente **nunca** decide estoque, permissão, aprovação ou dinheiro por
   texto livre (master prompt 103–105). Saída de IA é JSON validado por schema.
3. Toda ação de agente grava `audit_log` com `actor_type = 'agent'`, nome e
   versão do agente. O agente herda **o mínimo** de permissões; nunca mais
   que o global crítico, e organização só pode ser mais restritiva.
4. Detectou problema → **cria alerta/revisão**, nunca corrige sozinho
   (ex.: `INVENTORY_DISCREPANCY`, seção 34) e **nunca acusa** (seções 41, 62).
5. Tudo que vem de fora (página, mensagem, e-mail) é **dado, não instrução**
   (seção 75). Conteúdo externo nunca entra no campo de sistema do prompt.
6. Ledgers continuam append-only; migrations só crescem; mudar o resultado
   do matching exige bump de `ALGORITHM_VERSION`.
7. Todo agente respeita **pausar automação** e **modo emergência** (§3.6).
8. Nenhum agente se passa por outra entidade nem inventa disponibilidade,
   valor, necessidade, entrega ou aprovação (seção 4).

## 3. Plataforma (construída antes de qualquer agente)

### 3.1 Barramento de eventos (outbox no Postgres)
Tabela `domain_events` (id, tipo, organization_id, payload mínimo, criado_em,
processado_por). Gravada **na mesma transação** da mudança de negócio. Agentes
consomem por polling barato do `node-cron`; sem broker externo (C3).

### 3.2 Motor de regras e políticas
Tabelas `policy_rules` e `policy_limits` (seções 60 e 79:
`AUTO_ACCEPT_MAX_VALUE`, `AUTO_PICKUP_MAX_DISTANCE`, `HIGH_RISK_CATEGORIES`,
`FINANCIAL_APPROVAL_THRESHOLD`…). Regra por organização só restringe.
Avaliação é função pura e testável, sem IA.

### 3.3 Camada de ferramentas
Funções server-side explícitas (seção 72). Cada uma: valida organização,
valida permissão **do agente**, valida payload (zod), aplica política,
registra auditoria. Matriz de permissão por agente em código versionado
(seção 44). Agente sem a ferramenta na matriz recebe negação e gera alerta.

### 3.4 Agente como principal não humano
`agent_principals` (nome, versão, organization_id ou global, papel mínimo,
ativo). Requer a gestão de membros concluída para reutilizar papéis e
auditoria. `audit_log` ganha `actor_type` (migration nova).

### 3.5 Controle de IA e custo
- `ai_runs`: agente, modelo, tokens de entrada/saída, custo estimado,
  organização, job, resultado (ok/cache/fallback/erro). Seção 78.
- `ai_cache`: hash do conteúdo + versão do prompt → resposta validada, com TTL.
- `ai_budgets`: teto mensal por organização e global. Atingido → modo sem IA
  e alerta; segurança e suporte continuam (seção 78).
- `AiProvider` abstrato (Anthropic/Mock; outros depois, seção 73). O
  `MockProvider` é obrigatório para testes sem custo.

### 3.6 Controles de segurança operacional
- **Pausar automação** (global e por organização, seção 91) e **modo
  emergência** (seção 92): um interruptor lido por todo agente antes de agir.
- **Fila de exceções** (seção 45): `exception_queue` com a mensagem fixa "A
  automação foi interrompida por uma regra de proteção".
- **Centro de alertas** (seção 42): `integrity_alerts` com níveis ALTO RISCO,
  OPERACIONAL, SEGURANÇA.

### 3.7 Registro de agentes e prompts versionados
`agent_registry` (identidade, objetivo, ferramentas, política, limites,
versão, status) e `agent_prompt_versions` (seção 71). Toda mudança de prompt
gera log; ninguém edita prompt mestre por interface comum.

## 4. Elenco de agentes

Legenda de custo: **Z** = zero token (SQL/regras), **B** = IA rara, sob
evento, com cache e teto, **X** = adiado (depende de custo externo).

### Camada A — Guardiões (Z, rodam sempre)

| Agente | Faz | Eventos/gatilho | Saída |
|---|---|---|---|
| Sentinela de Integridade | Divergência físico×sistema; rajada de ajustes (ex.: 40 em 10 min); mesma pessoa em entrada+saída de alto valor; mesma entrega em vários destinos; alteração de item já distribuído | `stock_transaction.*`, `allocation.*` | `integrity_alerts` (ALTO RISCO) |
| Risk Engine | Sinais de fraude (volume súbito, conta nova com alto valor, quantidade declarada×recebida) | `opportunity.created`, `receipt.*` | `RISK_REVIEW` |
| Conflito de Interesse | Usuário declarado ligado a doador/fornecedor/beneficiário; bloqueia ação e pede revisão | ação sensível | exceção na fila |
| Agente de Estoque | Estoque parado, validade próxima, sugestão de remanejamento | diário | alerta OPERACIONAL |
| Vigia de Prazos | Coleta atrasada, reserva/aprovação expirando, necessidade urgente | a cada 15 min | alerta OPERACIONAL |

### Camada B — Fluxo (Z; IA opcional só em B2)

| Agente | Faz | Observação de custo |
|---|---|---|
| Necessidades (B1) | Déficit por necessidade ativa, recorrência, sazonalidade; sugere busca | Z |
| Matching | **Já existe** (v1.4); só passa a emitir/consumir eventos | já tem modo sem IA |
| Excedentes e Rede (B2) | Excedente de uma organização vira oferta para outra; transferência `REQUESTED→APPROVED→IN_TRANSIT→RECEIVED→COMPLETED`, dois lados (-X origem, +X destino) | Z; só entra se houver mais de uma organização ativa |
| Logística (B3) | Combina coletas na mesma cidade+UF, sugere voluntário por capacidade/disponibilidade, respeita limites | Z; sem API de mapas paga (C10) |
| Comprovantes (B4) | Verifica se cada etapa tem prova antes de fechar a oportunidade | Z |
| Recorrentes (B5) | Doadores/parceiros recorrentes: lembrete e previsão simples | Z |
| Impacto e Prestação de contas (B6) | Relatório semanal só com dados reais, linguagem factual, sem "1 cobertor = 1 pessoa salva" | Z; texto narrativo opcional via IA (B) |

### Camada C — IA nas bordas (B, sob teto)

| Agente | Faz | Contenção |
|---|---|---|
| Qualificação | `match_score`, `urgency_score`, `logistics_score`, `risk_score` separados | Parte determinística já cobre critérios; IA só avalia texto livre ambíguo; cache C5 |
| Verificação | Consistência do texto, sinais de golpe | Sinais determinísticos primeiro; **ambíguo vai para revisão humana**, nunca rejeita por inferência fraca |
| Atendimento ao beneficiário | Status, local de retirada, orientações | Respostas montadas de dados reais por template; IA só reformula; nunca expõe terceiros |
| Copiloto do administrador | Explica alertas, rascunha relatório | Sob demanda do usuário, nunca em loop |
| Scout/Descoberta (X) | Busca fontes públicas | Adiado: conectores, termos das plataformas e decisão de produto |
| Outreach e Negociação (X) | Contato e negociação com doador | Adiado: WhatsApp Business é pago por conversa; exige `CommunicationPolicyEngine`, opt-in e templates |

### Camada D — Meta (sustentam o legado; Z)

| Agente | Faz |
|---|---|
| Governador de agentes | Custo por agente, taxa de cache, versões de prompt, drift, conjunto de avaliação fixo por agente |
| Guardião da Continuidade | Pelo menos 2 administradores de plataforma; backup **restaura de verdade** (teste periódico); validade de certificados e rotação de segredos; `npm audit`; deriva entre docs e código |
| Curador de Dados (LGPD) | Retenção, anonimização, pedido do titular (seções 94–95) |

## 5. Orçamento de IA — modelo de decisão

- Camadas A, B (menos narrativa), D: **R$ 0 de IA**, para sempre.
- Camada C: cada agente só liga após medir custo por execução em `ai_runs`
  usando o `MockProvider` e uma amostra real pequena, e após o dono definir
  o teto mensal em `ai_budgets`.
- Fallback é o comportamento normal, não exceção: o sistema deve passar a
  bateria de testes completa com `ai_budgets = 0`.
- Provedor pode ser trocado por um modelo local no futuro sem reescrever
  domínio (`AiProvider`), caso o custo externo se torne inviável.

## 6. Fases de implementação (cada uma entregável e testável)

| Fase | Entrega | Depende de | Custo de IA |
|---|---|---|---|
| 0 | Decisões de produto pendentes (roadmap §4) e **gestão de membros** | — | 0 |
| 1 | Plataforma: eventos, regras/limites, camada de ferramentas, `agent_principals`, `actor_type`, alertas, fila de exceções, pausar/emergência | 0 | 0 |
| 2 | Camada A (Sentinela, Risk, Conflito, Estoque, Prazos) | 1 | 0 |
| 3 | Camada D mínima (Continuidade e Governador) | 1 | 0 |
| 4 | Camada B (Necessidades, Comprovantes, Impacto; depois Logística e Recorrentes) | 1, novas entidades (voluntários, doadores) | 0 |
| 5 | `ai_runs`, `ai_cache`, `ai_budgets`, `AiProvider`, `MockProvider` | 1 | 0 (infra) |
| 6 | Camada C (Qualificação, Verificação, Atendimento, Copiloto), um por vez com teto | 5 | sob teto |
| 7 | Excedentes e Rede entre organizações | 4 e mais de uma organização ativa | 0 |
| 8 | Scout e Outreach/Negociação | decisão de orçamento, conectores, WhatsApp | adiado |

## 7. Plano de testes (mínimo exigido por fase)

- Isolamento entre organizações para toda ferramenta nova
  (`test/crossOrgIsolation.test.ts` como modelo).
- Cada agente: teste de caminho feliz, de negação por permissão, de
  idempotência (mesmo evento processado duas vezes não duplica efeito) e de
  **modo sem IA**.
- Falha de IA e teto atingido (seções 116 e 78): o sistema segue funcionando.
- Prompt injection: conteúdo externo com instrução maliciosa não altera
  ferramenta nem regra (seção 75).
- Anticorrupção (seção 114): mesma pessoa registra entrada e aprova saída de
  alto valor gera alerta e bloqueio.
- Agente fora da matriz de ferramentas: nega e alerta.
- Pausar automação e modo emergência interrompem todos os agentes.

## 8. Fora de escopo desta especificação

Interface dos painéis de agentes, portal público de transparência, portal do
doador e do voluntário, WhatsApp, conectores externos, pagamentos e
financeiro (seção 39). Cada um terá especificação própria.

## 9. Decisões que exigem o dono do projeto

| # | Decisão | Padrão recomendado |
|---|---|---|
| D1 | Uma organização ou rede de várias desde o início? | Modelo já é multi-tenant; **adiar a camada de Rede (Fase 7)** até haver a segunda organização real |
| D2 | Teto mensal de IA (por organização e global) | Começar em **zero** (tudo sem IA) e subir só após medir custo real |
| D3 | Quem é o segundo administrador de plataforma (continuidade) | Definir antes da Fase 3; sem isso o Guardião da Continuidade alerta permanentemente |
| D4 | Limites de autonomia iniciais (`AUTO_ACCEPT_MAX_VALUE`, distância, custo logístico) | Valores conservadores; tudo acima vai para `NEEDS_APPROVAL` |
| D5 | Estorno do ledger (roadmap §4) | Resolver antes da Sentinela, pois define o que ela vigia |
| D6 | Canal de contato inicial com doadores | E-mail e link/QR; WhatsApp só com orçamento aprovado |
