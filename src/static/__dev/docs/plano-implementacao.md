# Plano de implementação — Levora Solidária

Este documento traduz o MASTER PROMPT V2.1 (fornecido pelo proprietário do
projeto) em fases executáveis dentro do ambiente Floot. Cada fase só é
considerada concluída quando testada de ponta a ponta — nenhuma tela ou botão
é marcado como pronto sem comportamento real por trás (ver seção 2 do master
prompt: "regra contra fake features").

## Restrição de plataforma importante

O master prompt pede subdomínios por organização (ex: `igreja-x.levora.org`).
O Floot **não suporta subdomínios multi-tenant** (ver floot-overview). Por
isso, o isolamento entre organizações é implementado como **multi-tenancy
lógico**: toda tabela sensível carrega `organization_id`, e toda rota de
API exige que o usuário autenticado seja membro ativo da organização antes
de ler ou escrever qualquer linha (`helpers/organizationAccess.tsx`). Isso
cumpre a exigência de isolamento rigoroso do master prompt sem depender de
subdomínios. Se subdomínios por organização forem um requisito não
negociável, isso exige hospedagem fora do Floot — a decisão fica registrada
aqui para o proprietário confirmar antes de prosseguirmos além da fase 1.

## Fase 1 — Fundação (EM ANDAMENTO)

- [x] Autenticação por e-mail/senha (provisionada pelo Floot: `users`,
      `sessions`, `user_passwords`, `login_attempts`).
- [x] Organizações multi-tenant (`organizations`) com tipo, cidade, estado,
      status.
- [x] Papéis por organização (`memberships`): proprietário, administrador,
      operador, voluntário — não um papel global único.
- [x] Isolamento de acesso: `helpers/organizationAccess.tsx`
      (`requireOrganizationMembership`) usado em toda rota que toca dados de
      uma organização.
- [x] Trilha de auditoria imutável (`audit_log`) com triggers de banco que
      bloqueiam `UPDATE`/`DELETE` — não é apenas convenção de aplicação, é
      restrição de banco de dados.
- [x] Helper `helpers/auditLog.tsx` (`recordAuditLogEntry`) — único caminho
      recomendado para gravar auditoria, sempre dentro da mesma transação da
      ação de negócio.
- [x] Fluxo real: criar organização → vira proprietário → aparece no painel
      → ver equipe e auditoria da organização.
- [x] Todo texto de interface em português brasileiro (menus, formulários,
      mensagens de erro, estados vazios).
- [ ] Convite de membros por e-mail (adicionar usuário existente/novo a uma
      organização com um papel). Ainda não implementado.
- [ ] Painel de administração da plataforma (Levora como operadora,
      aprovação de organizações em "em_analise").

## Fase 2 — Necessidades e inventário (CONCLUÍDA)

- [x] Itens de inventário por organização (`inventory_items`).
- [x] Ledger de estoque append-only (`stock_transactions`, com triggers de
      banco bloqueando `UPDATE`/`DELETE`, igual à trilha de auditoria).
      Saldo atual = soma dos lançamentos, nunca um contador solto.
- [x] Lançamento de entrada/saída/ajuste com verificação de saldo (saída não
      pode deixar o estoque negativo — testado, retorna 409).
- [x] Cadastro de item já permite quantidade inicial, que gera
      automaticamente um lançamento de entrada real (não um número mágico).
- [x] Necessidades (`needs`) por organização, com prioridade e status,
      opcionalmente vinculadas a um item do inventário.
- [x] Interface: `/organizacoes/:id/inventario` e
      `/organizacoes/:id/necessidades`, navegação por abas na página da
      organização.
- [x] Papéis: proprietário/administrador/operador podem cadastrar e
      movimentar; voluntário só visualiza (sem botões de ação).
- [ ] Vínculo automático entre necessidade atendida e saída de estoque —
      ainda manual (marcar status "atendida" não gera uma saída sozinho).
      Isso será resolvido na fase de distribuição, quando o fluxo de
      "atender uma necessidade" vai gerar a movimentação de estoque
      correspondente automaticamente, com prova.

## Fase 3 — Oportunidades de doação (CONCLUÍDA, com escopo reduzido registrado)

- [x] Registro manual de oportunidades de doação por organização (título,
      doador, contato, quantidade oferecida, categoria).
