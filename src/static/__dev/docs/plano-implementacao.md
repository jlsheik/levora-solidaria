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
- [x] ~~Convite de membros por e-mail~~ — resolvido na Fase 9.
- [x] ~~Painel de administração da plataforma (Levora como operadora,
      aprovação de organizações em "em_analise")~~ — já existe desde a Fase 4
      (`/plataforma`, `platform-organizations_GET`/`-status_POST`); este
      checkbox só não tinha sido atualizado quando a fase foi concluída.

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
- [x] ~~Vínculo automático entre necessidade atendida e saída de estoque~~
      — resolvido na Fase 10 (ver abaixo), antes do previsto originalmente
      (a versão inicial ficará mais completa quando a fase de distribuição
      com prova for construída, mas a baixa automática já funciona hoje).

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
      oportunidades aguardando destinação. `static/__dev/scheduled-jobs.json`
      define o schedule de cada uma.
      **Correção registrada na Fase 12**: até a Fase 12, esse JSON não
      tinha nenhum disparador real por trás fora do Floot — só existia o
      reprocessamento manual (`background-tasks-retry_POST`, exige status
      "falhou"). "Agendadas" aqui descrevia a intenção documentada, não o
      comportamento real do sistema rodando; ver Fase 12 para o agendador
      de verdade que fecha essa lacuna.
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
- [x] ~~Upload real de foto como prova não existe~~ — resolvido na Fase 11
      (ver abaixo). `proof_url` continua aceitando link externo colado
      manualmente também — as duas formas coexistem.
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
- [x] ~~Sem limite de tempo/expiração para um pedido de aprovação parado~~
      — resolvido na Fase 12 (ver abaixo).



## Fase 8 — Suíte de testes automatizados (CONCLUÍDA, escopo inicial)

Auditoria confirmou que nada disto existia antes: não havia `npm test`
configurado, nenhum framework de teste instalado, nenhum arquivo
`*.spec.ts`/`*.test.ts`. Toda a validação das fases 1–7 foi manual (chamadas
HTTP reais + simulação de tempo via SQL direto no banco). Ver
[`docs/TESTING.md`](../../../../docs/TESTING.md) para a documentação completa.

- [x] `vitest` escolhido como test runner (já compartilha config/transform
      com o Vite existente no projeto; nenhuma dependência nova de bundler).
- [x] Banco de dados de teste dedicado, isolado do de desenvolvimento —
      `test/global-setup.ts` cria/recria o schema do zero a cada execução da
      suíte, com checagem de segurança que recusa rodar se o nome do banco
      não terminar em `_test` (nunca dropar o banco de desenvolvimento por
      engano).
- [x] Testes de integração chamam `handle()` dos endpoints diretamente (Web
      Fetch API, sem precisar subir o Express) — cobrindo autenticação real
      (sessão na tabela `sessions`, não mock), autorização
      (`requireOrganizationMembership`) e a query real no Postgres.
- [x] Cobertura inicial: cadastro/login/bloqueio por força bruta (5
      tentativas), isolamento multi-organização em `stock-transactions` e
      `needs-status` (um usuário não acessa nem referencia dado de outra
      organização), saldo de estoque nunca negativo, dupla aprovação
      disparando corretamente para ajuste de alto risco, e teste unitário
      puro do motor de correspondência (pontuação por palavra-chave).
- [x] `npm test` / `npm run test:watch` / `npm run test:coverage`
      adicionados ao `package.json`.
- [x] ~~Cobertura de isolamento multi-organização ainda não estendida a
      todos os domínios~~ — resolvido na Fase 20
      (`test/crossOrgIsolation.test.ts`: `opportunity_allocations`,
      `approval_requests`, isolamento de plataforma do
      `opportunity_registry`). `logistics_events` coberto indiretamente
      (é gravado pelo mesmo endpoint testado para `opportunity_allocations`).
- [x] ~~Sem pipeline de CI configurado neste repositório~~ — resolvido na
      Fase 20 (`.github/workflows/ci.yml`).



## Fase 9 — Convite de membros por e-mail (CONCLUÍDA)

Auditoria confirmou: não existia. Adicionar alguém a uma organização exigia
inserir a linha em `memberships` direto no banco. Ver
[`docs/CONVITE_DE_MEMBROS.md`](../../../../docs/CONVITE_DE_MEMBROS.md) para
a documentação completa do fluxo.

- [x] Nova tabela `organization_invites` (token hasheado, nunca em texto
      puro — mesmo princípio dos códigos de ativação de organização, seção
      9 do master prompt) — `db/schema.sql` + `db/migrations/0001_organization_invites.sql`.
      Primeira migração incremental do projeto: até agora `schema.sql` era
      aplicado só em banco novo; bancos já provisionados agora têm
      `npm run db:migrate:incremental` (`db/run-migrations.ts`, com tabela
      `schema_migrations` de controle) para receber mudanças de schema sem
      perder dados.