- [x] Ciclo de status: registrada → em contato → confirmada → recebida ou
      cancelada. "Recebida" só é alcançável pelo endpoint dedicado de
      recebimento (não por uma troca de status simples) e é terminal —
      testado: tentar mudar o status depois de recebida retorna 409, e
      tentar receber duas vezes também retorna 409.
- [x] Recebimento real: ao confirmar o recebimento, é obrigatório escolher
      um item do inventário e informar a quantidade **realmente conferida**
      (que pode ser menor que a oferecida) — isso gera uma linha real em
      `stock_transactions`, não apenas muda um texto de status. Testado:
      recebi 22 de 25 oferecidos, o saldo do item refletiu exatamente 22.
- [x] Sugestão de necessidades relacionadas: cruzamento de palavras-chave
      entre o título/categoria da oportunidade e as necessidades abertas da
      organização. Isto é **explicitamente rotulado na interface** como
      sugestão por palavra-chave, não como IA nem como confirmação
      automática — porque, tecnicamente, ainda não é IA nenhuma, é um
      filtro de texto. Nenhum agente de IA foi construído nesta fase.

### Decisão de escopo registrada (importante para você revisar)

O master prompt descreve descoberta automática de oportunidades (o sistema
"procura" doações, inicia contato, negocia) e um pool compartilhado entre
organizações antes de uma oportunidade ser destinada a alguém. Isso não foi
construído agora, por dois motivos:

1. Não existe ainda nenhum conector real (WhatsApp, e-mail, scraping) para
   descobrir oportunidades sozinho — construir isso fingindo que existe
   violaria a regra contra fake features. Quando essa fase vier, cada fonte
   será um adaptador real, testável, declarado como automático só depois de
   funcionar de verdade.
2. Um "pool" de oportunidades sem organização dona ainda exigiria um papel
   de nível de plataforma (equipe da própria Levora, não de uma
   organização) que não existe no modelo atual — hoje toda oportunidade
   pertence a uma organização desde a criação. Isso é suficiente para o
   caso de uso "um operador da organização registra um contato que ele
   mesmo fez", mas não cobre "a Levora descobre uma doação e decide para
   qual organização ela vai". Se esse fluxo for prioridade, ele precisa
   entrar como uma fase própria (painel de plataforma + papel de operador
   Levora), não espremido aqui.

## Fase 4 — Discovery Engine e Registro Central de Oportunidades (CONCLUÍDA)

Implementada em resposta direta ao pedido de correção de arquitetura feito
depois da fase 3. Auditoria completa das 7 perguntas em
`docs/auditoria-descoberta.md`.

- [x] `sources` (Registro de Fontes) com todos os campos pedidos
      (credencial referenciada por nome de variável, nunca valor; política;
      frequência; estado de conexão; erros recentes).
- [x] `helpers/connectorsTypes.tsx`: contrato `SourceConnector` com os 13
      pontos pedidos. Novo conector = implementar esta interface, núcleo
      não muda.
- [x] `helpers/connectorsManual.tsx`: único conector real hoje — descoberta
      manual por operador de plataforma (`users.role = 'admin'`).
- [x] Regra do servidor (não da interface): uma fonte só nasce `ativa` se o
      `connectorKey` for `manual`; qualquer outro tipo nasce
      `nao_configurada`, e tentar registrar uma descoberta por ela retorna
      409 com a mensagem "Conector não configurado..." — testado.
- [x] `opportunity_registry`: registro central, sem organização dona, com
      máquina de estados validada no servidor (mapa de transições
      permitidas — testado: transição inválida retorna 409).
- [x] `opportunity_allocations`: permite dividir uma oportunidade entre
      várias organizações, sem a Levora ser dona física de nada. Testado
      ponta a ponta: 50 mesas descobertas, 20 atribuídas à Igreja A e 30 à
      Igreja B; uma tentativa de atribuir mais 5 além do total foi
      bloqueada (409, "restam 0"); Igreja A aceitou e recebeu (gerou
      entrada real de estoque de 20 unidades), Igreja B recusou; a
      oportunidade central foi automaticamente marcada `concluida` quando
      todas as atribuições ficaram em estado terminal com pelo menos um
      recebimento real.