- [x] Adaptador real de e-mail (`src/helpers/emailAdapter.tsx`, SMTP via
      nodemailer) — sem credenciais configuradas, cai num modo
      "não configurado" que a interface expõe explicitamente (nunca finge
      que enviou um e-mail). Primeiro adaptador de integração externa real
      do projeto, seguindo o padrão do master prompt para credenciais
      ausentes (seção 1: "crie o adaptador real... a primeira inicialização
      deve informar quais credenciais faltam, sem quebrar a aplicação").
- [x] 4 endpoints: criar convite (`organization-invites_POST`, só
      proprietário/administrador), listar (`organization-invites_GET`,
      mesma restrição — a lista tem e-mail de quem ainda não é membro),
      revogar (`organization-invites-revoke_POST`), aceitar
      (`organization-invites-accept_POST`) + um GET público de consulta
      (`organization-invites-lookup_GET`, para a tela de aceite antes do
      login).
- [x] Regra de segurança central testada: aceitar um convite exige que o
      e-mail da conta logada seja EXATAMENTE o e-mail convidado (403 caso
      contrário) — sem isso, um link de convite vazado serviria para
      qualquer pessoa entrar na organização.
- [x] Página pública `/convites/:token` — funciona tanto para quem já tem
      conta (login) quanto para quem não tem (cadastro, com e-mail
      pré-preenchido); aceita automaticamente assim que a sessão bate com o
      e-mail do convite, sem clique extra.
- [x] Testado com o app rodando de verdade no navegador (não só a suíte
      automatizada): criar organização → convidar → copiar link (SMTP não
      configurado no ambiente local, como esperado) → abrir o link em outra
      aba com a MESMA sessão logada → bloqueado corretamente por e-mail
      diferente → logout → cadastro pelo link → aceite automático → membro
      aparece ativo na equipe com o papel correto.
- [x] 9 testes de integração cobrindo criação, autorização,
      "já é membro" (409), aceite com e-mail certo, aceite com e-mail
      errado (403), revogação bloqueando aceite (410), expiração
      bloqueando aceite (410), listagem restrita por papel, e substituição
      automática de convite pendente duplicado.
- [ ] Não há reenvio "de verdade" (hoje reenviar = revogar + criar outro,
      o que resolve o caso de uso mas deixa duas linhas na tabela).
- [ ] Convite direto para `proprietario` não é permitido — decisão
      deliberada, não lacuna (ver `docs/CONVITE_DE_MEMBROS.md`).



## Fase 10 — Baixa automática de estoque ao atender necessidade (CONCLUÍDA)

Auditoria confirmou: `needs-status_POST.ts` só fazia `UPDATE needs SET
status`, nunca tocava em `stock_transactions` — a pendência já estava
documentada na Fase 2.

- [x] Ao marcar uma necessidade vinculada a um item de inventário
      (`needs.item_id`) como `atendida`, o endpoint agora, na MESMA
      transação: trava a linha do item (`FOR UPDATE`, mesmo padrão de
      `stock-transactions_POST.ts`), calcula o saldo atual, e insere uma
      saída de `stock_transactions` de `quantity_needed`.
- [x] Se o saldo for insuficiente, a resposta é 409 com mensagem explicando
      exatamente o saldo disponível e o necessário — a necessidade
      **continua "aberta"**, nada é alterado (sem "atendida" fantasma sem
      estoque de verdade por trás).
- [x] Idempotente: só dispara na transição para "atendida" vinda de outro
      status. Reenviar "atendida" quando já está "atendida" não duplica a
      saída.
- [x] Necessidade sem item vinculado (`item_id IS NULL`) continua
      funcionando como antes — sem baixa automática, porque não há o que
      dar baixa (limitação conhecida e documentada, não um bug).
- [x] Reverter o status de "atendida" para outro NÃO desfaz a saída
      automaticamente — decisão deliberada: uma reversão automática do
      estoque seria uma "alteração silenciosa do histórico" (proibida pelo
      master prompt); uma correção real precisa ser um lançamento manual
      explícito e visível.
- [x] Testado com o app rodando de verdade: item com 100 em estoque →
      necessidade de 60 vinculada → marcar atendida → saldo cai para 40,
      com o lançamento de saída mostrando "Baixa automática: necessidade
      [...] marcada como atendida" na tela de inventário. Segundo teste:
      necessidade de 999 (mais que o saldo) → bloqueado com 409, mensagem
      exibida na tela, necessidade permanece "Aberta".
- [x] 4 testes de integração: baixa com saldo suficiente, bloqueio com
      saldo insuficiente (e confirmação de que nenhuma transação foi
      criada), ausência de baixa quando não há item vinculado, e
      idempotência ao reenviar o mesmo status.



## Fase 11 — Upload real de arquivo (comprovação de entrega) (CONCLUÍDA)

Auditoria confirmou: `proof_url` era só texto; existia um componente de UI
(`FileDropzone.tsx`) pronto mas totalmente desconectado — sem endpoint de
upload, sem storage adapter no backend. Ver
[`docs/UPLOAD_DE_ARQUIVOS.md`](../../../../docs/UPLOAD_DE_ARQUIVOS.md) para
a documentação completa.

- [x] Nova tabela `files` (`db/schema.sql` + `db/migrations/0002_files.sql`,
      segunda migração incremental do projeto).
- [x] `src/helpers/storageAdapter.tsx` — dois backends reais: disco local
      (padrão, sem configuração nenhuma necessária, fora de qualquer pasta
      servida como estática) e S3-compatível (AWS S3/R2/MinIO, ativado só
      quando as 4 variáveis de ambiente existem; SDK importado
      dinamicamente, só quando de fato configurado).
- [x] `files-upload_POST` (base64 no corpo JSON, mesma convenção de todo o
      resto do projeto — sem multipart) com validação de tipo (imagem/PDF),
      tamanho (8MB) e membership.
- [x] `files-download_GET` — funciona como o "signed URL" do sistema: a
      autorização é a sessão autenticada + membership, checada a cada
      download, em vez de um token separado que poderia vazar.
- [x] **Bug pré-existente corrigido, necessário para isto funcionar**:
      `server/index.ts` convertia toda resposta de endpoint para texto
      (`.text()`) antes de repassar ao Express, o que corromperia qualquer
      corpo binário. Trocado por `.arrayBuffer()` + `Buffer.from(...)`.
- [x] `allocations-receive_POST` ganhou `proofFileId` opcional — valida que
      o arquivo pertence à mesma organização (404 caso contrário) e grava a
      URL interna de download em `logistics_events.proof_url`, coexistindo
      com o link externo colado manualmente (continua funcionando).
- [x] Interface: `FileDropzone` conectado de verdade na tela de
      recebimento/entrega; link de comprovante na linha do tempo virou um
      link clicável em vez de texto cru.
- [x] Testado com o app rodando de verdade: enviado um PNG real pelo
      formulário de recebimento → confirmado bytes idênticos ao abrir
      `/_api/files-download?fileId=1` direto no navegador (o navegador
      reconheceu e renderizou a imagem de 1×1 pixel).
- [x] 8 testes de integração: upload grava no storage e na tabela `files`,
      download devolve os bytes exatos, download bloqueado (403) para quem
      não é membro, tipo de conteúdo não permitido rejeitado, arquivo acima
      do limite rejeitado, upload bloqueado (403) para não-membro, 404 para
      arquivo inexistente, e o vínculo `proofFileId`→`proof_url` em
      `allocations-receive` (incluindo rejeição de arquivo de outra
      organização, 404).
- [ ] Sem exclusão de arquivo pelo usuário nem limite de armazenamento por
      organização (ver "o que ainda não existe" em
      `docs/UPLOAD_DE_ARQUIVOS.md`).



## Fase 12 — Agendador real de tarefas + expiração de aprovações pendentes (CONCLUÍDA)

**Achado importante desta fase, não pedido mas descoberto ao investigar a
expiração de aprovações**: nenhuma das 3 tarefas agendadas da Fase 5
(`runMatchingSweep`, `expireReservations`, `expireOpportunities`) tinha um
disparador real fora do Floot. `static/__dev/scheduled-jobs.json` sempre
existiu e as funções sempre estiveram corretas, mas nada no Express as
chamava periodicamente — no Floot original, a própria plataforma lia esse
JSON e disparava cada tarefa; essa peça nunca foi portada. Na prática,
reserva de matching "expira em 30 minutos" e oportunidade "expira" eram
comportamento documentado que não acontecia sozinho — só rodava via
reprocessamento manual de uma execução já marcada como "falhou"
(`background-tasks-retry_POST`, e mesmo assim só para o platform admin).
Isso é exatamente o tipo de lacuna que a regra contra "fake features" do
master prompt proíbe deixar sem sinalização, então esta fase resolve as
duas coisas juntas.

- [x] `src/helpers/scheduler.tsx` — agendador real com `node-cron`, lê
      `scheduled-jobs.json` e registra cada tarefa habilitada, validando a
      expressão cron antes de agendar e isolando falha de uma tarefa das
      outras (uma tarefa que lança exceção não derruba o processo nem afeta
      as demais). Chamado em `server/index.ts` depois do `app.listen`.
- [x] Verificado isoladamente (script descartável, não versionado) que as 4
      tarefas registram sem exceção: `runMatchingSweep` (`*/15 * * * *`),
      `expireReservations` (`*/10 * * * *`), `expireOpportunities`
      (`0 * * * *`), `expireApprovalRequests` (`0 * * * *`).
- [x] `src/helpers/expireApprovalRequests.tsx` — pedido de dupla autorização
      pendente há mais de `APPROVAL_REQUEST_EXPIRATION_DAYS` (padrão 7 dias)
      vira `expirada`. Mesmo princípio da reserva de matching vencida: não
      aplica nem rejeita a ação pendente sozinho, só marca que o pedido não
      é mais válido — quem precisar da ação tem que pedir de novo.
- [x] `approval-requests-decide_POST` já recusava decidir um pedido fora de
      "pendente" (409) — nenhuma mudança necessária ali, o novo status
      "expirada" já cai nesse caminho existente.
- [x] Adicionado ao mapa de reprocessamento manual
      (`background-tasks-retry_POST`) para consistência com as outras 3
      tarefas.
- [x] 4 testes de integração: expira pedido antigo (com auditoria
      `aprovacao.expirada`), não mexe em pedido dentro do prazo, não mexe em
      pedido já decidido (aprovado/rejeitado) mesmo que antigo, e
      idempotência ao rodar duas vezes seguidas (sem auditoria duplicada).
- [x] Corrigida a documentação da Fase 5 que descrevia as tarefas como
      "agendadas" quando na verdade não tinham disparo automático real —
      ver nota adicionada lá.



## Fase 13 — Rate limiting (CONCLUÍDA, escopo real do que existe hoje)

Master prompt seção 108 exige rate limiting em login/ativação/reset/API
pública/webhook/mensagens — este projeto não tem ativação por código,
reset de senha, API pública nem webhooks ainda, então não havia o que
limitar nesses fluxos. Aplicado nos pontos reais de abuso que já existem.
Ver [`docs/RATE_LIMITING.md`](../../../../docs/RATE_LIMITING.md).

- [x] `src/helpers/rateLimit.tsx` — contador de janela fixa em memória, sem
      infraestrutura externa (documentado: correto só para processo único;
      upgrade natural para Redis se o deployment virar horizontal).
- [x] `server/index.ts` passou a injetar `x-client-ip-verified` a partir de
      `req.ip` do Express (nunca de um header client-controlado) antes de
      montar o Request de cada endpoint — sem isso, não havia como um
      endpoint saber o IP de quem chamou. `TRUST_PROXY` no `.env` para
      quando houver um proxy reverso de verdade na frente.
- [x] Aplicado em 5 pontos: login (20/15min por IP, além do bloqueio por
      e-mail que já existia), cadastro (10/hora por IP), criação de convite
      (20/hora por usuário — e-mail bombing), consulta pública de convite
      por token (30/hora por IP — maior superfície de força bruta do
      sistema), upload de arquivo (30/hora por usuário — abuso de
      armazenamento).
- [x] Testado com o app rodando de verdade: login continua funcionando
      normalmente para uso legítimo (não bloqueia por engano).
- [x] 10 testes novos (47→57): 4 unitários do helper (janela, isolamento
      por identificador, isolamento por bucket, expiração), e 6 de
      integração (login bloqueando por IP, login não afeta IP diferente,
      cadastro bloqueando por IP, convite bloqueando por usuário, consulta
      pública de convite bloqueando varredura de token, upload bloqueando
      por usuário).
- [ ] Sem rate limiting genérico em nível de Express para toda a API — só
      os pontos sensíveis específicos listados acima. Ver justificativa em
      `docs/RATE_LIMITING.md`.



## Fase 14 — RBAC granular por permissão (CONCLUÍDA, escopo real do que existe hoje)

Master prompt seção 10 pede permissões granulares nomeadas em vez de só
papel — antes desta fase, 18 endpoints checavam `membership.role` contra
uma lista de papéis repetida em cada arquivo, sem fonte única de verdade.
Ver [`docs/RBAC_PERMISSOES.md`](../../../../docs/RBAC_PERMISSOES.md).

- [x] `src/helpers/permissions.tsx` — catálogo de 18 permissões nomeadas
      (só as que correspondem a domínios reais deste sistema — não a lista
      completa da seção 10, que inclui `beneficiaries.*`/`donors.*`/
      `financial.*` inexistentes aqui) + mapeamento fixo papel→permissões.
- [x] `requirePermission(userId, organizationId, permission)` nova em
      `organizationAccess.tsx`, ao lado de `requireOrganizationMembership`
      (que perdeu o parâmetro `allowedRoles` — agora só checa membership,
      nunca papel diretamente).
- [x] Migrados os 18 endpoints que tinham lista de papéis solta:
      `allocations-decide`, `allocations-logistics` (POST),
      `allocations-receive`, `approval-requests-decide`, `approval-requests`
      (GET), `audit-log`, `files-upload`, `impact-report`,
      `inventory-items` (POST), `needs-status`, `needs` (POST),
      `opportunities-receive`, `opportunities-status`, `opportunities`
      (POST), `organization-invites-revoke`, `organization-invites` (GET e
      POST), `stock-transactions` (POST).
- [x] Migração não quebrou nenhum dos 57 testes existentes — mesmo
      comportamento observável (status HTTP e mensagem de erro idênticos),
      só a fonte da regra mudou de "lista solta no arquivo" para "catálogo
      único".
- [x] Testado com o app rodando de verdade: proprietária continua vendo a
      trilha de auditoria normalmente; operadora (papel sem
      `auditoria.leia`) recebe 403 com a mesma mensagem de antes ao tentar
      acessar `/_api/audit-log` diretamente.
- [x] 7 testes novos dedicados ao catálogo (`test/permissions.test.ts`):
      todo papel tem permissões, proprietario/administrador idênticos,
      proprietario tem tudo, voluntário só leitura, voluntário nunca tem
      permissão administrativa, operador tem operacional mas não
      administrativa, nenhum papel escreve sem poder ler o mesmo domínio.
- [ ] Sem customização de permissões por organização (mapeamento é global)
      nem interface de administração do catálogo — ver "o que ainda não
      existe" em `docs/RBAC_PERMISSOES.md`.



## Fase 15 — Versionamento de API (CONCLUÍDA)

Master prompt seção 86 pede API versionada `/api/v1/...`. Todos os 46
endpoints eram montados sem nenhum segmento de versão
(`/_api/<rota>`) — qualquer mudança incompatível de contrato quebraria
todo cliente sem aviso. Ver
[`docs/VERSIONAMENTO_API.md`](../../../../docs/VERSIONAMENTO_API.md) para
a decisão de manter o prefixo de transporte `_api` (herdado do Floot,
gerenciado só pelo proxy do Vite) e versionar com um segmento `v1`
logo depois, em vez de trocar `_api` por `api` (rename cosmético sem
relação com o que versionamento de contrato realmente resolve).

- [x] `server/index.ts` monta todas as rotas descobertas em
      `/_api/v1/<rota>` (`API_VERSION_PREFIX`). `/_api/__health` fica fora
      do versionamento de propósito (infraestrutura de monitoramento não
      deveria acompanhar versão de contrato).
- [x] Os 46 arquivos `*_GET.schema.ts`/`*_POST.schema.ts` atualizados de
      `/_api/<rota>` para `/_api/v1/<rota>`, incluindo as duas URLs
      internas guardadas no banco (`proof_url` em `allocations-receive_POST.ts`,
      `downloadUrl` em `files-upload_POST.ts`).
- [x] Cutover limpo, sem alias de compatibilidade — só este frontend
      consome a API hoje, não havia cliente terceiro para manter as duas
      rotas em paralelo. `GET /_api/needs` (sem versão) agora é 404 de
      propósito.
- [x] Testado com o app rodando de verdade: login, listagem de
      organizações e membros funcionando pelo fluxo real do cliente (não
      só chamada manual), confirmado via inspeção das requisições de rede
      batendo em `/_api/v1/...`.
- [x] 64 testes continuam passando sem alteração de comportamento — só 2
      asserções que verificavam a URL de download de arquivo literalmente
      precisaram ser atualizadas para incluir `/v1/`.
- [ ] Sem v2 nem mecanismo de coexistência de versões implementado — não
      há hoje nenhuma mudança de contrato pendente que precise disso (ver
      "como uma v2 conviveria com a v1" em `docs/VERSIONAMENTO_API.md`).



## Fase 16 — Documentação obrigatória (CONCLUÍDA)

Master prompt seção 142 exige 10 documentos (`ARCHITECTURE.md`,
`SECURITY.md`, `DEPLOYMENT.md`, `AI_AGENTS.md`, `WHATSAPP.md`,
`ACCESS_CODES.md`, `AUDIT.md`, `INCIDENT_RESPONSE.md`, `PRIVACY.md`,
`OPERATIONS.md`) — nenhum existia. Todos escritos em `docs/`, cada um
descrevendo o estado REAL do sistema, não a visão completa do master
prompt — quando algo pedido não existe, o documento diz isso
explicitamente em vez de omitir ou descrever como se existisse.

- [x] Os 10 documentos escritos, linkados no README numa seção
      "Documentação" nova.
- [x] Duas lacunas de segurança reais descobertas ao escrever a
      documentação (não corrigidas ainda, só documentadas com prioridade
      de correção registrada):
      1. **Auditoria sem hash encadeado** (`docs/AUDIT.md`) — `audit_log`
         é append-only via trigger de banco, mas não tem
         `event_hash`/`previous_event_hash` como a seção 12 do master
         prompt pede. Protege contra alteração via aplicação normal, não
         contra acesso direto privilegiado ao Postgres.
      2. **Organização "em_analise" opera normalmente** (`docs/ACCESS_CODES.md`) —
         o fluxo real de ativação é auto-cadastro + aprovação do admin de
         plataforma (não o código de ativação da seção 9 do master
         prompt), e nenhum endpoint de escrita checa
         `organizations.status`, só `memberships.status`. Uma organização
         pendente de aprovação já pode lançar estoque, convidar membros,
         etc.
- [x] Discrepância de configuração documentada (`docs/SECURITY.md`):
      cookie de sessão com `Max-Age` de 7 dias mas JWT interno assinado
      com expiração de 1 dia — a sessão expira em 1 dia na prática, não 7.
- [x] Confirmado por grep que cada endpoint/arquivo citado nos documentos
      existe de fato (nenhuma referência a algo que não existe).
- [x] ~~As duas lacunas de segurança descobertas (hash encadeado, status de
      organização)~~ — resolvidas na Fase 17 (ver abaixo). ~~A discrepância
      de expiração de sessão~~ também resolvida — ver Fase 18.



## Fase 17 — Correção das duas lacunas de segurança encontradas na Fase 16 (CONCLUÍDA)

### Hash encadeado da auditoria

Ver [`docs/AUDIT.md`](../../../../docs/AUDIT.md) (seção "Hash encadeado
(RESOLVIDO)").

- [x] `previous_event_hash`/`event_hash` adicionados a `audit_log`
      (`db/migrations/0003_audit_log_hash_chain.sql`) — cadeia única e
      global, calculada em `computeAuditEventHash`
      (`src/helpers/auditLog.tsx`), com advisory lock
      (`pg_advisory_xact_lock`) serializando escrita concorrente na cadeia.
- [x] `verifyAuditLogChain` (`src/helpers/verifyAuditChain.tsx`) percorre a
      tabela inteira e recalcula cada hash — exposto via
      `GET /_api/v1/audit-log-verify` (admin de plataforma, porque a
      cadeia é global).
- [x] **Bug real encontrado testando ao vivo contra o banco de
      desenvolvimento**: a primeira versão usava `JSON.stringify(metadata)`
      direto, mas o Postgres `jsonb` não garante preservar a ordem de
      inserção das chaves ao devolver o dado — a verificação acusava
      adulteração num evento que nunca tinha sido alterado. Corrigido com
      `stableStringify` (chaves ordenadas recursivamente antes de
      calcular o hash), nos dois lugares (escrita e verificação). Sem
      testar contra Postgres de verdade (só a lógica isolada), esse bug
      não teria aparecido — reforça por que `docs/TESTING.md` insiste em
      testes de integração com banco real, não mocado.
- [x] 8 testes (`test/auditChain.test.ts`): cadeia referencia o evento
      anterior corretamente, `computeAuditEventHash` determinístico e
      sensível a cada campo, insensível à ordem de chaves de `metadata`,
      verificação confirma integridade (caso normal e caso com metadata de
      múltiplas chaves lida de volta do banco — reproduz o bug real),
      detecta adulteração (linha forjada via INSERT direto, já que UPDATE é
      bloqueado pelo trigger), e trata linhas pré-migração (sem hash) como
      início de nova cadeia, não como corrupção.

### Organização "em_analise" operando normalmente

Ver [`docs/ACCESS_CODES.md`](../../../../docs/ACCESS_CODES.md) (seção
"Risco de segurança da lacuna (RESOLVIDO)").

- [x] `requirePermission` (`src/helpers/organizationAccess.tsx`) agora
      também exige `organizations.status === 'ativa'`, além de membership
      ativo e a permissão nomeada — bloqueia as 18 ações restritas por
      permissão (ver Fase 14) enquanto a organização não for aprovada.
- [x] Decisão de escopo: a checagem fica só em `requirePermission`, não em
      `requireOrganizationMembership` — leitura continua liberada para o
      dono acompanhar a própria organização "em análise"; só ação de
      escrita restrita por permissão é bloqueada.
- [x] Testado com o app rodando de verdade: tentativa de lançar estoque
      numa organização "em_analise" bloqueada com a mensagem nova; após
      aprovar via `platform-organizations-status`, a mesma ação passou a
      funcionar.
- [x] 4 testes (`test/organizationStatusGate.test.ts`): bloqueia ação
      restrita com organização "em_analise"/"suspensa", libera assim que
      aprovada, leitura (`requireOrganizationMembership`) não afetada em
      nenhum dos dois casos.
- [x] Nenhum dos 76 testes existentes quebrou — o helper de teste já cria
      organização com status "ativa" por padrão, então todo teste anterior
      já operava no caminho "aprovada".



## Fase 18 — Discrepância de expiração de sessão (CONCLUÍDA)

Ver `docs/SECURITY.md`. `setServerSession` (`src/helpers/getSetServerSession.tsx`)
assinava o JWT interno com `setExpirationTime("1d")` fixo, enquanto o
cookie declarava `Max-Age=604800` (7 dias, `SessionExpirationSeconds`) — a
sessão real expirava em 1 dia, porque a verificação do JWT falha antes do
cookie sequer ter passado do prazo dele.

- [x] Trocado para `setExpirationTime(Math.floor(Date.now() / 1000) + SessionExpirationSeconds)`
      — usa a mesma constante do `Max-Age`, então os dois nunca podem
      divergir de novo por definição (uma mudança futura em
      `SessionExpirationSeconds` já propaga para os dois lugares).
- [x] Confirmado contra o servidor real rodando: JWT emitido por um login
      de verdade, `exp - iat` = exatos 604800 segundos.
- [x] 1 teste novo (`test/auth.test.ts`): decodifica o JWT do cookie
      emitido no cadastro e confirma `exp - iat` = 604800s (com margem de
      5s só para o tempo de execução do teste, não para mascarar uma
      regressão de verdade — 1 dia = 86400s, bem longe da margem).
- [ ] `sessions.expires_at` (coluna no banco) continua sem ser lida em
      lugar nenhum — a expiração de verdade é 100% governada pelo `exp` do
      JWT e pela limpeza oportunista por `last_accessed` antigo
      (`getServerUserSession.tsx`). Não é uma falha de segurança (a sessão
      expira corretamente por outro caminho), só uma coluna morta — fora do
      escopo desta correção, registrada para limpeza futura.



## Fase 19 — Exclusão de conta / LGPD (CONCLUÍDA)

Master prompt seção 54 e LGPD art. 18 (direito de eliminação) — lacuna
identificada na Fase 16 (`docs/PRIVACY.md` já apontava isso como pendente).
Ver [`docs/PRIVACY.md`](../../../../docs/PRIVACY.md) ("Retenção e exclusão").

- [x] `POST /_api/v1/auth/account-delete` — exige confirmação de senha
      (reautenticação antes de ação destrutiva). Nunca apaga a linha de
      `users` (quebraria FK de `actor_user_id` em audit_log/etc.,
      append-only) — anonimiza email/nome, apaga senha e todas as sessões,
      inativa todas as memberships. A exclusão em si vira evento de
      auditoria, gravado antes de anonimizar.
- [x] Regra de proteção: recusa (409) se a pessoa for a única proprietária
      ativa de alguma organização — evita organização órfã, já que não
      existe fluxo de transferência de titularidade ainda.
- [x] Interface: opção "Excluir minha conta" no menu do usuário
      (`src/pages/_index.tsx`), com diálogo de confirmação por senha e
      aviso claro do que acontece com o histórico de auditoria.
- [x] Testado com o app rodando de verdade: bloqueio real (proprietária
      única de "Casa de Apoio Esperança", 409 com mensagem correta) e
      fluxo de sucesso real (conta descartável registrada, excluída,
      login subsequente com a mesma senha falha).
- [x] Corrigido um erro de concordância na mensagem de erro descoberto ao
      testar ao vivo ("único proprietário de a organização" → "da
      organização"/"destas organizações", usando a mesma construção `d${...}`
      para os dois plurais).
- [x] 5 testes (`test/accountDelete.test.ts`): anonimização completa,
      senha errada não altera nada, bloqueio por organização órfã,
      liberação com outro proprietário ativo, proprietário inativo não
      conta como "outro proprietário".



## Fase 20 — Revisão de código completa da sessão + CI (CONCLUÍDA)

Depois da Fase 19, uma revisão de código de ponta a ponta de tudo o que foi
implementado nesta sessão (linha a linha, comportamento removido,
rastreamento entre arquivos, reuso, simplificação, eficiência e
convenções) encontrou 10 problemas reais, dos quais 2 eram bugs de
correção de verdade:

- [x] **Bug de correção 1**: `approval-requests-decide_POST.ts` aplicava a
      revalidação de saldo (para aprovação de ajuste de estoque de alto
      risco) DEPOIS de já ter atualizado `approval_requests.status` para
      "aprovada" dentro da mesma transação — como um `return` comum não
      desfaz nada já escrito (só uma exceção lançada faz rollback), um
      saldo insuficiente detectado nesse ponto deixaria o pedido preso em
      "aprovada" para sempre, sem a ação real ter acontecido. Corrigido
      validando tudo antes de qualquer mutação.
- [x] **Bug de correção 2**: `needs-status_POST.ts` exigia só
      `necessidades.gerencie` para marcar uma necessidade como "atendida",
      mesmo quando isso dispara baixa automática de estoque — uma mutação
      de estoque de verdade sem exigir `inventario.lance`. Corrigido
      exigindo as duas permissões explicitamente nesse caso.
- [x] Os outros 8 achados (reuso/simplificação/eficiência/altitude), todos
      corrigidos: `TASK_HANDLERS` duplicado (unificado em
      `src/helpers/taskHandlers.tsx`), cálculo de saldo de estoque
      duplicado em 6 endpoints (unificado em
      `src/helpers/stockBalance.tsx`), expiração de convite duplicada e
      sem auditoria (unificada em `src/helpers/organizationInvites.tsx`,
      agora com evento `organizacao.convite_expirado_automaticamente`),
      uma transação por item nas 3 varreduras de expiração agendadas
      (agora uma transação por varredura), mapeamento erro→HTTP duplicado
      em ~41 endpoints por comparação frágil de texto (unificado em
      `src/helpers/errorResponse.tsx`, usando `instanceof`), e N+1 de
      consulta em `account-delete_POST.ts` (substituído por uma única
      query com `NOT EXISTS` correlacionado).
- [x] Avaliada e **descartada** a sugestão de encurtar o escopo do
      advisory lock global da cadeia de hash de auditoria
      (`src/helpers/auditLog.tsx`) trocando para lock de sessão com
      unlock explícito antes do commit — isso quebraria a garantia de
      ordenação da cadeia sob concorrência (duas transações poderiam
      commitar apontando para o mesmo "hash anterior", uma bifurcação
      silenciosa). Documentado em código o motivo, e aplicada só a
      redução de escopo genuinamente segura (reordenar as duas gravações
      de auditoria de `needs-status_POST.ts` para o fim da transação).
- [x] Repositório publicado no GitHub como privado
      (`jlsheik/levora-solidaria`) — primeiro push do histórico do
      projeto para um remoto.
- [x] ~~Sem pipeline de CI~~ — resolvido: `.github/workflows/ci.yml` roda
      `npm run typecheck` e `npm test` a cada push/PR na `master`, com
      Postgres real como serviço do job (nunca mock) e segredos só de CI.
      Simulado localmente antes do push (mesmos comandos, só variáveis de
      ambiente, sem `.env.test`) para confirmar que passaria antes de
      depender do primeiro run real no GitHub.



## Fase 21 — Auditoria de segurança/integridade dirigida (idempotência, SQLi, CSRF, XSS, códigos de acesso) (CONCLUÍDA — escopo desta etapa)

Pedido explícito: investigar antes de alterar, fechar testes de
segurança/integridade descobertos, preparar a modelagem de matching sem
implementá-la ainda. Auditoria feita com 4 investigações paralelas
(sessão/CSRF, idempotência/matching, convites+SQLi, XSS+schema) antes de
qualquer mudança de código — ver relatório completo entregue ao
proprietário no chat desta sessão.

### Achados e correções reais (bugs, não apenas testes)
- [x] **Corrida em `claimTaskRun`**: chamadas concorrentes com a mesma
      `idempotencyKey` podiam gerar uma exceção de violação de unicidade
      não tratada em vez de `claimed: false`. Corrigido em
      `src/helpers/backgroundTasks.tsx` — ver `docs/OPERATIONS.md`.
- [x] **Injeção de cabeçalho HTTP via nome de arquivo**: `fileName` não
      restringia caracteres de controle, e só a aspa dupla era removida no
      `Content-Disposition` do download. Corrigido nas duas camadas
      (schema de upload + defesa em profundidade no download) — ver
      `docs/UPLOAD_DE_ARQUIVOS.md`.
- [x] **`idempotencyKey` é capacidade não usada** por nenhum chamador real
      (as 4 tarefas agendadas não passam essa chave) — documentado, não
      "corrigido" silenciosamente, porque decidir a granularidade de
      deduplicação por chave de negócio é uma escolha de produto, não um
      bug. A proteção real contra duplicação hoje vem das cláusulas
      `WHERE status = ...` de cada tarefa, já testada.

### Testes novos (35 testes, de 87 para 122 no total desta sessão)
- [x] `test/idempotency.test.ts` (10 testes): `claimTaskRun` sequencial,
      concorrente (prova da correção da corrida), reprocessamento de
      falha respeitando `maxAttempts`, chaves isoladas entre si;
      `runMatchingForOpportunity` chamado duas vezes (alta confiança →
      2ª chamada ignorada por status; confiança média com quantidade
      restante → 2ª chamada não duplica alocação para a mesma
      organização via `existingOrgIds`; quantidade já totalmente
      atribuída → ignorada); `expireOpportunities` e `expireReservations`
      chamados duas vezes sem duplicar auditoria (mesma cobertura que já
      existia só para `expireApprovalRequests`).
- [x] `test/securityHardening.test.ts` (13 testes): SQL injection (bypass
      de login por tautologia — rejeitado por validação e por não
      encontrar sessão; nome de organização com metacaracteres gravado
      como dado literal, sem afetar outras organizações), XSS armazenado
      (título/descrição de necessidade, motivo de estoque, nome de
      organização — payloads gravados e devolvidos literalmente, nunca
      executados ou mangled pela API), CSRF (corpo não-superjson,
      equivalente ao que um `<form>` cross-site produziria, rejeitado
      antes de qualquer efeito), ciclo de vida de convites (reaceitar
      convite já aceito → 410, sem segunda membership; convite revogado
      não reativa mesmo com tentativas repetidas), e status de
      organização (só admin de plataforma altera; proprietário da própria
      organização e outsider são bloqueados; sem sessão é 401) — este
      último endpoint (`platform-organizations-status_POST`) não tinha
      NENHUM teste antes desta fase.
- [x] `test/filesUpload.test.ts` (+2 testes): rejeita nome de arquivo com
      CRLF; defesa em profundidade confirma que mesmo uma linha já gravada
      com nome malicioso nunca produz um `Content-Disposition` adulterado.
- [x] `test/auth.test.ts` (+1 teste): trava os atributos do cookie de
      sessão (`HttpOnly`/`Secure`/`SameSite=Lax`) como regressão da base
      da análise de CSRF.

### Não coberto nesta fase (por decisão, não por esquecimento)
- [ ] CSRF/XSS "de verdade" via navegador real (Playwright/Cypress) — os
      testes aqui provam as propriedades do backend que tornam o ataque
      inviável (parsing de corpo, escaping do React confirmado por leitura
      de código), não simulam um navegador de verdade fazendo a requisição
      cross-site. Ver relatório entregue ao proprietário para a
      justificativa completa.
- [ ] Modelagem de capacidade/raio de atendimento para o matching (Fase 7
      do pedido) — investigada (ver achado abaixo), mas **não
      implementada**: é uma decisão de arquitetura que exige escolha
      humana (unidade de capacidade, granularidade de localização),
      apresentada ao proprietário sem decisão silenciosa.
- [x] **Achado importante para quando a Fase 7 for decidida**:
      `src/helpers/opportunityMatching.tsx` já tem 4 critérios placeholder
      inertes (`capacidade_armazenamento`, `capacidade_logistica`,
      `raio_atendimento`, `horarios_restricoes`, todos com `weight: 0`) —
      o algoritmo já foi desenhado esperando exatamente esses campos, só
      faltam existir no schema de `organizations` e serem preenchidos.



## Fase 22 — Modelagem de dados para matching automático (capacidade, logística, área de atendimento) (CONCLUÍDA)

Decisão de arquitetura apresentada e aprovada explicitamente pelo
proprietário antes de qualquer migration (relatório completo entregue no
chat desta sessão) — as 6 decisões abertas foram todas aprovadas com a
opção recomendada: capacidade por categoria (não total única); tabela
nova `organization_matching_settings` separada em vez de alterar
`organizations`; nova permissão `organizacao.gerencie`; área de
atendimento como cidade/estado texto livre (sem tabela de municípios
normalizada); "capacidade disponível" sempre calculada, nunca armazenada;
`observacoes_horarios` incluída desde já.

- [x] `db/migrations/0004_organization_matching_config.sql` (e
      `db/schema.sql` correspondente) — 3 tabelas novas:
      `organization_capacities` (teto declarado por categoria+unidade,
      nunca um contador automático — "disponível" é sempre calculado como
      `max_capacity − saldo atual em stock_transactions/inventory_items`
      da mesma categoria, para não duplicar a fonte de verdade que já
      existe), `organization_matching_settings` (1:1, logística +
      horários — `realiza_coleta`, `raio_coleta_km` opcional e só
      informativo por enquanto, `observacoes_logisticas`,
      `observacoes_horarios`), `organization_service_areas` (municípios
      atendidos além da sede, cidade/estado texto livre com unique
      case-insensitive).
- [x] Tipos Kysely adicionados a `src/helpers/schema.tsx`
      (`OrganizationCapacities`, `OrganizationMatchingSettings`,
      `OrganizationServiceAreas`).
- [x] Nova permissão `organizacao.gerencie` (só
      proprietário/administrador) em `src/helpers/permissions.tsx` — ver
      `docs/RBAC_PERMISSOES.md`. Leitura (`organization-matching-config_GET`)
      é aberta a qualquer membro ativo, sem permissão nomeada — dado
      institucional, não sensível.
- [x] 6 endpoints: `organization-matching-config_GET` (leitura
      consolidada), `organization-capacities_POST` (upsert por
      categoria+unidade), `organization-capacities-delete_POST`,
      `organization-matching-settings_POST` (upsert 1:1),
      `organization-service-areas_POST` (bloqueia duplicata
      case-insensitive com 409), `organization-service-areas-delete_POST`.
      Todos com auditoria (`organizacao.capacidade_alterada/removida`,
      `organizacao.configuracao_logistica_alterada`,
      `organizacao.area_atendimento_alterada`) e isolamento multi-tenant
      testado explicitamente (não é possível ler/alterar/remover dado de
      outra organização, mesmo informando o ID certo).
- [x] 18 testes novos (`test/organizationMatchingConfig.test.ts`) + 1
      teste de RBAC (`test/permissions.test.ts`) — 123→141 no total desta
      sessão.
- [x] **Algoritmo ligado aos dados novos** (`src/helpers/opportunityMatching.tsx`,
      `ALGORITHM_VERSION` 1.0→1.1): `capacidade_armazenamento` (score
      calculado contra `max_capacity − uso real em
      stock_transactions/inventory_items` da mesma categoria, nunca um
      contador à parte), `capacidade_logistica` (binário: realiza coleta
      ou não), `raio_atendimento` (áreas declaradas, separado de
      `proximidade` que continua olhando só a sede — decisão aprovada
      explicitamente: manter os dois critérios). `horarios_restricoes`
      continua `"nao_aplicavel"` — texto livre não vira pontuação sem uma
      estrutura própria.
- [x] **Pesos redistribuídos com aprovação explícita** (categoria 0.30→0.20,
      urgência 0.20→0.15, quantidade 0.20→0.15, proximidade 0.30→0.15,
      + raio_atendimento 0.15, capacidade_armazenamento 0.15, capacidade_logistica
      0.05 — soma 1.00) e **`finalScore` agora é a média ponderada só dos
      critérios aplicáveis a cada candidato específico** (renormalizado
      pela soma dos pesos com dado disponível), não mais uma soma fixa
      assumindo pesos somando 1.00. Decisão crítica aprovada explicitamente
      antes de implementar: sem essa renormalização, NENHUMA organização
      (100% delas ainda não haviam configurado nada) conseguiria mais
      atingir os limiares de confiança média/alta, travando o matching
      automático em produção até todo mundo preencher a configuração nova.
      Confirmado por teste: `test/opportunityMatching.test.ts` e
      `test/idempotency.test.ts` (que já existiam, com organizações sem
      nenhuma configuração nova) continuam passando sem alteração —
      comportamento antigo preservado.
- [x] 5 testes novos (`test/opportunityMatchingCapacity.test.ts`, 141→146):
      sem configuração os 3 critérios ficam `null` (não entram no
      cálculo); capacidade com folga = 100, esgotada = 0; logística
      true/false = 100/0; área de atendimento mesma cidade/mesmo
      estado/nenhuma = 100/60/20; configurar tudo favoravelmente eleva uma
      oportunidade de confiança média para atribuição automática de alta
      confiança.
- [x] **Achado documentado, não um bug introduzido agora**: o
      `FlootCamelCasePlugin` (`src/helpers/db.tsx`) transforma
      recursivamente as chaves de QUALQUER objeto numa linha lida via
      Kysely, inclusive as de dentro de uma coluna JSONB —
      `match_evaluations.criteria` grava `"capacidade_armazenamento"` mas
      volta como `"capacidadeArmazenamento"` depois de um SELECT. Já era
      assim antes desta sessão; documentado em comentário no código e no
      teste, porque foi a primeira vez que algo leu uma chave específica
      de `criteria` programaticamente.
- [ ] **UI ainda não construída** — tela de configuração
      (`organizacoes.$organizationId.tsx`, nova aba) para capacidade/área
      de atendimento/logística fica para uma próxima etapa; hoje só é
      possível configurar via API diretamente.

## Fase 23 — Auditoria adversarial do motor de matching + correção dos achados + UI de Configurações de Matching (CONCLUÍDA)

Auditoria técnica completa da Fase 22 pedida explicitamente antes de
construir a UI (relatório entregue no chat) — encontrou 2 achados reais
(🔴 unidade nunca verificada em `capacidade_armazenamento`, incluindo
agregação de estoque misturando unidades incompatíveis; 🟡 `raio_atendimento`
comparava só cidade, sem exigir o mesmo estado) e 2 achados menores
(`normalize()` sem `.trim()`; cobertura de teste insuficiente). Todos os 5
corrigidos com aprovação explícita, escopo mantido (nenhum peso/threshold
alterado).

### Correções no motor
- [x] `capacidade_armazenamento` agora exige categoria **e** unidade
      compatíveis (`normalize(cap.unit) === normalize(opportunity.unit)`)
      antes de comparar números — categoria batendo com unidade diferente
      vira `"não aplicável"`, nunca um score inventado.
- [x] Agregação de uso de estoque agora agrupa por
      `(organizationId, category, unit)`, não só `(organizationId, category)`
      — "Alimentos/kg" e "Alimentos/unidade" da mesma organização nunca se
      somam.
- [x] `raio_atendimento` agora exige cidade **e** estado juntos para o
      score 100 — cidades homônimas em UFs diferentes (existem de verdade
      no Brasil) nunca contam como a mesma localidade.
- [x] `normalize()` ganhou `.trim()` — espaços extras não quebram mais a
      comparação de categoria/cidade/estado.
- [x] `opportunity_registry.quantity` — achado residual da auditoria
      anterior, investigado e fechado: nenhum caminho hoje conseguia
      gravar zero (Zod `.positive()` já protegia), mas faltava a mesma
      constraint de banco que `needs.quantity_needed` e
      `opportunity_allocations.quantity_allocated` já tinham.
      `db/migrations/0005_opportunity_registry_quantity_check.sql`
      adiciona `CHECK (quantity IS NULL OR quantity > 0)`. Testado
      diretamente contra o banco (INSERT bypassando a validação da
      aplicação).
- [x] 23 testes novos em `test/opportunityMatchingCapacity.test.ts`
      (reescrito, 20→23 com os testes de `quantity`) cobrindo os 9
      cenários de capacidade pedidos (suficiente, exata, insuficiente,
      consumo parcial usando disponível real — não o bruto, categoria
      diferente, unidade diferente [teste bloqueador], capacidade zero,
      mistura de unidades bloqueada, parcialmente insuficiente), 7 de área
      de atendimento (cidade+UF, homônimo bloqueado, mesmo estado,
      capitalização/acento, espaços extras, sem área, cidade/estado sem
      relação), e um teste de isolamento multi-tenant do MOTOR de matching
      (não só dos endpoints CRUD) com duas organizações reais.
- [x] Suíte completa: 146→164 testes, todos passando, nenhuma regressão.

### UI — Configurações de Matching
- [x] Nova aba `/organizacoes/:id/matching`
      (`organizacoes.$organizationId.matching.tsx` +
      `.module.css` + `.pageLayout.tsx`), seguindo exatamente o padrão
      visual/arquitetural já existente (mesmo layout de nav por link
      duplicado em cada página, `Form`/`Dialog`/`Switch`/`Skeleton` já
      existentes, React Query com a mesma convenção de
      `queryKey`/`invalidateQueries`, `sonner` para toast) — link
      adicionado nas 6 páginas de aba existentes.
- [x] 3 blocos: capacidade de armazenamento (criar/editar/excluir, com
      categoria+unidade travadas na edição — só o teto é editável, nunca
      estoque/disponível), capacidade logística (`Switch` sim/não,
      "ainda não configurado" tratado como estado distinto de "não",
      nunca enviando `false` sozinho), áreas de atendimento
      (adicionar/remover cidade+UF, com texto explicando que a sede já é
      considerada à parte).
- [x] RBAC: reaproveita `organizacao.gerencie` (nenhuma permissão nova) —
      leitura aberta a qualquer membro, botões de mutação escondidos
      (não só desabilitados) para quem não tem o papel, com banner
      explicando por quê. Testado ao vivo no navegador com um segundo
      usuário `voluntario` real.
- [x] Multi-tenancy: `organizationId` vem exclusivamente da URL
      (`useParams`), nunca de um campo editável — mesmo padrão de toda
      página de organização existente.
- [x] Responsivo: testado ao vivo em viewport mobile (375×812) — nav
      quebra em linhas, cards empilham, nenhum conteúdo cortado (um
      placeholder longo demais foi encontrado cortado no teste ao vivo e
      movido para texto de ajuda abaixo do campo).
- [x] Testado ao vivo, ponta a ponta, no navegador: criar organização →
      aprovada por admin de plataforma → criar capacidade → editar
      capacidade → adicionar área de atendimento → configurar logística →
      confirmar exclusão → conferir os 4 eventos de auditoria gerados
      (nenhuma auditoria paralela no frontend, tudo passou pelos
      endpoints já existentes).
- [ ] Nenhum novo endpoint, migration (além do CHECK de `quantity`),
      permissão ou tabela foi criado além do estritamente necessário —
      confirmado explicitamente no relatório desta fase.

## Fase 24 — Correção cirúrgica pós-auditoria final: proximidade cidade+UF e desempate determinístico (CONCLUÍDA)

Auditoria final do motor (fase à parte, só leitura, sem alterar código)
concluiu **APTO COM CORREÇÕES**, com exatamente 2 achados médios reais —
nenhum crítico/alto. Corrigidos aqui, cirurgicamente, sem tocar em
pesos/thresholds/fórmula/outros critérios:

- [x] `proximidade` (sede) agora exige cidade **e** UF juntos para o score
      100 — mesma correção já aplicada em `raio_atendimento` na Fase 23,
      agora estendida ao critério irmão que ainda tinha a mesma
      fragilidade (cidade homônima em UF diferente, ex. "Bom Jesus/MG" vs
      "Bom Jesus/PI", pontuava 100 indevidamente).
- [x] Desempate determinístico quando dois ou mais candidatos têm
      `finalScore` idêntico: antes, a ordem entre empatados dependia da
      ordem incidental do Postgres (a query de candidatos não tem
      `ORDER BY`) — agora `organizationId` (identificador técnico
      estável, a própria FK persistida em `match_evaluations`) desempata,
      com `needId` como resíduo para o caso teórico de duas necessidades
      da mesma organização empatando entre si. Aplicado só depois do
      `finalScore` já calculado — nunca é um critério de prioridade
      subjetiva, nunca altera o score.
- [x] 10 testes novos (`test/opportunityMatchingProximityAndTiebreak.test.ts`,
      164→174): os 8 cenários de proximidade pedidos (incluindo o caso
      obrigatório de homônimo em UF diferente) e os 6 cenários de
      desempate (scores diferentes mantêm ordem por score; empate exato
      decidido só por `organizationId`; reprodutibilidade entre cenários
      equivalentes; score nunca alterado pelo desempate; sem vazamento de
      dado entre organizações empatadas; 4 organizações empatadas ao
      mesmo tempo).
- [x] Suíte completa (174 testes) e typecheck confirmados sem regressão.
      Diff conferido — só as duas correções pedidas, nada mais.
- [ ] `raio_atendimento` (área declarada) redundante com `proximidade`
      quando a sede também é listada como área adicional (double count) —
      **não corrigido nesta etapa, por instrução explícita**, fica
      registrado como decisão de modelagem pendente para uma etapa
      própria.

## Fase 25 — Correção de versionamento do motor: `ALGORITHM_VERSION` 1.1→1.2 (CONCLUÍDA)

Auditoria dedicada (só leitura, sem alterar código) sobre a semântica de
`ALGORITHM_VERSION` concluiu **VERSIONAMENTO PRECISA SER CORRIGIDO**: o
histórico do git mostrou que a Fase 23 (`ed45102`, correção de unidade em
capacidade e cidade+UF em área de atendimento) e a Fase 24 (`cdfa0de`,
proximidade cidade+UF e desempate determinístico) alteraram resultado real
do motor para as mesmas entradas, sem bump de versão — quebrando a mesma
convenção que a Fase 22 (`a07d2cc`) havia seguido ao introduzir capacidade/
logística/área (bump `1.0→1.1`). Correção mínima e controlada aplicada
aqui, só de rastreabilidade, sem tocar em nenhuma lógica do motor:

- [x] `ALGORITHM_VERSION` alterada de `"1.1"` para `"1.2"` em
      `src/helpers/opportunityMatching.tsx` (única fonte de verdade —
      `match_evaluations.algorithm_version`, `opportunity_allocations.notes`
      e `audit_log.metadata.algoritmo` continuam consumindo a mesma
      constante, nenhum tem literal próprio).
- [x] Nenhum registro histórico foi alterado. `match_evaluations` gravadas
      como `"1.1"` continuam exatamente como foram gravadas — sem `UPDATE`,
      sem migração de dados, sem "correção" retroativa. Ver
      `docs/AI_AGENTS.md` (seção "Regra de versionamento") para a
      documentação explícita de que "1.1" já cobre pelo menos 3 eras
      comportamentais distintas e uma investigação histórica precisa
      correlacionar `created_at` com o commit vigente na época.
- [x] Regra de versionamento documentada em `docs/AI_AGENTS.md`:
      `algorithm_version` representa o comportamento completo do motor, não
      só a fórmula — qualquer mudança capaz de alterar decisão/alocação
      final exige nova versão (critério, regra de cálculo, peso, fórmula,
      threshold, elegibilidade, desempate); mudança puramente interna não
      exige.
- [x] Teste de regressão novo
      (`test/opportunityMatchingAlgorithmVersion.test.ts`, 174→177):
      executa o motor de ponta a ponta (não só lê a constante em memória) e
      confirma que a avaliação persistida em `match_evaluations` grava
      `"1.2"`, tanto no caminho de descarte quanto no de alocação
      automática, e que `opportunity_allocations.notes` e
      `audit_log.metadata.algoritmo` refletem `"1.2"` automaticamente por
      dependerem da mesma constante.
- [x] Suíte completa (177 testes) e typecheck confirmados sem regressão.
      Diff conferido — só a constante, o teste novo e a documentação; nada
      de peso/threshold/fórmula/critério/capacidade/proximidade/desempate/
      concorrência/reserva/expiração/alocação/multi-tenancy/UI/endpoint/
      schema foi tocado.

## Fase 26 — Auditoria E2E do ciclo operacional + correção dos 2 achados médios: advisory lock do agendador e `ALGORITHM_VERSION` 1.2→1.3 (CONCLUÍDA)

Depois do motor aprovado na auditoria definitiva (Fase 24) e do
versionamento corrigido para "1.2" (Fase 25), uma auditoria E2E do ciclo
operacional completo (oportunidade → matching → proposta/reserva →
expiração → reabertura → novo matching → alocação final → auditoria),
com simulações reais (incluindo concorrência real via `Promise.all`, não
só leitura de código), concluiu **CICLO E2E APTO COM LACUNAS**: nenhum
achado crítico/alto, 2 achados médios. Uma investigação arquitetural
dedicada (também só leitura) analisou os dois antes de decidir a correção.
Implementado aqui, cirurgicamente, sem tocar em pesos/fórmula/thresholds/
critérios/capacidade/proximidade/desempate/quantidade alocada/reserva de
30min/expiração/multi-tenancy:

**Achado 1 — sobreposição de execuções da mesma tarefa agendada**:
`claimTaskRun` não protegia contra isso porque as 4 tarefas
(`expireReservations`, `expireOpportunities`, `expireApprovalRequests`,
`runMatchingSweep`) chamam `claimTaskRun({ taskName })` sem
`idempotencyKey` (já documentado como decisão consciente na Fase 21,
`docs/OPERATIONS.md`) — nunca corrompia dado de negócio (as cláusulas
`WHERE status = ...` de cada tarefa já protegiam isso, testado), mas
gerava histórico redundante em `background_task_runs` e trabalho
duplicado.

- [x] `src/helpers/scheduledTaskLock.tsx` (novo): `withScheduledTaskLock(taskName, fn)`,
      camada adicional por cima de `claimTaskRun` (não alterado, mesma
      semântica de sempre). Usa `pg_try_advisory_lock`/`pg_advisory_unlock`
      de **sessão** — não de transação, porque as tarefas fazem várias
      transações soltas, não uma única `db.transaction()` do início ao
      fim (decisão explícita: não mudar a granularidade transacional).
      Uma conexão dedicada (`sql.reserve()`, exposta por
      `reserveDedicatedConnection()` em `src/helpers/db.tsx`) é mantida
      aberta durante toda a execução — devolver a conexão ao pool antes de
      soltar o lock manteria o lock preso naquela conexão física para
      sempre. Protege mesmo uma execução mais lenta que o próprio
      intervalo do cron, porque não depende de janela/tick, só de o lock
      estar preso ou não.
- [x] `classid` fixo (`842013`) + `objid` estável por tarefa, mapeados
      explicitamente (`SCHEDULED_TASK_LOCK_IDS`) — nunca hash
      probabilístico. Forma de duas chaves nunca conflita com a forma de
      uma chave só usada pela cadeia de auditoria
      (`pg_advisory_xact_lock(hashtext(...))` em
      `src/helpers/auditLog.tsx`) — os dois mecanismos nunca podem
      colidir, mesmo por acaso.
- [x] Aplicado às 4 chamadas reais (`expireReservations.tsx`,
      `expireOpportunities.tsx`, `expireApprovalRequests.tsx`,
      `runMatchingSweep.tsx`) — o corpo original de cada uma foi só movido
      para uma função interna (`runExpireReservations` etc.), chamada de
      dentro do lock; nada do corpo mudou. Protege igualmente o
      reprocessamento manual (`POST background-tasks-retry`), que chama
      exatamente as mesmas funções.
- [x] Se o processo morrer no meio, o Postgres libera o lock de sessão
      automaticamente quando a conexão cai — sem lock órfão. Se a tarefa
      lança exceção, o lock é liberado no `finally` antes de propagar.
- [x] `test/scheduledTaskLock.test.ts` (6 testes, sem sleeps reais —
      controle via promessas resolvidas manualmente): duas chamadas
      concorrentes da mesma tarefa (uma recusada); execução posterior
      normal após liberar; lock liberado mesmo após falha; tarefa
      diferente não bloqueada; execução "longa" continua protegida
      indefinidamente até liberar; `taskName` sem mapeamento lança erro
      explícito.
- [x] `docs/OPERATIONS.md` e `docs/DEPLOYMENT.md` atualizados — o achado
      "múltiplas instâncias fariam trabalho redundante" também fica
      resolvido de graça: o lock é do Postgres (global ao servidor de
      banco), não por processo.

**Achado 2 — candidatos elegíveis desaparecendo do rastro quando
`remaining` chega a zero**: o motor já avalia e pontua TODOS os candidatos
com correspondência de categoria antes de decidir alocações; o `break` no
topo do loop de alocação, ao ver `remaining <= 0`, parava o loop inteiro —
candidatos seguintes (mesmo com score alto, já calculado) nunca eram
persistidos em `match_evaluations`, indistinguível de "nunca foi
candidato". Investigação confirmou, com evidência documental
(`status-fase5.md`, `docs/AI_AGENTS.md`, `match-evaluations_GET.ts` sem
filtro por `decision`), que a intenção sempre foi Modelo B
("match_evaluations representa todos os candidatos elegíveis
considerados"), e que `decision` é `TEXT` livre sem enum — um valor novo
não exige migration.

- [x] `remaining <= 0` deixou de ser um `break` do loop inteiro: agora,
      só para o candidato atual, se ele já era estruturalmente elegível
      (`finalScore >= MEDIUM_CONFIDENCE_THRESHOLD`) mas não resta
      quantidade, persiste `match_evaluations` com
      `decision = "elegivel_sem_quantidade"` (nunca "descartado" — o
      candidato não foi reprovado pelo score) e `continue` para o
      próximo. Nenhuma `opportunity_allocations` é criada para esse caso.
      Candidatos com score abaixo do threshold continuam "descartado",
      independente de `remaining` — comportamento inalterado. O cap
      separado `unboundedProcessed >= 3` (oportunidades sem quantidade
      conhecida) não foi tocado — achado e correção só cobrem o caso de
      quantidade conhecida e esgotada.
- [x] `ALGORITHM_VERSION` alterada de `"1.2"` para `"1.3"` — mudança de
      comportamento observável (completude do rastro de auditoria), não
      de score/peso/fórmula/threshold. Ver `docs/AI_AGENTS.md`, "Regra de
      versionamento", para a explicação completa e a confirmação de que
      1.0/1.1/1.2 não foram e não serão reescritos.
- [x] UI (`plataforma.tsx`) inspecionada e **não alterada** — o badge já
      mostra o texto literal de `ev.decision`, então `"elegivel_sem_quantidade"`
      aparece de forma autoexplicativa sem qualquer mudança de código
      (só cai no `variant="secondary"` padrão, mesmo de "descartado").
- [x] `test/opportunityMatchingElegivelSemQuantidade.test.ts` (4 testes):
      quantidade esgota no 1º candidato, 2º (score alto, >=90) fica
      `elegivel_sem_quantidade` sem alocação, com score real persistido
      (nunca 0/null); 3 candidatos empatados depois do esgotamento, todos
      logados; contagem de alocações não aumenta; fluxos antigos
      (`<70`/`70-89,99`/`>=90`, todos com quantidade disponível) intactos.
- [x] `test/opportunityMatchingAlgorithmVersion.test.ts` atualizado de
      `"1.2"` para `"1.3"` (constante atual — não é reescrita de
      histórico, é o teste de regressão do comportamento vigente).
- [x] Suíte completa (177→187 testes) e typecheck confirmados sem
      regressão. Diff conferido — só o helper novo de lock, sua
      integração nas 4 tarefas, o `break` substituído no motor, a
      constante de versão, os testes novos, e a documentação.

## Fase 27 — Correção da race condition crítica de reabertura da oportunidade (CONCLUÍDA — motor de matching 1.3 intocado)

Auditoria dedicada do ciclo completo da oportunidade (fora do motor,
tratado como caixa-preta) encontrou um achado **CRÍTICO** reproduzido
deterministicamente: quando duas atribuições diferentes da mesma
oportunidade terminam (recusa/cancelamento/expiração, em qualquer
combinação de `allocations-decide_POST`/`allocations-logistics_POST`/
`expireReservations`) em transações verdadeiramente concorrentes, cada
uma lia "quantas atribuições-irmãs ainda estão ativas" sem travar essas
linhas — sob READ COMMITTED, cada transação via a outra ainda "ativa"
(pré-commit), e **nenhuma** das duas reabria a oportunidade, mesmo com as
duas já de fato terminadas. Oportunidade ficava presa (`"atribuida"`/
`"reservada"` com zero atribuições ativas) até reprocessamento manual. Um
achado ALTO relacionado: `allocations-logistics_POST.ts` reabria sem
nenhuma cláusula condicional de status. Corrigido aqui, sem tocar em
peso/fórmula/threshold/critério/`ALGORITHM_VERSION`/schema:

- [x] `src/helpers/reopenOpportunity.tsx` (novo):
      `reopenOpportunityIfNoActiveAllocations(trx, opportunityRegistryId)`
      — trava a linha da OPORTUNIDADE (`FOR UPDATE`) **antes** de contar
      atribuições-irmãs ativas, serializando a decisão "zero ativas"
      entre todas as transações concorrentes que tentam terminar
      atribuições da mesma oportunidade. A escrita de reabertura é sempre
      condicional e atômica: `WHERE status IN ('reservada','atribuida')`
      — os dois únicos estados de onde uma reabertura por recusa/
      cancelamento/expiração pode legitimamente partir (análise dos 3
      fluxos que levam a `remainingActive=0`); qualquer outro status
      (terminal, ou já `aguardando_destinacao`) faz a escrita ser um
      no-op seguro.
- [x] Usado nos 3 caminhos reais que terminam uma atribuição e podem
      provocar reabertura: `allocations-decide_POST.ts` (recusa),
      `allocations-logistics_POST.ts` (cancelamento — corrige também o
      achado ALTO da guarda ausente), `expireReservations.tsx`
      (expiração — reestruturado para abrir uma transação curta por
      oportunidade em vez de queries soltas fora de transação).
- [x] **Deadlock real encontrado e corrigido durante a implementação**
      (não hipotético — reproduzido pelo próprio Postgres,
      `PostgresError 40P01`, ao rodar os testes de concorrência reais):
      `allocations-logistics_POST.ts` chamava `recordAuditLogEntry`
      (que trava um advisory lock GLOBAL da cadeia de auditoria até o
      commit — ver `auditLog.tsx`) **antes** de
      `reopenOpportunityIfNoActiveAllocations` (que trava a linha da
      oportunidade); `allocations-decide_POST.ts` já fazia na ordem
      inversa (oportunidade primeiro, auditoria por último — mesmo padrão
      já usado no resto do código, ex. `needs-status_POST.ts`). Duas
      transações concorrentes, uma por cada endpoint, formavam um ciclo
      clássico A-espera-B/B-espera-A. Corrigido alinhando
      `allocations-logistics_POST.ts` à mesma ordem: travar recursos
      próprios primeiro, `recordAuditLogEntry` sempre por último.
      Nenhuma outra ordem de lock no restante do código precisou mudar —
      `runMatchingForOpportunity`/`opportunity-allocations_POST.ts`/
      `opportunity-registry-status_POST.ts` só travam a oportunidade e
      nunca uma atribuição específica via `FOR UPDATE` depois, então não
      participam de nenhum ciclo possível com os 3 caminhos corrigidos.
- [x] `test/opportunityReopenConcurrency.test.ts` (11 testes novos): os 7
      cenários pedidos (A/B sequenciais em qualquer ordem; A+B
      concorrentes; 3 atribuições concorrentes; 2 concorrentes + 1 ainda
      ativa não reabre; reabertura permite novo matching; reabrir duas
      vezes não duplica) + 4 cenários de concorrência real entre
      endpoints/tarefas via `Promise.all` (logística+matching,
      logística+expiração, logística+decisão humana — cenário que expôs
      o deadlock antes da correção de ordem —, duas logísticas
      concorrentes sobre atribuições diferentes).
- [x] Suíte completa (187→198 testes) e typecheck confirmados sem
      regressão. Diff conferido — só o helper novo, sua integração nos 3
      caminhos, a correção de ordem de lock em `allocations-logistics_POST.ts`,
      os testes novos, e esta entrada de documentação. `opportunityMatching.tsx`
      e `db/schema.sql` com diff zero confirmado (`git diff --stat`).
- [ ] `needs.status` não atualizado automaticamente pelo ciclo de
      aceite/recebimento — **decisão de produto pendente, não
      implementada nesta etapa** (instrução explícita).
- [ ] Reaparecimento de organização recusada no matching seguinte — sem
      bloqueio histórico adicionado, **decisão de produto pendente, não
      implementada nesta etapa** (instrução explícita).
- [ ] `aguardando_coleta`/`em_transporte` continuam como valores mortos
      do enum `opportunity_registry_status` — **não removidos nesta
      etapa** (instrução explícita, dívida de modelagem registrada).
- [ ] O mesmo padrão de corrida (contar irmãs sem travar) também existe
      em `allocations-receive_POST.ts`, para a transição `→"concluida"`
      (fechamento, não reabertura) — **fora do escopo desta correção**
      (a auditoria e a instrução desta etapa cobriram só os 3 caminhos de
      reabertura), registrado aqui como achado conhecido para decisão
      futura.

## Fase 28 — Correção do bug crítico de conclusão da oportunidade (CONCLUÍDA — motor de matching 1.3 intocado)

Auditoria read-only do fechamento por recebimento (seguindo a observação
registrada ao final da Fase 27) encontrou um achado **CRÍTICO**,
determinístico (nem precisa de concorrência): a condição de conclusão
("todas as atribuições da oportunidade em `recebida`/`cancelada`/
`recusada`, com pelo menos uma `recebida`") só era verificada dentro de
`allocations-receive_POST.ts`. Cancelar/recusar/expirar a **última**
atribuição ainda ativa, quando uma irmã já havia sido `"recebida"`,
deixava a oportunidade presa em `"atribuida"` para sempre — reproduzido
sequencialmente, sem nenhuma corrida de tempo envolvida. Corrigido aqui,
sem tocar em pesos/fórmula/threshold/critério/`ALGORITHM_VERSION`/scheduler/
`reopenOpportunityIfNoActiveAllocations`/schema:

- [x] `src/helpers/concludeOpportunity.tsx` (novo):
      `concludeOpportunityIfAllTerminalAndReceived(trx, opportunityRegistryId)`
      — centraliza a regra (antes duplicada implicitamente só em um
      lugar). Trava a linha da OPORTUNIDADE (`FOR UPDATE`) antes de
      contar atribuições, exatamente como `reopenOpportunityIfNoActiveAllocations`
      — mas é uma regra **deliberadamente separada**: para reabertura,
      `"recebida"` conta como ativa (nunca reabrir uma doação já
      entregue); para conclusão, `"recebida"` é o próprio estado que
      precisa existir. A escrita para `"concluida"` é condicional e
      atômica (`WHERE status='atribuida'` — o único status legítimo
      nesse ponto, confirmado por análise: uma atribuição só chega a
      `"recebida"` depois de `"aceita"`, e aceitar sempre leva a
      oportunidade a `"atribuida"`; enquanto existir uma `"recebida"`,
      `reopenOpportunityIfNoActiveAllocations` nunca a move dali). Não
      grava nenhuma entrada de auditoria — decisão deliberada de ordem
      de locks (ver abaixo).
- [x] Integrado nos 4 caminhos reais que terminam uma atribuição:
      `allocations-receive_POST.ts` (recebida — regra migrada para o
      helper, comportamento idêntico), `allocations-decide_POST.ts`
      (recusada — tenta concluir primeiro, só tenta reabrir se não
      concluiu), `allocations-logistics_POST.ts` (cancelado — mesmo
      padrão), `expireReservations.tsx` (expiração — mesmo padrão,
      dentro da transação curta por oportunidade já existente da Fase
      27). As duas condições (concluir vs. reabrir) são mutuamente
      exclusivas pelos mesmos dados — a ordem entre elas nunca produz
      resultado incorreto.
- [x] **Ordem de locks mantida consistente com a correção da Fase 27**
      (que encontrou um deadlock real, `PostgresError 40P01`, por ordem
      inconsistente entre o advisory lock global da auditoria e a
      trava da linha da oportunidade): o helper de conclusão nunca
      grava auditoria internamente; cada um dos 4 chamadores só grava
      `recordAuditLogEntry` **depois** de chamar o helper (concluir ou
      reabrir), nunca antes — inclusive `allocations-receive_POST.ts`,
      que precisou ser reordenado (a chamada a
      `concludeOpportunityIfAllTerminalAndReceived` foi movida para
      antes do `recordAuditLogEntry("atribuicao.recebida")`, que antes
      vinha primeiro). Testado com concorrência real (`Promise.all`,
      handlers reais, não simulação) entre todas as combinações de
      caminhos — nenhum `40P01` reproduzido.
- [x] `test/opportunityConclusion.test.ts` (16 testes novos): os 9
      cenários obrigatórios (allocation única; A recebida+B ativa não
      conclui; B recebida depois conclui; B cancelada depois conclui —
      o bug crítico original; B recusada depois conclui; 3 allocations
      mistas conclui; nenhuma recebida não conclui por esta regra; 2
      terminações concorrentes con uma única conclusão; recebimento
      concorrente em 2 allocations) + 5 cenários de concorrência real
      entre caminhos diferentes (A: receive+cancel; B: receive+refuse;
      C: receive+expiração; D: cancel+refuse sem nenhuma recebida; E:
      3 terminações simultâneas) + 2 de multi-tenancy/idempotência do
      helper.
- [x] Suíte completa (198→214 testes) e typecheck confirmados sem
      regressão. Diff conferido — só o helper novo, sua integração nos
      4 caminhos, os testes novos, e esta entrada de documentação.
      `opportunityMatching.tsx`, `db/schema.sql`,
      `scheduledTaskLock.tsx` e `reopenOpportunity.tsx` com diff zero
      confirmado (`git diff --stat`).

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