- [x] Página `/plataforma` (só `admin`): fontes + registro central +
      atribuição a organizações.
- [x] Página `/organizacoes/:id/atribuicoes`: aceitar/recusar/receber
      atribuições vindas da rede Levora, reaproveitando o mesmo mecanismo
      de recebimento→estoque já testado na fase 3.
- [ ] `aguardando_coleta` e `em_transporte` existem no enum mas não são
      usados por nenhum fluxo ainda — pertencem à fase de logística
      (coleta/transporte/prova de entrega), que ainda não foi construída.
      Usá-los agora sem rastreamento real de transporte seria fingir uma
      etapa que não existe.
- [ ] Nenhum agendamento (`queueTask`/`scheduled-jobs`) foi criado. Existem
      no Floot e o `SourceConnector.run()` já está pronto para ser chamado
      por um job, mas agendar a execução de um conector que não faz nada
      de real seria simular automação. Entra junto com o primeiro conector
      de verdade (site público, e-mail autorizado, etc.).
- [ ] Matching automático (o motor descrito na correção de arquitetura,
      comparando distância/urgência/capacidade/regras da organização)
      ainda não existe — hoje quem decide a divisão entre organizações é
      sempre um humano (`admin`) pelo painel de plataforma. A sugestão por
      palavra-chave da fase 3 continua sendo o único auxílio automático, e
      continua rotulada como heurística, não IA.

## Fase 5 — Motor de tarefas e Motor de correspondência (EM ANDAMENTO)

Decisão revista pelo proprietário: o agendamento e o matching automático
NÃO ficam para depois — são construídos agora, mesmo sem fontes externas
configuradas, operando sobre as oportunidades já reais do sistema.

### Motor de tarefas
- [x] `background_task_runs`: tabela de execução/histórico real —
      idempotência por `idempotency_key` único, `attempt_count`,
      `status` (pendente/executando/concluida/falhou/cancelada), payload,
      erro, resultado. Todo handler de tarefa escreve aqui antes e depois
      de rodar — não é só o `@floot/queueTask` interno, é uma trilha
      própria, consultável e reprocessável manualmente pela plataforma.
- [x] Tarefas internas reais implementadas: expirar oportunidades vencidas,
      expirar reservas de atribuição automática vencidas (com nova
      tentativa de matching), varredura periódica de matching para
      oportunidades aguardando destinação. Agendadas via
      `static/__dev/scheduled-jobs.json` (schedule fixo, não precisa
      decisão em runtime).
- [ ] As demais tarefas internas listadas (reprocessar notificações,
      indicadores, verificações de consistência, etc.) NÃO foram
      implementadas — o padrão (`background_task_runs` + handler) está
      pronto para receber cada uma quando a funcionalidade que ela
      depende existir (notificações, indicadores) também existir.
      Implementá-las agora seria criar tarefas sem nada real para
      verificar.
- [ ] Tarefas ligadas a conectores externos (`CONSUMIR_FONTE_FACEBOOK` etc.)
      não foram criadas — não há fonte configurada para consumir. Quando
      uma fonte real for configurada, sua tarefa nasce com o mesmo padrão,
      "desabilitada" até lá.

### Motor de correspondência
- [x] `helpers/opportunityMatching.tsx`: motor determinístico e auditável.
      Critérios calculados com dado real hoje: compatibilidade de
      categoria (texto + IA como apoio quando o texto não bate, ver
      abaixo), urgência da necessidade, cobertura de quantidade,
      proximidade por cidade/estado (aproximação — sem geocodificação
      real, ver limitação abaixo). Critérios pedidos sem dado real
      disponível (capacidade de armazenamento, capacidade logística,
      horários, raio de atendimento em km) entram no registro de auditoria
      como `"nao_aplicavel: dado nao coletado ainda"` — nunca como um
      número inventado.
- [x] IA como apoio, não como decisão: quando o casamento por palavra-chave
      de categoria é fraco, uma chamada a `gpt-5.6-luna` avalia
      equivalência semântica (ex: "cobertor" ~ "roupa de cama de inverno")
      e ajusta só o sub-escore de categoria — nunca ignora restrição,
      capacidade ou localização. Se a IA falhar ou estiver indisponível,
      o motor segue com o escore por palavra-chave puro (nunca bloqueia
      o matching).
- [x] Três faixas de confiança, com limites configuráveis em código:
      ≥90% atribui automaticamente (sem esperar aceite de ninguém);
      70–89,99% cria proposta e aguarda confirmação da organização;
      <70% não atribui, oportunidade continua disponível.
- [x] Reserva com expiração (30 min) para propostas de confiança média —
      `opportunity_allocations.reserved_until` — liberada automaticamente
      pela tarefa de expiração, que também tenta o matching de novo.
- [x] Divisão automática entre organizações: candidatos ordenados por
      pontuação, alocados em ordem até esgotar a quantidade ou as
      necessidades cobertas.
- [x] Reavaliação automática nos gatilhos: oportunidade entra em
      "aguardando destinação"; uma organização recusa uma atribuição
      proposta; reserva expira. (Gatilhos não implementados ainda:
      necessidade nova cadastrada, organização fica indisponível — listados
      como pendência abaixo.)
- [x] `match_evaluations`: registra critério a critério, peso, resultado,
      pontuação final, versão do algoritmo, se IA foi usada, e a decisão
      tomada — consultável por oportunidade no painel de plataforma.
- [ ] Gatilho de reavaliação ao criar/editar uma necessidade ainda não
      dispara matching sozinho — fica para quando o volume justificar
      (evitar reavaliar tudo a cada clique).
- [ ] Campos de capacidade/raio de atendimento por organização ainda não
      existem no cadastro — sem eles, esses critérios continuam marcados
      como não aplicáveis no registro de auditoria, por design, não por
      omissão.

## Fase 6 — Logística: coleta, transporte, prova de entrega (CONCLUÍDA)

- [x] `logistics_events`: linha do tempo append-only (mesma trava de banco
      contra UPDATE/DELETE das outras tabelas de auditoria) por
      atribuição — coleta agendada, coleta concluída, transporte iniciado,
      entrega confirmada, cancelado.
- [x] `opportunity_allocations.status` ganhou `em_transporte` (já existia
      `em_coleta`). Transições validadas no servidor por mapa explícito —
      testado: pular etapa fora de ordem (agendar coleta com a atribuição
      já em transporte) retorna 409.
- [x] Endpoint `allocations-logistics` (organização) registra cada evento e
      move o status da atribuição junto — não é só um log solto.
- [x] `allocations-receive` (recebimento com prova) passou a aceitar
      atribuições em "aceita", "em coleta" ou "em transporte" — permite
      tanto o caminho simples (aceitar e já confirmar entrega, sem
      rastrear etapas) quanto o caminho completo com logística rastreada.
      Ganhou campo opcional de link de comprovante (`proof_url`), gravado
      como evento "entrega confirmada" na linha do tempo.
- [x] Cancelar durante coleta/transporte reabre a oportunidade central para
      novo matching automaticamente — mesmo mecanismo já testado na fase 5.
- [x] Testado ponta a ponta: match automático (100%) → coleta agendada →
      transporte iniciado → tentativa de reordenar etapa (409) → entrega
      confirmada com link de comprovante → linha do tempo completa com os
      3 eventos → oportunidade central marcada "concluída" sozinha.
- [ ] **Upload real de foto como prova não existe** — `proof_url` é hoje um
      campo de texto onde se cola um link já hospedado em outro lugar. Um
      upload de arquivo de verdade exigiria um bucket de armazenamento
      configurado (não configurado neste projeto). Não fingido como
      "upload" na interface — está rotulado como link, não como anexo.
- [ ] Logística para as oportunidades locais (`donation_opportunities`, o
      fluxo direto de contato da fase 3) continua em um único passo
      ("registrar recebimento"), sem coleta/transporte separados — decisão
      deliberada: esse fluxo é para doações que o próprio operador já
      buscou ou recebeu diretamente, onde uma linha do tempo de logística
      não agrega nada. Só a atribuição central (rede Levora) tem
      logística em etapas, porque só ela tem de fato uma distância entre
      "quem descobriu" e "quem recebe".

## Fase 7 — Dupla autorização (CONCLUÍDA, escopo inicial)

- [x] `approval_requests`: mecanismo genérico e reutilizável de dupla
      autorização — uma ação de alto risco vira um pedido pendente em vez
      de executar na hora; guarda o payload completo da ação real.
- [x] Primeiro caso real aplicado: **ajuste de estoque com redução grande**
      (≥20 unidades ou ≥30% do saldo atual) — o vetor de fraude mais óbvio
      do sistema (reduzir saldo "no ajuste" para encobrir desvio, sem
      passar por uma saída rastreável de distribuição). Endpoint
      `stock-transactions` passou a devolver 202 (pendente) em vez de
      aplicar a movimentação nesse caso.
- [x] Regra central testada e confirmada: **quem pediu não pode aprovar o
      próprio pedido** — testado com a mesma pessoa tentando aprovar
      (bloqueado, 403) e depois uma segunda pessoa da organização
      aprovando de verdade (a movimentação de estoque só foi criada nesse
      momento, com o saldo mudando exatamente então, nunca antes).
- [x] Aprovar reexecuta a ação real (não é um simples "flag" mudando) —
      quem decide precisa ter papel de proprietário ou administrador.
      Rejeitar não aplica nada e fica registrado.
- [x] Painel de "pedidos de aprovação pendentes" na tela de Inventário,
      visível só para proprietário/administrador.
- [ ] Só um tipo de ação de alto risco está coberto hoje (ajuste de
      estoque). O mecanismo (`approval_requests` +
      `helpers/approvals.tsx`) é genérico e pronto para outros casos que o
      master prompt cita — atribuição manual de alto valor pela plataforma,
      aprovação de organização, etc. — mas cada um precisa da mesma
      decisão de "qual limite dispara a exigência" e não foi feita para
      todos ainda, para não travar ações de baixo risco com burocracia
      desnecessária sem critério.
- [ ] Sem limite de tempo/expiração para um pedido de aprovação parado —
      diferente da reserva de matching (30 min), aqui não há expiração
      automática ainda.



## Limitação registrada: proximidade não é distância real

O critério de localização usa cidade/estado (mesma cidade = melhor, mesmo
estado = médio, estado diferente = baixo) porque não há geocodificação
nem cálculo de distância real (isso exigiria uma integração de mapas —
Google Maps/Mapbox — não configurada). Isso está exposto explicitamente no
registro de auditoria de cada match como `"proximidade: aproximacao por
cidade/estado, nao e distancia em km"`, para nunca ser confundido com um
cálculo geográfico real.




## Fases seguintes (não iniciadas — dependem da fase 1 estar estável)

Cada uma será um domínio implementado e testado isoladamente, seguindo a
ordem de prioridade do master prompt (segurança > automação; controle de
risco > automação total; isolamento > velocidade):

2. **Necessidades e inventário** — cadastro de necessidades por organização,
   itens de inventário, transações de estoque reais (nunca "estoque
   atualizado" sem linha de transação).
3. **Oportunidades de doação** — descoberta, deduplicação, classificação,
   matching com necessidades. IA aqui é *assistiva*: toda sugestão marcada
   como inferência, nunca como fato confirmado.
4. **Logística** — coleta, transporte, entrega, prova de conclusão.
5. **Distribuição e prestação de contas** — comprovantes, relatórios de
   impacto.
6. **Ações de alto risco e dupla autorização** — separação explícita entre
   ações automáticas de baixo risco, ações condicionadas a regras e ações
   que exigem aprovação humana (dupla, quando envolver valores altos ou
   dados sensíveis de beneficiários).
7. **Agentes de IA especializados** — cada execução registrada com modelo,
   versão de instruções e resultado estruturado (nunca "IA analisou" sem
   essa trilha).
8. **Integrações externas** (WhatsApp Business, pagamentos, fontes de
   oportunidades) — cada uma como adaptador isolado, com modo de teste
   explícito enquanto a credencial real não estiver conectada, sem nunca
   fingir que a integração está ativa. A matriz de conformidade por
   provedor (seção 22 do master prompt) será documentada antes de qualquer
   conector ir para produção.

## Como cada fase deve ser entregue

1. Ler o que já existe antes de mudar.
2. Atualizar este arquivo e `status-implementacao.md`.
3. Implementar o domínio (banco → helpers de autorização/auditoria →
   endpoints → interface).
4. Testar o fluxo real (não apenas checar tipos).
5. Só então avançar para o próximo domínio.
