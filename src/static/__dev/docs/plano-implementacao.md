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

## Fase 29 — Ledger de atendimento de necessidades (`need_fulfillments`) — fundação de rastreabilidade (CONCLUÍDA)

Investigação arquitetural (só leitura) concluiu **ARQUITETURA DE ATENDIMENTO PRONTA PARA DECISÃO**: `needs.quantity_needed` é estático, sem progresso; o recebimento de uma allocation nunca registrava estruturalmente qual `need` pretendia atender; uma `need` pode continuar `"aberta"` indefinidamente após receber doações. Recomendação técnica: ledger append-only dedicado, sem transformar `needs.quantity_needed` num contador mutável. Esta fase implementa **só a fundação de rastreabilidade** — nenhuma regra automática de negócio (status, matching, bloqueios) foi tocada.

- [x] `need_fulfillments` (nova tabela, `db/migrations/0006_need_fulfillments.sql`):
      `organization_id` (obrigatório, sempre derivado da própria allocation
      — nunca um valor separado enviado pelo cliente), `need_id`
      (**nullable de propósito** — allocations manuais nunca passam por
      `match_evaluations`, então não há como saber a need pretendida;
      `NULL` é o valor correto, não uma lacuna), `allocation_id`
      (obrigatório, `UNIQUE` — uma allocation só pode ser recebida uma vez,
      confirmado pela própria máquina de estados de
      `allocations-receive_POST.ts`, então o ledger não inventa suporte a
      múltiplos recebimentos que não existe), `stock_transaction_id`
      (obrigatório, `UNIQUE` — um recebimento gera exatamente uma
      `stock_transaction`), `quantity`/`unit` (sempre o **recebido de
      verdade**, nunca o alocado nem o necessário), `unit_mismatch_note`
      (nullable, só preenchido no caso descrito abaixo), `created_by_user_id`,
      `created_at`. Append-only — mesmo `audit_log_block_mutation()` já
      usado por `stock_transactions`/`audit_log`/`logistics_events`
      (`UPDATE`/`DELETE` bloqueados por trigger, confirmado por teste).
- [x] `src/helpers/needFulfillment.tsx` (novo): `createNeedFulfillment`
      resolve `needId` pela relação estrutural real já existente —
      `opportunity_allocations.id → match_evaluations.allocation_id →
      match_evaluations.need_id` — nunca por texto/título/inferência.
      Cardinalidade confirmada por leitura do motor: no máximo uma
      `match_evaluations` tem um dado `allocation_id` (gravado só no
      momento em que aquela allocation específica é criada, nunca
      reaproveitado), então `executeTakeFirst()` reflete uma garantia
      real, não um `LIMIT 1` arbitrário sobre dado ambíguo.
- [x] **Unidades**: quando existe uma need candidata mas a unidade do
      recebimento diverge da unidade declarada pela need (mesma
      normalização textual do motor — `normalize()`, importada só como
      função pura, sem tocar em `opportunityMatching.tsx`), o `need_id`
      **não** é atribuído — nunca soma unidades incompatíveis (kg+unidade,
      litros+kg) — e `unit_mismatch_note` registra o motivo de forma
      identificável, em vez de um `NULL` silencioso e ambíguo com o caso
      "allocation manual sem need". O recebimento em si **não é
      bloqueado** por essa incompatibilidade (comportamento de negócio
      existente preservado).
- [x] Integrado em `allocations-receive_POST.ts`, na mesma transação,
      logo após a allocation virar `"recebida"` e antes do bloco de
      conclusão/auditoria — a chamada não trava a oportunidade nem o
      advisory lock de auditoria, então não interfere na ordem de locks já
      validada nas Fases 27/28 (nenhuma alteração naquele bloco).
- [x] `test/needFulfillment.test.ts` (9 testes): allocation do motor
      recebida (needId/allocationId/stockTransactionId/quantity/unit
      corretos); allocation manual (needId null); recebimento parcial
      (quantity = recebido, nunca o alocado); recebido acima do alocado
      (refletido tal como aconteceu, sem bloqueio — decisão de produto
      pendente); unidades compatíveis (vincula, com normalização
      tolerando maiúsculas/espaços); unidades incompatíveis (não vincula,
      motivo registrado); mesma allocation recebida duas vezes concorrente
      (só um fulfillment, protegido a montante pela máquina de estados da
      allocation); multi-tenancy (organizationId sempre da própria
      allocation, needId nunca de outra organização mesmo com needs
      parecidas na mesma oportunidade); append-only (`UPDATE`/`DELETE`
      bloqueados pelo trigger).
- [x] **Backfill histórico investigado, não executado** — confirmado no
      banco de desenvolvimento: 1 única allocation `"recebida"` existente
      hoje, criada manualmente (sem `match_evaluations`) durante os testes
      ao vivo da UI de Configurações de Matching (Fase 23). Mesmo essa
      não é backfillável com segurança: `stock_transactions` não tem
      nenhuma referência estruturada de volta para a allocation que a
      originou (só um campo `reason` de texto livre) — não há como
      determinar `stock_transaction_id` (campo obrigatório do ledger) sem
      inventar uma correspondência por inferência de texto, o que a
      instrução desta etapa proíbe explicitamente. Cobertura do backfill:
      **0 de 1 registros históricos reconstruíveis com segurança**.
      Nenhum backfill foi escrito ou executado — o ledger passa a
      registrar só recebimentos novos, a partir desta fase.
- [x] Suíte completa (214→223 testes) e typecheck confirmados sem
      regressão. Diff conferido — só a migration/schema da tabela nova, a
      integração em `allocations-receive_POST.ts`, o helper novo, os
      testes novos, e esta entrada de documentação.
      `opportunityMatching.tsx` com diff zero confirmado (`git diff --stat`).
- [ ] **Não implementado nesta etapa, por instrução explícita** (decisões
      de produto ainda pendentes, não bugs técnicos): `needs.status`
      derivado automaticamente do ledger; `needs.quantity_needed` virar
      contador mutável ou ganhar uma view de saldo; limite/bloqueio de
      `quantityReceived` acima do alocado; bloqueio de reaparecimento pós-
      recusa; qualquer uso do ledger pelo motor de matching (`need_remaining`
      continua não existindo — `opportunityMatching.tsx` intocado,
      `ALGORITHM_VERSION` continua `"1.3"`).

## Fase 30 — Correção estrutural do ledger: FKs RESTRICT + índice em `match_evaluations.allocation_id` (CONCLUÍDA)

Auditoria definitiva do ledger (Fase 29) encontrou um achado **CRÍTICO**, reproduzido: `need_fulfillments` é append-only (trigger `audit_log_block_mutation`), mas nasceu com `ON DELETE SET NULL` (`need_id`) e `ON DELETE CASCADE` (`allocation_id`, `organization_id`) — ações que exigem o Postgres alterar/apagar a própria linha do ledger para honrar a exclusão da linha-pai. O trigger append-only intercepta essa operação interna e bloqueia, fazendo o `DELETE` da linha-pai (`needs`/`opportunity_allocations`/`organizations`) **falhar por inteiro**, em vez de silenciosamente cascatear/anular como as cláusulas prometiam. Corrigido aqui, junto com um achado de performance (ausência de índice em `match_evaluations.allocation_id`, consultado a cada recebimento):

- [x] Investigação obrigatória confirmou, por busca exaustiva
      (`grep -rln "deleteFrom(\"organizations\")\|deleteFrom(\"needs\")\|deleteFrom(\"opportunityAllocations\")"`,
      sem nenhum resultado): **nenhum endpoint em todo o projeto deleta**
      `organizations`, `needs` ou `opportunity_allocations`. A única
      rotina de "exclusão" relacionada (LGPD, `account-delete_POST.ts`)
      anonimiza o usuário, nunca apaga a organização. Trocar as 3 FKs
      para `RESTRICT` não quebra nenhum fluxo real hoje — confirmado
      antes de alterar, não presumido.
- [x] `db/migrations/0007_need_fulfillments_fk_restrict.sql`: as 3 FKs
      (`need_id`, `allocation_id`, `organization_id`) trocadas de
      `SET NULL`/`CASCADE` para `RESTRICT` (mesmo padrão já usado em
      `stock_transactions.item_id`). `db/schema.sql` atualizado para
      refletir o estado final diretamente na `CREATE TABLE` (mesmo padrão
      das correções anteriores — schema.sql sempre mostra o resultado
      final, não uma sequência de `ALTER`).
- [x] Índice novo: `idx_match_evaluations_allocation_id`
      (`UNIQUE ... WHERE allocation_id IS NOT NULL`) — cardinalidade
      1:1 reconfirmada (por leitura do motor **e** por consulta direta ao
      banco de desenvolvimento: `SELECT allocation_id, count(*) ...
      HAVING count(*)>1` retornou zero linhas antes de criar o índice
      único). Acelera a resolução de `needId` em
      `createNeedFulfillment` — nenhuma relação/cardinalidade foi
      redefinida, só expressa no banco a garantia que já existia no
      código. `opportunity_allocations.match_evaluation_id` continua
      fora de escopo, não preenchido.
- [x] Nenhuma alteração em dado histórico — só constraints/índice, sem
      `UPDATE`/backfill em `need_fulfillments` ou qualquer outra tabela.
- [x] `test/needFulfillment.test.ts` (+5 testes, A-E): `UPDATE`/`DELETE`
      em `need_fulfillments` continuam bloqueados (reconfirmação); excluir
      a `need`, a `allocation` ou a `organization` referenciada por um
      fulfillment existente agora é **bloqueado pelo `RESTRICT`** (com
      mensagem de erro do próprio Postgres, não mais o erro genérico de
      "append-only" que aparecia antes por acidente) — histórico
      confirmado intacto em todos os 3 casos, nada foi apagado nem
      alterado silenciosamente.
- [x] Suíte completa (223→228 testes) e typecheck confirmados sem
      regressão. Diff conferido — só a migration nova, `schema.sql`, os
      5 testes novos, e esta entrada de documentação.
      `opportunityMatching.tsx` com diff zero confirmado.
- [ ] **`unit_mismatch_note` permanece pendente, não implementado nesta
      etapa** (instrução explícita) — a decisão entre `need_id=NULL`+nota
      textual (atual) versus `need_id` preservado com uma flag de "não
      contabilizável" (mais forte para auditoria futura, apresentada mas
      não escolhida) fica registrada para uma etapa própria.

**Regra documentada**: `need_fulfillments` é append-only e seus registros
históricos não podem ser modificados ou removidos implicitamente pela
exclusão de entidades-pai — qualquer ação de FK que exigisse um
`UPDATE`/`DELETE` no ledger (`SET NULL`, `CASCADE`) é incompatível com o
modelo append-only e deve ser evitada; `RESTRICT`/`NO ACTION` são as
únicas ações de FK seguras para uma tabela append-only referenciada por
outras entidades.

## Fase 31 — Evolução do ledger para eventos (Modelo B): `entry_type`/`is_countable`/`reverses_fulfillment_id` (CONCLUÍDA)

Investigação arquitetural aprovou o **Modelo B**: `need_fulfillments` deixa de significar "uma allocation gera exatamente um fulfillment" e passa a significar "um evento de atendimento relacionado a uma allocation/need/movimento de estoque" — permitindo correções/reversões como novas linhas (append-only preservado) e preservando `need_id` mesmo quando a unidade do recebimento é incompatível (a relação com o matching é um fato já certo, nunca deve ser descartada por causa da unidade — só a contabilização é suspensa). Escopo desta etapa: **só a infraestrutura**, nenhuma regra automática de negócio nova.

- [x] `db/migrations/0008_need_fulfillments_ledger_of_events.sql`: `entry_type`
      (`'original'|'correction'|'reversal'`, `CHECK`, default `'original'`
      — taxonomia mínima analisada, não assumida: `original` é o
      recebimento físico real, nunca referencia outra linha, exige
      `stock_transaction_id`; `correction` adiciona um valor
      novo/corrigido, referência opcional a uma linha anterior;
      `reversal` desfaz numericamente uma contribuição, sempre exige
      `reverses_fulfillment_id`); `is_countable BOOLEAN NOT NULL DEFAULT true`
      (independente de `entry_type` — um `original` pode ter
      `is_countable=false`); `reverses_fulfillment_id` (auto-FK,
      `RESTRICT`, nullable) — ciclos estruturalmente impossíveis
      (auto-referência a uma linha que já precisa existir no momento do
      `INSERT`, PK auto-incremental). `stock_transaction_id` virou
      **nullable** (uma correção puramente de metadado não tem motivo de
      negócio para inventar um novo lançamento físico de estoque).
- [x] `need_fulfillments_validate_entry` (novo trigger `BEFORE INSERT`,
      mesmo padrão de `audit_log_block_mutation`): valida cruzamento entre
      linhas (não expressável só com `CHECK`/FK simples) — `original` sem
      `reverses_fulfillment_id`, com `stock_transaction_id` obrigatório;
      `correction`/`reversal` sempre com `reverses_fulfillment_id`
      apontando para uma linha da MESMA `allocation_id` cujo `entry_type`
      não seja `'reversal'` (nunca reverter uma reversão — para isso, uma
      nova `correction` aponta de volta ao evento original).
- [x] `UNIQUE(allocation_id)` substituído por índice único **parcial**
      (`WHERE entry_type='original'`) — no máximo uma linha original por
      allocation, mas correções/reversões repetem a `allocation_id`
      livremente (a mudança central que resolve o conflito com
      append-only encontrado na auditoria anterior).
      `UNIQUE(stock_transaction_id)` não precisou mudar — Postgres já
      trata múltiplos `NULL` como não-conflitantes.
- [x] `src/helpers/needFulfillment.tsx`: mudança de comportamento
      (Modelo B) — incompatibilidade de unidade agora preserva `needId`
      (`isCountable=false` + `unitMismatchNote`), em vez de descartar a
      relação (`needId=null`, comportamento da Fase 29). Continua criando
      só `entry_type="original"` — nenhuma função/endpoint de
      correção/reversão foi implementado (infraestrutura apenas).
- [x] `test/needFulfillment.test.ts` (+8 testes; teste 6 de unidade
      incompatível atualizado para a nova semântica): correção de evento
      original sem novo movimento físico; reversão exigindo
      `reverses_fulfillment_id`; correção com novo `stock_transaction`
      real (`type="ajuste"`); duas linhas `original` para a mesma
      allocation proibidas (índice único parcial); duas linhas `original`
      para o mesmo `stock_transaction` proibidas (`UNIQUE`); reverter uma
      `reversal` proibido pelo trigger; referenciar allocation diferente
      proibido pelo trigger; migração de uma linha "estilo Fase 29" (sem
      `entry_type`/`is_countable` explícitos) confirma os defaults
      corretos.
- [x] Suíte completa (228→236 testes) e typecheck confirmados sem
      regressão. Diff conferido — só a migration nova, `schema.sql`,
      `schema.tsx` (tipos), `needFulfillment.tsx`, os testes, e esta
      entrada de documentação. `opportunityMatching.tsx` com diff zero
      confirmado; `ALGORITHM_VERSION` continua `"1.3"`.
- [ ] **Não implementado nesta etapa, por instrução explícita**: função/
      endpoint para CRIAR eventos de correção/reversão (só o schema
      suporta, nenhum caminho de aplicação os gera ainda);
      `need_remaining` no matching; mudança automática de `needs.status`;
      política de over-fulfillment; bloqueio de reaparecimento pós-recusa;
      endpoint de relatório/progresso da need. Todos continuam decisões de
      produto pendentes, registradas em fases anteriores.

**Regra de soma futura (documentada, não implementada)**: um cálculo
determinístico de progresso de uma need deve ser
`SUM(CASE WHEN entry_type='reversal' THEN -quantity ELSE quantity END)
WHERE need_id=? AND is_countable=true` — nunca dependente de parsear
`unit_mismatch_note` ou qualquer outro texto livre.

## Fase 32 — Estabilização do Modelo B: fechamento das lacunas de integridade da auditoria definitiva (CONCLUÍDA)

A auditoria definitiva read-only da Fase 31 encontrou várias lacunas
estruturais reais: regras que a documentação afirmava existir mas que o
trigger não impunha de fato. Esta fase corrige **só** essas lacunas —
preserva o desenho do Modelo B (cadeias `correction`/`reversal`
continuam permitidas, nenhuma topologia "estrela" foi imposta), sem
remodelagem ampla.

- [x] `db/migrations/0009_need_fulfillments_inheritance_rules.sql` —
      `need_fulfillments_validate_entry` (mesma função, `CREATE OR
      REPLACE`) passa a exigir, estruturalmente, no `INSERT` de uma
      `correction`/`reversal`:
      - `organization_id` IGUAL ao da linha referenciada
        (`reverses_fulfillment_id`) — antes só validado em TypeScript.
      - `need_id` HERDADO da linha referenciada, nunca escolhido
        livremente (`unit` continua livre — é o campo que uma
        `correction` pode legitimamente precisar mudar).
      - Para `reversal` especificamente: `unit`, `quantity` e
        `is_countable` também precisam ser IDÊNTICOS aos da linha
        revertida — um `reversal` é "a reversão direta do evento
        apontado", nunca um evento com dados próprios; o único efeito
        diferente é o sinal contábil (`-quantity`), nunca armazenado como
        valor negativo (`quantity` continua sempre positiva, `CHECK`
        inalterado).
- [x] `idx_need_fulfillments_one_reversal_per_target` — índice único
      parcial (`UNIQUE(reverses_fulfillment_id) WHERE entry_type =
      'reversal'`) — impede duas reversões diretas do mesmo alvo, no
      banco (não só numa checagem de aplicação); correções continuam sem
      limite por alvo.
- [x] `idx_need_fulfillments_allocation_history` — índice não-parcial em
      `(allocation_id, created_at)` para consultas de histórico completo
      (`original`+`correction`+`reversal`) de uma allocation, sem
      depender do índice único parcial da `original`.
- [x] `src/helpers/needFulfillment.tsx`: `getNeedFulfillmentBalance` —
      fórmula canônica do ledger, implementada uma única vez (mesmo
      padrão de `getItemStockBalance`), delegando a agregação ao Postgres:
      `SUM(CASE WHEN entry_type='reversal' THEN -quantity ELSE quantity
      END) WHERE need_id=? AND is_countable=true`. Nenhum endpoint público
      novo — só uma função auxiliar reutilizável.
- [x] `db/schema.sql`: comentário da seção `need_fulfillments` corrigido
      para refletir o comportamento real (não a intenção previamente
      documentada e errada) — `correction` NUNCA teve referência
      opcional; cadeias são permitidas deliberadamente; `reversal` pode
      apontar para uma `correction`; sinal contábil é sempre derivado de
      `entry_type`, nunca armazenado negativo; um alvo só pode ter UM
      `reversal` direto.
- [x] `test/needFulfillmentModelB.test.ts` (novo, 25 testes, cenários
      A–X do pedido): herança de `organization_id` (aceito/rejeitado,
      inclusive teste de isolamento entre organizações); herança de
      `need_id` (`NULL`→`NULL`, valor real→mesmo valor, tentativa de
      trocar rejeitada, para `correction` e `reversal`); `unit` livre em
      `correction` mas obrigatoriamente herdado em `reversal`;
      `quantity`/`is_countable` obrigatoriamente herdados em `reversal`;
      cadeias `correction→correction` e `reversal→correction` continuam
      aceitas; proibição estrutural de referenciar uma linha `reversal`
      permanece; dupla reversão do mesmo alvo rejeitada (sequencial E
      concorrente — dois `INSERT`s concorrentes, só um persiste);
      múltiplas `correction`s do mesmo alvo continuam ilimitadas; índice
      de histórico por `allocation_id` retorna todas as linhas; fórmula
      canônica (`getNeedFulfillmentBalance`) confere original+correction-
      reversal ignorando linhas `is_countable=false`; over-fulfillment
      continua representável sem bloqueio; append-only (`UPDATE`/`DELETE`
      bloqueados) confirmado para os 3 `entry_type`s.
- [x] `test/needFulfillment.test.ts` (22 testes pré-existentes da Fase
      29-31): re-executados sem nenhuma alteração, todos passando contra
      o trigger novo — nenhuma regressão de comportamento já coberto.
- [x] Suíte completa (236→261 testes) e `npx tsc --noEmit` confirmados
      sem regressão. `git diff --stat` de `src/helpers/opportunityMatching.tsx`
      e de todos os arquivos do lifecycle da oportunidade
      (`allocations-receive_POST.ts`, `allocations-decide_POST.ts`,
      `reopenOpportunity.tsx`, `concludeOpportunity.tsx`,
      `scheduledTaskLock.tsx`) permanece vazio — `ALGORITHM_VERSION`
      continua `"1.3"`, motor e ciclo de vida intocados.
- [ ] **Não implementado nesta etapa, por instrução explícita** (mesma
      lista da Fase 31, ainda pendente): função/endpoint para CRIAR
      eventos de correção/reversão a partir de uma ação do usuário (o
      schema suporta desde a Fase 31; esta fase só reforçou as regras de
      integridade que já deviam valer); `need_remaining` no matching;
      mudança automática de `needs.status`; política de over-fulfillment;
      bloqueio de reaparecimento pós-recusa; endpoint de relatório/
      progresso da need; idempotência genérica por chave (não introduzida
      — o índice único parcial de reversal já resolve o caso de
      concorrência real sem esse mecanismo adicional).

## Fase 33 — Isolamento multi-tenant do lastro físico de `need_fulfillments` (CONCLUÍDA)

Auditoria read-only definitiva pós-Fase 32 (nenhuma alteração feita
naquela etapa) reproduziu, em transação temporária revertida, dois
problemas estruturais reais em `stock_transaction_id`: (1) um
`need_fulfillment` de uma organização podia referenciar um
`stock_transaction` de OUTRA organização — a FK simples só garantia
existência do id, nunca a mesma organização; (2) nenhuma constraint
impedia associar um `stock_transaction` fisicamente incompatível (item,
unidade, quantidade, direção diferentes). Esta fase corrige **só** o
problema (1), estruturalmente; o problema (2) foi investigado a fundo e
**deliberadamente não corrigido**, por não existir hoje uma fonte
canônica dos dados físicos esperados na cadeia allocation→opportunity/
need — inventar uma coluna nova (`item_id` em `need_fulfillments`) sem
necessidade de negócio comprovada foi explicitamente rejeitado.

- [x] `db/migrations/0010_need_fulfillments_stock_transaction_org_fk.sql`:
      `stock_transactions` ganha `UNIQUE(id, organization_id)` (`id` já é
      PK, mas o Postgres exige um UNIQUE explícito nas colunas exatas para
      servir de lado referenciado de uma FK composta). A FK simples
      `need_fulfillments_stock_transaction_id_fkey` (só `id`) foi
      substituída por `need_fulfillments_stock_transaction_org_fkey`,
      composta `(stock_transaction_id, organization_id)` →
      `stock_transactions(id, organization_id)`. Com `MATCH SIMPLE`
      (padrão do Postgres), a FK composta é trivialmente satisfeita
      quando `stock_transaction_id` é `NULL` — preserva sem nenhuma
      mudança correction/reversal interpretativos (sem movimento físico).
      Confirmado antes de aplicar: `stock_transactions.organization_id`
      já era `NOT NULL` desde a criação da tabela; `need_fulfillments`
      tinha **zero linhas** no banco dev — nenhum dado histórico
      incompatível, nenhuma limpeza/correção silenciosa necessária.
- [x] `db/schema.sql`: `CREATE TABLE stock_transactions`/
      `need_fulfillments` atualizados inline para o estado final; novo
      bloco de comentário documentando a garantia de organização E a
      limitação física conhecida (não corrigida, decisão registrada).
- [x] `test/needFulfillmentStockTransactionOrg.test.ts` (novo, 7 testes):
      fulfillment org A + stock_transaction da própria org A aceito;
      fulfillment/correction org A + stock_transaction de org B rejeitado
      pela FK composta (`need_fulfillments_stock_transaction_org_fkey`);
      correction física (novo `stock_transaction` real, mesma org)
      aceita; correction interpretativa (`stock_transaction_id=NULL`)
      aceita; `UNIQUE(stock_transaction_id)` continua rejeitando dois
      fulfillments para o mesmo movimento físico; múltiplos
      `stock_transaction_id=NULL` continuam permitidos e
      `getNeedFulfillmentBalance` confirmado independente de
      `stock_transaction_id` (fórmula inalterada:
      `original+correction-reversal`, ignorando `is_countable=false`).
- [x] Suíte completa (261→268 testes) e `npx tsc --noEmit` confirmados
      sem regressão. `git diff --stat` de `opportunityMatching.tsx`,
      `allocations-receive_POST.ts`, `allocations-decide_POST.ts`,
      `reopenOpportunity.tsx`, `concludeOpportunity.tsx`,
      `expireReservations.tsx` e `needFulfillment.tsx` permanece vazio —
      nenhum código de aplicação foi alterado nesta fase, só schema/
      migration/documentação/testes.
- [ ] **Não implementado nesta etapa, por decisão arquitetural
      registrada (não por instrução momentânea)**: validação estrutural
      de compatibilidade física (item/unidade/quantidade/direção) entre
      `need_fulfillments` e o `stock_transaction` referenciado. Motivo:
      `opportunity_registry`/`opportunity_allocations`/`match_evaluations`
      não carregam `item_id` em nenhum ponto da cadeia;
      `needs.item_id` é opcional; `need_fulfillments.need_id` só existe
      quando há `match_evaluations` para aquela allocation (nunca em
      allocations manuais). Menor mudança estrutural que resolveria isso:
      adicionar `item_id` (não-nulo) a `need_fulfillments`, mas isso
      exigiria decidir de onde esse valor viria em TODOS os caminhos de
      criação (incluindo allocations manuais sem matching) — decisão de
      produto/arquitetura ainda pendente, não uma lacuna a fechar
      silenciosamente agora.

## Fase 34 — Formalização do contrato arquitetural de `stock_transaction_id` e congelamento do núcleo do Modelo B (CONCLUÍDA — só documentação)

Etapa de formalização, não de remodelagem: nenhuma migration, nenhum
endpoint, nenhuma coluna nova. Objetivo era transformar o comportamento
JÁ REAL (confirmado por auditoria de código, não alterado) em contrato
arquitetural explícito, e decidir se o núcleo estrutural do Modelo B
pode ser considerado congelado apesar da limitação física conhecida da
Fase 33.

- [x] Investigação de produtores de `need_fulfillments`: `createNeedFulfillment`
      (`src/helpers/needFulfillment.tsx`) é o **único** produtor real no
      código-base — busca por `insertInto("needFulfillments")` e
      `INSERT INTO need_fulfillments` confirma isso. É chamado apenas por
      `allocations-receive_POST.ts`. `opportunities-receive_POST.ts`
      também cria um `stock_transaction`, mas para o fluxo LEGADO de
      `donation_opportunities` — nunca cria `need_fulfillments`; irrelevante
      para este ledger.
- [x] Confirmado que `allocations-receive_POST.schema.ts` (schema Zod do
      request) **não tem** campo `stock_transaction_id` — o único lugar
      onde esse nome aparece no arquivo é no `OutputType` (resposta), não
      no `schema` de entrada. Nenhum cliente pode enviar um
      `stockTransactionId` arbitrário para este endpoint.
- [x] Confirmado por leitura de `allocations-receive_POST.ts`: o
      `stock_transaction` é criado dentro da mesma `db.transaction()`,
      poucas linhas antes da chamada a `createNeedFulfillment`, e o `id`
      recém-gerado (`tx.id`) é usado imediatamente — nunca um valor lido
      de outro lugar ou recebido de fora.
- [x] `src/helpers/needFulfillment.tsx`: comentário arquitetural expandido
      (só comentários — `git diff` confirma zero linhas de código
      executável alteradas) formalizando: o papel de `stock_transaction_id`
      como lastro físico (nunca um id arbitrário escolhido por um
      chamador); a fronteira banco×serviço de domínio; o contrato
      obrigatório para um futuro endpoint de correction/reversal física
      (criar o `stock_transaction` dentro da mesma transação, nunca
      aceitar um id externo); que `correction.stock_transaction_id`
      pode legitimamente ter `unit`/`quantity`/`is_countable` diferentes
      do alvo (não deve exigir igualdade); que
      `reversal.stock_transaction_id != NULL` é uma capacidade do schema
      sem contrato de domínio definido (não exercitada, não proibida).
- [x] Fronteira formalizada — o que o BANCO garante: existência do
      `stock_transaction` referenciado; mesma organização (FK composta,
      Fase 33); unicidade do `stock_transaction` usado no ledger; herança
      de `organization_id`/`need_id` entre correction/reversal e o alvo
      (Fase 32); herança total de `unit`/`quantity`/`is_countable` em
      reversal; uma única reversal direta por alvo; append-only; grafo
      sem ciclos nem referência a `reversal`; saldo contábil derivável
      por fórmula pura. O que o SERVIÇO DE DOMÍNIO garante (não o banco):
      que o `stock_transaction` recém-criado representa o movimento
      físico correto para aquela operação; que os dados do movimento
      (item/unidade/quantidade/direção) são os corretos; que uma
      correction física gera seu próprio movimento em vez de reaproveitar
      um alheio; que nenhum caminho aceita `stock_transaction_id` externo
      por confiança.
- [x] Suíte mantida em **268/268** (nenhum teste novo fabricado — a
      instrução desta fase foi explícita em não criar testes só para
      aumentar cobertura quando a regra já está coberta) e
      `npx tsc --noEmit` confirmado limpo.
- [x] `git diff --stat` revisado por completo: só `needFulfillment.tsx`
      (comentários) e esta entrada de documentação — `opportunityMatching.tsx`,
      lifecycle da oportunidade e o restante do ledger permanecem com
      diff zero.
- [ ] **Não corrigido nesta fase, por decisão explícita**: compatibilidade
      física universal (item/unidade/quantidade/direção) entre um
      `need_fulfillment` qualquer e um `stock_transaction` qualquer — não
      é tratada como bug, porque a arquitetura atual já impede,
      estruturalmente, que qualquer fluxo real aceite um
      `stock_transaction_id` escolhido arbitrariamente de fora (único
      produtor sempre cria seu próprio movimento na mesma transação). Se
      um futuro fluxo violar esse contrato (aceitar um id externo sem
      criar o movimento na mesma operação), a violação deve ser tratada
      como uma regressão do contrato aqui formalizado, não como uma
      lacuna nova a redescobrir.

**Veredito registrado desta fase**: núcleo estrutural do Modelo B —
isolamento multi-tenant (Fase 33), integridade do grafo
correction/reversal (Fase 32), append-only, saldo contábil — está
congelado. A limitação de compatibilidade física universal é uma
fronteira arquitetural conhecida e documentada (responsabilidade do
futuro serviço de domínio que criar correction/reversal físicas), não
uma inconsistência do ledger.

## Fases 35-42 — resumo (auditadas/implementadas via relatório de chat, não detalhadas neste arquivo)

Fase 35: corrigida race de dupla baixa em `needs-status_POST.ts` (`FOR
UPDATE` na linha da need) e unidade ignorada no critério `quantidade` do
Matching (unidades incompatíveis passam a gerar `score:null`, nunca
comparadas numericamente). Fase 36: desenho de domínio (análise, sem
implementação) de `needs.status`/`need_remaining`/over-fulfillment. Fase
37: fechada a semântica — `needs.status` é decisão administrativa
persistida, independente do ledger; `required_remaining`/`surplus`
seriam derivados; reversal nunca altera `needs.status` automaticamente.
Fase 38: auditoria comprovou que `needs-status_POST.ts` permitia baixa de
estoque próprio repetível a cada ciclo `aberta→atendida`. Fase 39:
definido que reabrir uma need nunca representa um novo ciclo físico — a
resolução administrativa deve ser única na vida da need. Fase 40:
implementada `need_resolutions` (`UNIQUE(need_id)`, índice único parcial
em `stock_transaction_id`, append-only) — a baixa de estoque próprio
passa a ser garantida única estruturalmente, preservando a liberdade de
transição de `needs.status`. Fase 41: implantada a Central Visual do
front-end (uso do preview interativo real do ambiente sobre a aplicação
já existente — dashboard, abas por organização, `/plataforma` — sem
duplicar a aplicação); corrigidos dois bugs visuais reais encontrados na
primeira navegação (rótulo de papel sem acento + `text-transform`
quebrando "membro(s)"; link de "Prestação de contas" ausente em 4 das 7
páginas de organização). Fase 42: implementada a camada de progresso da
need — `getNeedFulfillmentBalanceBatch`/`computeNeedProgress`
(`fulfilled`/`requiredRemaining`/`surplus`, puramente derivados do
Modelo B, nunca persistidos, nunca sincronizados com `needs.status` nem
com `need_resolutions`), exposta em `GET /needs` e exibida na tela de
Necessidades.

## Fase 43 — Integração do progresso real ao Matching: `ALGORITHM_VERSION` 1.3→1.4 (CONCLUÍDA)

Mudança real de comportamento do algoritmo (não só de rótulo): o
Matching deixa de tratar uma need parcialmente/totalmente atendida pela
rede como se ainda precisasse da quantidade original inteira.

- [x] Elegibilidade de need no Matching passa a exigir
      `needs.status='aberta' AND requiredRemaining>0` (antes: só o
      status). Progresso calculado em LOTE
      (`getNeedFulfillmentBalanceBatch`, Fase 42) para todas as needs
      candidatas de uma só vez — nunca um `SUM` por candidato dentro do
      loop de pontuação (mesmo princípio anti-N+1 já usado para
      capacidade/logística/área de atendimento).
- [x] Critério `quantidade` passa a comparar a oferta da oportunidade
      contra `requiredRemaining`, não mais `quantityNeeded` — o mesmo
      valor também é usado como teto de `quantityToAllocate` (não faz
      sentido pontuar contra "faltam 300" e depois oferecer alocação de
      até "500").
- [x] Regra de unidade incompatível da Fase 35 preservada integralmente
      (`quantityScore=null`, nunca descarte automático do candidato);
      `is_countable`/Modelo B/`need_resolutions` inalterados — o
      Matching só consome o resultado já pronto de
      `computeNeedProgress`, nunca recalcula progresso por conta própria.
- [x] Pesos, thresholds, renormalização (`applicableWeight`), desempate
      (`organizationId`+`needId`) e todo o resto do algoritmo continuam
      byte-idênticos à versão 1.3 — `git diff` do arquivo confirma que
      só a origem da quantidade-alvo e o filtro de elegibilidade
      mudaram.
- [x] `ALGORITHM_VERSION` "1.3"→"1.4": avaliações (`match_evaluations`)
      já persistidas continuam com `algorithm_version="1.3"`, nunca
      reescritas; só novas avaliações desta fase em diante gravam "1.4"
      (confirmado por teste dedicado, inserindo uma avaliação "1.3"
      manual antes de rodar o motor).
- [x] 15 testes novos (`test/opportunityMatchingRequiredRemaining.test.ts`):
      sem fulfillment (candidata); parcial (candidata, score usa o
      restante); exatamente atendida e over-fulfilled (`remaining=0`,
      NÃO candidatas, confirmado por ausência de `match_evaluations`);
      `status='atendida'` e `cancelada` continuam bloqueando o matching
      mesmo com `remaining>0`; reversal total reabre o progresso (need
      volta a ser candidata); non-countable não conta; unidade
      compatível/incompatível; renormalização com `quantidade=null`;
      mudança de score sem alterar pesos/thresholds; lote com múltiplas
      needs; multi-tenancy (lote não cruza organizações);
      `algorithm_version` novo vs. histórico preservado. 3 testes
      pré-existentes tiveram sua asserção de versão atualizada de "1.3"
      para "1.4" (mesmo padrão da Fase 26, quando 1.2→1.3).
- [x] Suíte completa (297→312 testes) e `npx tsc --noEmit` confirmados
      sem regressão. `git diff --stat` de `needs-status_POST.ts`,
      `need_resolutions`, todo o lifecycle
      (`allocations-receive_POST.ts`, `allocations-decide_POST.ts`,
      `reopenOpportunity.tsx`, `concludeOpportunity.tsx`,
      `expireReservations.tsx`) e do schema/migrations do Modelo B
      permanece vazio.
- [x] Central Visual verificada no preview real após a mudança: telas de
      Necessidades, Configurações de Matching, `/plataforma` e Rede
      Levora, em desktop e mobile (375×812) — nenhuma alteração visual
      inesperada (o Matching é só backend; as telas continuam idênticas
      à Fase 42).
- [ ] **Não implementado nesta etapa, por instrução explícita**: `quantityToAllocate`
      capado por `requiredRemaining` foi implementado (é a mesma
      variável `needQty`, ver acima) — mas nenhuma política NOVA de
      over-fulfillment, allocation manual→need, cooldown de recusa,
      novo status persistido, cache/materialização de progresso, ou
      alteração do Modelo B/`need_resolutions`.

## Fase 44 — Allocation manual × need: análise de domínio (CONCLUÍDA — só análise)

Read-only: allocation manual (`opportunity-allocations_POST.ts`, só
`platformAdmin`) nunca gera `match_evaluations`, então `createNeedFulfillment`
nunca resolve `need_id` para ela — reproduzido em transação temporária que
uma allocation manual de 300kg recebida não reduz `requiredRemaining` de
nenhuma need, mesmo tendo fisicamente entrado no estoque. Recomendação:
`need_id` opcional em `opportunity_allocations`, escolhido explicitamente
pelo admin (nunca inferido automaticamente — a alternativa de inferência
por categoria/texto/quantidade foi explicitamente descartada, quebraria o
padrão do projeto inteiro de nunca inventar relações). Regras propostas:
mesma organização (validação em API + FK composta, padrão da Fase 33);
`cancelada` bloqueia o vínculo (decorre da Fase 37); `atendida` é questão
de produto em aberto; unidade incompatível não bloqueia — vira
`is_countable=false`; quantidade > remaining permitida (vira `surplus`).

## Fase 45 — Allocation manual com need_id opcional (CONCLUÍDA)

Implementa a decisão da Fase 44.

- [x] `db/migrations/0012_opportunity_allocations_need_id.sql`:
      `needs` ganha `UNIQUE(id, organization_id)` (suporte à FK composta,
      mesmo padrão da Fase 33); `opportunity_allocations` ganha `need_id`
      nullable + FK composta `(need_id, organization_id) → needs(id,
      organization_id) ON DELETE RESTRICT` — garante estruturalmente que
      uma allocation nunca referencie a need de outra organização, mesmo
      em SQL direto (confirmado por teste). `need_fulfillments`, triggers
      e migrations do Modelo B permanecem intocados.
- [x] `opportunity-allocations_POST.ts`: `needId` opcional no schema;
      quando informado, valida (dentro da mesma transação, travando a
      opportunity) existência, mesma organização, `status='aberta'`, e
      `requiredRemaining>0` (via `getNeedFulfillmentBalance`+
      `computeNeedProgress`, Fase 42 — nenhum cálculo paralelo). Quantity
      maior que remaining continua aceito (vira `surplus`, mesma política
      já vigente). `needId` incluído no `metadata` já existente do audit
      event `atribuicao.proposta`.
- [x] `needFulfillment.tsx`/`createNeedFulfillment`: segunda fonte
      legítima de `need_id` — `opportunity_allocations.need_id`, usada
      quando não há `match_evaluations` (allocations automáticas e
      manuais nunca coexistem para a mesma allocation). Se as duas fontes
      um dia divergirem para a mesma allocation, a função lança um erro
      explícito dentro da transação (nunca escolhe uma silenciosamente) —
      confirmado por teste que insere essa inconsistência manualmente.
      `needs.status` mudar ou `requiredRemaining` mudar DEPOIS da
      allocation já criada nunca bloqueia o recebimento (a seleção já foi
      validada na criação; o Modelo B registra o fato físico ocorrido,
      independente de decisões administrativas posteriores) —
      confirmado por 2 testes dedicados.
- [x] `plataforma.tsx`: diálogo "Atribuir: {título}" ganha um seletor
      "Necessidade (opcional)", visível só depois da organização
      escolhida, listando apenas needs elegíveis (`status='aberta' AND
      requiredRemaining>0`) via o mesmo `GET /needs` da Fase 42 (nenhum
      cálculo de progresso no front-end) — cada opção mostra
      necessária/recebido/faltam. Mensagem dedicada quando não há
      nenhuma need elegível. Trocar de organização limpa a need
      selecionada.
- [x] Sem infraestrutura de teste de componente no projeto (confirmado:
      nenhum `@testing-library`/`render()` em nenhum teste existente) —
      validação de UI feita inteiramente no preview real (Central
      Visual), não com testes de UI fabricados, conforme instrução
      explícita.
- [x] 16 testes novos (`test/opportunityAllocationsManualNeed.test.ts`):
      allocation sem need inalterada; allocation com need persiste o
      vínculo; organization mismatch, need cancelada, need atendida e
      need com `remaining=0` rejeitadas; need com `remaining>0` aceita;
      quantity>remaining aceita; recebimento gera `need_fulfillment` com
      o mesmo `need_id` (ou `NULL`, quando a allocation não tinha need);
      `requiredRemaining` diminui de verdade após o recebimento; unidade
      incompatível gera `is_countable=false` preservando o vínculo;
      inconsistência hipotética entre as duas fontes nunca resolvida
      silenciosamente; mudança de status/remaining depois da criação não
      bloqueia o recebimento; FK composta bloqueada em SQL direto.
- [x] Validado de ponta a ponta no preview real: criada uma allocation
      manual vinculada à need "Parcial" (500kg necessários, 200kg já
      recebidos) via `/plataforma`, aceita e recebida via `/organizacoes/
      12/atribuicoes`, e confirmado na tela real de Necessidades que
      "Recebido pela rede" subiu de 200kg para 350kg e "Faltam" caiu de
      300kg para 150kg — o ciclo completo funcionando com dados reais do
      banco dev, nenhum mock. Desktop (800px/1280px) e mobile
      (375×812/390×844) verificados; nenhum overflow novo introduzido
      pelo seletor de need.
- [x] Suíte completa (312→328 testes) e `npx tsc --noEmit` confirmados
      sem regressão. `git diff --stat` de `opportunityMatching.tsx`,
      `allocations-receive_POST.ts`, `allocations-decide_POST.ts`,
      `reopenOpportunity.tsx`, `concludeOpportunity.tsx`,
      `expireReservations.tsx` e de todas as migrations/triggers do
      Modelo B e de `need_resolutions` permanece vazio.
- [ ] **Achado registrado, fora do escopo desta fase (pré-existente, não
      introduzido aqui)**: o diálogo "Atribuir: {título}" (e outros
      diálogos do projeto, confirmado no dashboard) tem um overflow
      horizontal em viewports estreitos (~375-390px) — o conteúdo do
      `DialogContent` excede seu próprio `max-width: 90vw`. Reproduzido
      ANTES do seletor de need renderizar (existia desde a Fase 41), não
      corrigido nesta fase por ser um problema estrutural do componente
      compartilhado `Dialog`/`Select`, não deste diálogo específico —
      registrado para uma fase dedicada de UI.

## Fase 46 — Varredura completa do ecossistema de capacidades (CONCLUÍDA — só inventário, read-only)

Inventário exaustivo de skills/plugins/MCPs/dependências/integrações
genuinamente disponíveis (vs. não-conectados/não-encontrados), sem
instalar/conectar/alterar nada. Confirmou `recharts`/`Chart.tsx` instalado
mas usado em zero páginas, ausência de `helmet`/CORS/ESLint/Prettier/
Dockerfile, presença/ausência de variáveis de ambiente sensíveis sem
nunca imprimir valores. Relatório entregue no chat, não neste arquivo.

## Fase 47 — Auditoria profunda de segurança, dependências e superfície de ataque (CONCLUÍDA — só auditoria, read-only)

`npm audit` real: 2 vulnerabilidades moderadas em `react-router`
(transitiva de `react-router-dom@6.30.6`), fix disponível é major bump,
não aplicado nesta fase. `security-review`/`dependency-doctor` tiveram
limitações de ambiente documentadas (sem `origin/HEAD` resolvível; sem
Python instalado) e foram substituídas por auditoria manual equivalente.
Maior achado: SEC-02 — `users.email` permitia duas identidades por
capitalização (`UNIQUE` case-sensível + login já normalizando com
`LOWER()`), confirmado por reprodução real em transação revertida.
Nenhum achado CRÍTICO/ALTO. Relatório completo (matriz de risco com 8
achados) entregue no chat, não neste arquivo. SEC-02 foi fechado na
Fase 48 abaixo; os demais (SEC-01/03/04/05/06/07/08) seguem registrados
para fases dedicadas futuras.

## Fase 48 — Correção de identidade de e-mail (CONCLUÍDA)

Fecha o achado SEC-02 da Fase 47.

- [x] Investigação prévia confirmou `register_with_password_POST.ts`
      como o ÚNICO produtor de linhas em `users` (busca exaustiva por
      `insertInto("users")` em todo `src/`) — convites nunca criam
      usuário, só `memberships`/`organization_invites`, e já comparam
      e-mail com `.toLowerCase()`/`LOWER()` em ambos os endpoints
      (criação e aceite), portanto já seguros por construção.
- [x] `SELECT LOWER(email), COUNT(*) ... HAVING COUNT(*) > 1` no banco de
      desenvolvimento antes da migration: **0 grupos duplicados, 0
      registros afetados** (nenhum valor de e-mail impresso).
- [x] `db/migrations/0013_users_email_case_insensitive.sql`: índice único
      funcional `idx_users_email_lower ON users (LOWER(email))` — mesmo
      padrão já usado em `idx_organization_invites_pending_unique`. O
      `UNIQUE(email)` case-sensível existente foi mantido (fica
      estruturalmente redundante, mas removê-lo não trazia benefício e
      não era o objetivo desta fase).
- [x] `register_with_password_POST.ts`: normaliza e-mail com
      `.toLowerCase()` (mesma regra já usada em login/convites — nenhuma
      normalização nova inventada) antes de checar duplicidade
      (`LOWER(email)`) e antes de persistir — o valor gravado em
      `users.email` passa a ser sempre minúsculo para contas novas.
      Captura `unique_violation` (código Postgres `23505`) na inserção e
      traduz para o mesmo 409 do caminho não-concorrente, em vez de um
      500 genérico — o SELECT prévio é só UX, a proteção real é o banco.
- [x] `login_with_password_POST.ts`: comentário adicionado documentando
      que o `LIMIT 1` sobre `LOWER(users.email)` deixou de depender de
      sorte (só uma linha pode bater agora); nenhuma lógica alterada.
- [x] 11 testes novos (`test/emailCaseInsensitive.test.ts`): cadastro
      aceita o primeiro e-mail e persiste normalizado; rejeita duplicata
      exata/minúscula/maiúscula; e-mail com espaço externo continua
      rejeitado por formato (nenhum trim introduzido, comportamento
      inalterado); login funciona com qualquer capitalização; INSERT
      direto com variante de case é rejeitado pela constraint (transação
      revertida); índice confirmado via `pg_indexes`; convite não cria
      usuário duplicado mesmo com capitalização diferente da conta já
      registrada; convite para e-mail inexistente não cria linha em
      `users`; duas requisições de cadastro concorrentes com o mesmo
      e-mail em capitalizações diferentes resultam em exatamente 1
      criada + 1 rejeitada (sem depender só do SELECT prévio).
- [x] Suíte completa (328→339 testes) e `npx tsc --noEmit` sem erros.
- [x] Central Visual real (desktop 961px + mobile 375×812): cadastro de
      `CentralVisual48@Teste.local`, tentativa de recadastro com
      `centralvisual48@teste.local` mostrando "Este e-mail já está
      cadastrado..." corretamente, e login bem-sucedido com
      `CENTRALVISUAL48@TESTE.LOCAL` (tudo maiúsculo) na mesma conta —
      sem overflow em nenhum dos dois tamanhos.
- [x] Não regressão: Modelo B, `need_resolutions`, Matching 1.4,
      `requiredRemaining`, RBAC e rate limiting não tocados — confirmado
      pela suíte completa e por `git diff --stat` restrito aos 3 arquivos
      de auth + schema.sql + a nova migration/teste.
- [ ] SEC-01/03/04/05/06/07/08 (achados restantes da Fase 47)
      permanecem fora do escopo desta fase, para fases dedicadas futuras.

## Fase 49 — Remediação controlada de SEC-01: upgrade do React Router (CONCLUÍDA)

Fecha o achado SEC-01 da Fase 47.

- [x] Investigação prévia: `npm audit` confirmou as duas vulnerabilidades
      moderadas (`GHSA-wrjc-x8rr-h8h6` open redirect, `GHSA-337j-9hxr-rhxg`
      injeção de construtor via SSR hydration) na faixa `>=6.0.0 <7.18.0`
      — ou seja, TODA a série 6.x é vulnerável (6.30.6, a instalada, é a
      última da série) e não existe patch 6.x que resolva; a única
      correção real exige `react-router-dom@7.18.0+`.
- [x] Mapeamento de uso real (`rg "react-router" src`): só
      `createBrowserRouter`/`RouterProvider`/`Outlet` (App.tsx),
      `Navigate` (ProtectedRoute.tsx), `useLocation`
      (ScrollToHashElement.tsx), `useNavigate`/`useParams`/`Link` (6
      páginas de organização + convites + formulários de auth). Projeto
      usa a API de "data router" em modo biblioteca (sem o plugin Vite
      `@react-router/dev`, sem loaders/actions/fetchers/Form, sem
      `useSearchParams`/`NavLink`, sem rota splat `*`) — exatamente as
      APIs que permanecem estáveis e sem mudança de assinatura entre v6 e
      v7. Nenhuma incompatibilidade real encontrada.
- [x] Upgrade: só `react-router-dom` `^6.28.0` → `^7.18.4` em
      `package.json` (React 18.3.1, Node 22/24 — ambos já compatíveis com
      os requisitos de v7). Nenhuma outra dependência tocada. Diff do
      lockfile mínimo: `@remix-run/router` removido (fundido no core do
      react-router em v7), `react-router`/`react-router-dom` → 7.18.4,
      2 dependências transitivas novas (`cookie`, `set-cookie-parser`,
      usadas internamente por APIs de SSR que este app CSR não exercita).
- [x] `npm audit` pós-upgrade: **0 vulnerabilidades** (nenhum residual).
- [x] Nenhuma alteração de código de rotas foi necessária — zero uso de
      API removida/depreciada entre v6 e v7 neste projeto.
- [x] Suíte de testes de backend inalterada (339/339, não exercita router
      de front-end) — sem infraestrutura de teste de componente no
      projeto (mesma situação já registrada na Fase 45), validação de
      rotas feita inteiramente via Central Visual real.
- [x] `npx tsc --noEmit` limpo. `npm run build` (`tsc -p tsconfig.json
      && vite build`) concluído com sucesso — aviso pré-existente de
      "chunk maior que 500kB" (bundle único, sem code-splitting), não
      introduzido por esta fase e fora de escopo corrigir aqui.
- [x] Central Visual real (desktop 961px + mobile 375×812): login,
      cadastro, logout, redirect de usuário não autenticado (`/` →
      `/login`), bloqueio RBAC de `/plataforma` para papel `user`
      (idêntico a antes), navegação por `Link` entre abas de organização,
      criação de organização via `useNavigate` para rota com parâmetro
      dinâmico (`/organizacoes/:organizationId`), refresh de rota pública
      e de rota autenticada aninhada (sessão e dados sobrevivem),
      voltar/avançar do navegador preservando o histórico corretamente,
      rota inexistente — tela de erro padrão do React Router
      ("Unexpected Application Error! 404 Not Found"), confirmada como
      comportamento IDÊNTICO ao de antes do upgrade (o projeto nunca
      configurou `errorElement` em nenhuma rota) — registrado como
      lacuna de UX pré-existente, não uma regressão desta fase.
- [x] Não regressão: RBAC (`AdminRoute`/`UserRoute` via
      `ProtectedRoute.tsx`) continua bloqueando por papel exatamente
      como antes — a proteção de rota é um componente de aplicação, não
      uma API do react-router, portanto o upgrade não tem nenhum caminho
      para alterá-la. Modelo B, Matching 1.4, RBAC de backend, rate
      limiting e auditoria não tocados (fora do escopo desta fase, nenhum
      arquivo desses no diff).
- [ ] Diagnóstico (não é correção desta fase): o pipeline de e-mail
      continua sem `trim()` em nenhum endpoint (confirmado na Fase 48) —
      registrado como possível hardening futuro, não alterado aqui.

## Fase 50 — Hardening HTTP e security headers (CONCLUÍDA)

Fecha o achado SEC-05 da Fase 47.

- [x] Investigação prévia: `server/index.ts` só serve `/_api/*` — nunca o
      HTML do cliente (documentado em `docs/DEPLOYMENT.md`, confirmado por
      busca: zero `express.static`/`dist/` no servidor). Inventário
      exaustivo de recursos externos (`rg "https?://"`): só Google Fonts
      (`@import` em `src/base.css`) é carregado pelo navegador;
      `api.anthropic.com` (`aiClient.tsx`) é usado exclusivamente pelo
      backend (confirmado: `opportunityMatching.tsx`, o único importador,
      nunca é importado por nenhuma página/componente). Zero iframe, zero
      WebSocket próprio, zero Worker, zero `data:`/`blob:`, zero `<img>`.
      `style={{...}}` inline encontrado em uso real (ex.:
      `AuthLoadingState.tsx`) + Radix UI (Dialog/Select/Popover/Tooltip,
      usado em todo o front-end) depende de `style` inline calculado em JS
      para posicionamento — evidência concreta que justifica
      `style-src 'unsafe-inline'` (nenhuma evidência equivalente para
      `script-src`: `dist/index.html` não tem nenhum `<script>` inline).
- [x] Centralizado em `src/helpers/securityHeaders.ts`: `API_SECURITY_
      HEADERS` (API), `DOCUMENT_CSP`/`DOCUMENT_CSP_WITH_FRAME_ANCESTORS`/
      `PERMISSIONS_POLICY` (documento HTML) — uma única fonte de verdade,
      sem duas cópias divergentes.
- [x] `server/index.ts`: `buildApp()` extraído de `main()` (testável sem
      abrir porta real nem iniciar o agendador); middleware de security
      headers como PRIMEIRO do pipeline; guarda de entrypoint ESM
      (`process.argv[1]` vs `import.meta.url`) para que importar `buildApp`
      em teste não dispare `main()`.
      **Achado de regressão descoberto e corrigido na própria fase**: o
      404 padrão do Express (`finalhandler`) sobrescrevia o
      `Content-Security-Policy` com um valor próprio mais curto (sem
      `frame-ancestors`) — corrigido com um handler 404 explícito que
      devolve JSON (consistente com o resto da API).
- [x] `vite.config.ts`: headers não-CSP aplicados também em dev
      (`server.headers`); CSP completa (com `frame-ancestors`, só possível
      como header HTTP real) aplicada em `preview.headers`; plugin próprio
      (`transformIndexHtml`) injeta a CSP como `<meta>` SÓ na build de
      produção (`ctx.server` ausente) — nunca no dev server, porque o
      preâmbulo inline do React Fast Refresh (confirmado via `curl` na
      resposta real do dev server) exigiria `'unsafe-inline'` em
      `script-src`. Novo config `"preview"` em `.claude/launch.json` (só
      local) para validar isso ao vivo via Central Visual.
- [x] 13 testes novos (`test/securityHeaders.test.ts`): valores exatos dos
      5 headers da API no health check, num endpoint de autenticação real
      (401) e em múltiplos endpoints; regressão do 404/finalhandler
      coberta explicitamente; conteúdo da CSP do documento testado
      diretiva por diretiva (script-src sem unsafe-inline/unsafe-eval,
      style-src com unsafe-inline+Google Fonts, connect-src só 'self' sem
      anthropic.com, object-src 'none', zero wildcard); Permissions-Policy
      testada por capacidade.
- [x] Suíte completa (339→352 testes), `npx tsc --noEmit` e `npm run
      build` sem erros (aviso pré-existente de bundle único >500kB,
      inalterado). `npm audit`: 0 vulnerabilidades, sem alteração (nenhuma
      dependência nova instalada).
- [x] Central Visual real contra a build de produção de verdade (`vite
      preview`, não o dev server — CSP completa de fato aplicada):
      login, cadastro, logout, dashboard, abas de organização
      (Visão geral/Inventário/Necessidades/Oportunidades), abertura de um
      Dialog real (Radix, prova que `unsafe-inline` em style-src
      funciona), bloqueio de `/plataforma` para papel `user`, fontes do
      Google carregando de verdade (`document.fonts` confirmando
      `status: "loaded"` para Fraunces/IBM Plex), zero mensagem de
      violação de CSP no console em toda a sessão. Mobile (375×812):
      dashboard, refresh de sessão autenticada — sem tela branca, sem
      quebra visual.
- [x] HSTS: deliberadamente NÃO configurado em código (nem API nem build)
      — este repositório não controla a camada que termina TLS em
      produção; registrado como dependência operacional explícita em
      `docs/DEPLOYMENT.md`, não fabricado.
- [x] Não regressão: Modelo B, Matching 1.4, RBAC, rate limiting,
      React Router e normalização de e-mail (Fase 48) não tocados —
      confirmado pela suíte completa e pelo diff restrito a
      `server/index.ts`, `vite.config.ts`,
      `src/helpers/securityHeaders.ts`, docs e o novo teste.
- [ ] SEC-03/04/06/07/08 (achados restantes da Fase 47) permanecem fora
      do escopo desta fase, para fases dedicadas futuras.

## Fase 51 — Hardening de autenticação: enumeração, timing e normalização (CONCLUÍDA)

Fecha SEC-03 e SEC-04 da Fase 47.

- [x] Superfície pública de autenticação mapeada por completo: só
      `register_with_password_POST` e `login_with_password_POST` aceitam
      e-mail de fonte não autenticada. `organization-invites-lookup_GET`
      é keyed por token aleatório (não por e-mail, não é oráculo de
      enumeração). `organization-invites_POST` exige sessão + permissão
      `membros.gerencie` (ameaça diferente — insider, não anônimo).
      Confirmado (de novo, como a Fase 47): nenhum endpoint de reset de
      senha/verificação de e-mail existe, oculto ou não.
- [x] **SEC-03 reproduzido**: cadastro com e-mail já existente respondia
      409 "Este e-mail já está em uso" — oráculo de enumeração público e
      direto. Estratégias A/B/C avaliadas explicitamente: B (confirmação
      assíncrona por e-mail) exigiria um fluxo de verificação que não
      existe (fora do escopo construir aqui); C (manter 409) rejeitada —
      a exposição não é aceitável nem compensada o bastante só pelo rate
      limit existente. Escolhida **Estratégia A**: resposta pública
      SEMPRE idêntica (200, mesma mensagem, nunca `Set-Cookie`), o que
      exigiu remover o login automático após cadastro (senão a PRESENÇA
      do cookie seria, sozinha, o sinal distinguível) — login continua
      existindo, só deixou de ser automático. Hash da senha calculado
      SEMPRE (mesmo quando o e-mail já existe, resultado descartado) para
      que o TEMPO de resposta não reabra o mesmo oráculo.
      `PasswordRegisterForm.tsx` atualizado (mensagem de sucesso única, só
      instrui a entrar); `convites.$token.tsx` ajustado para trocar para a
      aba "Entrar" automaticamente após o envio do cadastro (sem isso, a
      pessoa ficaria parada sem próximo passo óbvio).
- [x] **SEC-04 medido e confirmado** (não mais "possível, não
      reproduzido" como na Fase 47): script temporário, 150 amostras por
      cenário, uma conta nova por amostra (achado metodológico da própria
      medição: reusar o mesmo e-mail disparava o bloqueio por e-mail do
      próprio sistema depois de 5 tentativas, mascarando a diferença).
      Resultado antes da correção: usuário inexistente ~59ms mais rápido
      que senha incorreta (desvio-padrão <2ms nos dois lados — diferença
      real). Corrigido com hash bcrypt fixo pré-computado (mesmo custo —
      saltRounds 10 — de `generatePasswordHash.tsx`), comparado e
      descartado quando o e-mail não existe. Depois da correção:
      diferença de média 0.00ms. Script de medição removido após gerar o
      resultado (documentado no relatório da fase, não mantido como teste
      de CI — benchmark de latência é instável em CI compartilhado).
- [x] Normalização de e-mail: `z.string().email()` sozinho já rejeitava
      (nunca corrigia silenciosamente) e-mail com espaço externo, de forma
      já consistente entre cadastro/login/convite — não havia a
      inconsistência que a fase foi investigar. Decisão tomada mesmo
      assim: adotar `trim()` como regra canônica (friccão desnecessária
      para um erro de copiar/colar trivial), aplicado de forma
      SIMULTÂNEA nos três schemas (`register_with_password_POST.schema.ts`,
      `login_with_password_POST.schema.ts`,
      `organization-invites_POST.schema.ts`) — nunca só num deles.
      Diagnóstico no banco de desenvolvimento antes de decidir: 0 e-mails
      com espaço, 0 colisões novas depois de `LOWER(TRIM(email))`.
- [x] Rate limiting: confirmado que a unificação da resposta do cadastro
      não cria bypass — o limite de 10/hora/IP continua aplicado ANTES de
      qualquer lógica sensível ao e-mail, inalterado. Arquitetura do
      limitador (`rateLimit.tsx`) não tocada (SEC-07 continua para fase
      própria).
- [x] 11 testes novos (`test/authEnumeration.test.ts`: 5; mais os
      ajustados em `test/auth.test.ts` e `test/emailCaseInsensitive.test.ts`
      que passaram a checar resposta unificada em vez de 409): resposta
      idêntica para e-mail novo/existente no cadastro; cadastro nunca cria
      sessão; cadastro duplicado nunca sobrescreve senha/nome da conta
      original; login responde idêntico para usuário inexistente e senha
      errada; o hash-dummy nunca é confundido com senha real.
- [x] Suíte completa (352→357 testes), `npx tsc --noEmit`, `npm run
      build` e `npm audit` (0 vulnerabilidades, nenhuma dependência nova)
      sem erros.
- [x] Central Visual real (desktop + mobile): cadastro com e-mail novo
      (mensagem de confirmação, sem login automático), cadastro com
      e-mail já existente (mensagem IDÊNTICA), login em seguida com a
      senha definida, login com capitalização diferente, erro de senha
      incorreta, logout, fluxo de convite com cadastro (troca automática
      para a aba "Entrar").
- [x] Não regressão: Modelo B, Matching 1.4, RBAC, rate limiting, React
      Router, security headers/CSP (Fase 50) e a constraint
      case-insensitive de e-mail (Fase 48) não tocados — confirmado pela
      suíte completa e pelo diff restrito aos arquivos de autenticação.
- [ ] SEC-06/07/08 (achados restantes da Fase 47) permanecem fora do
      escopo desta fase, para fases dedicadas futuras.

## Fase 52 — Rate limiting e proteção contra abuso (CONCLUÍDA)

Fecha SEC-07 da Fase 47.

- [x] Inventário completo: 5 endpoints já protegidos (login 20/15min/IP +
      5/15min/e-mail; register 10/hora/IP; organization-invites-lookup
      30/hora/IP; organization-invites-create 20/hora/usuário;
      files-upload 30/hora/usuário). Achado real: `account-delete`
      comparava senha via bcrypt SEM nenhum rate limit — único gap
      encontrado na varredura "qualquer endpoint com bcrypt".
- [x] IP/proxy testado contra um servidor Express real (não só o helper
      isolado): sem `TRUST_PROXY` (padrão), 11 requisições com
      `X-Forwarded-For` forjado e diferente a cada vez continuam
      compartilhando o mesmo contador — spoofing não funciona. Com
      `TRUST_PROXY=1` configurado explicitamente, as mesmas 11
      requisições recebem contadores independentes — comportamento
      correto só quando há um proxy real confiável na frente. Nenhuma
      confiança ampla (`trust proxy: true`) foi adicionada.
- [x] Concorrência confirmada sem race condition: 50 requisições de
      cadastro disparadas via `Promise.all` contra o mesmo IP, servidor
      real — exatamente 10 permitidas, 40 bloqueadas, nunca excedente.
      Explicado pela ausência de `await` dentro da seção crítica de
      `checkRateLimit` (roda síncrona do início ao fim).
- [x] Multi-processo confirmado como limitação real (não hipotética):
      dois processos `tsx server/index.ts` reais em portas diferentes,
      atacados pela MESMA origem real — processo A bloqueou na 11ª
      tentativa, processo B aceitou a sua livremente. Contadores
      totalmente independentes entre processos, como já documentado,
      agora com prova empírica.
- [x] Decisão de arquitetura: manter o limiter em memória. Deployment
      real hoje é genuinamente um único processo (`docs/DEPLOYMENT.md`);
      trocar para Postgres/Redis agora adicionaria uma consulta extra em
      todo hot path sensível sem nenhum ganho de correção na topologia
      atual. Threshold documentado para revisitar: quando a
      infraestrutura de produção definir mais de uma instância.
- [x] Cadastro + bcrypt (preocupação específica pós-Fase 51): confirmado
      que o limite de IP é checado ANTES de qualquer hash — a 11ª
      tentativa de cadastro nunca paga o custo de bcrypt, seja e-mail
      novo ou repetido. 10/hora/IP já contém o custo total em no máximo
      10 hashes por IP por hora.
- [x] `account-delete_POST.ts`: adicionado rate limit (5/15min, por
      usuário autenticado — não por IP, já que o atacante aqui já estaria
      autenticado via sessão comprometida).
- [x] 5 testes novos (`test/rateLimitHardening.test.ts`: 4, contra um
      servidor Express real via `buildApp()`; mais 1 em
      `test/accountDelete.test.ts`): resistência a spoofing sem
      TRUST_PROXY; TRUST_PROXY honrando X-Forwarded-For corretamente;
      concorrência sem excedente; 429 do cadastro nunca revela se o
      e-mail já existia (continuidade de SEC-03); bloqueio de
      account-delete após 5 tentativas.
- [x] Suíte completa (357→362 testes), `npx tsc --noEmit`, `npm run
      build` e `npm audit` (0 vulnerabilidades, nenhuma dependência nova)
      sem erros.
- [x] Central Visual real (desktop + mobile): login até 429, cadastro,
      cadastro repetido, logout — sem tela branca, sem overflow, sem
      redirect inesperado.
- [x] Não regressão: Modelo B, Matching 1.4, RBAC, React Router, security
      headers/CSP (Fase 50), identidade de e-mail (Fase 48) e a
      mitigação de timing/enumeração (Fase 51) não tocadas — confirmado
      pela suíte completa e pelo diff restrito a `account-delete_POST.ts`,
      docs e os dois novos arquivos de teste.
- [ ] SEC-06/08 (achados restantes da Fase 47) permanecem fora do escopo
      desta fase, para fases dedicadas futuras.

## Fase 53 — Verificação periódica da audit hash-chain (CONCLUÍDA)

Fecha SEC-06 da Fase 47.

- [x] Mapeamento completo: tabela `audit_log`, campos `event_hash`/
      `previous_event_hash`, SHA-256, ordenação por `id` (confirmado — não
      por `created_at`), hash cobre
      organizationId/actorUserId/action/entityType/entityId/metadata
      (stableStringify)/createdAt/previousEventHash, advisory lock de
      TRANSAÇÃO (`pg_advisory_xact_lock(hashtext(...))`) na escrita,
      verificador canônico já existente (`verifyAuditLogChain`), já
      exposto sob demanda (`GET /audit-log-verify`). Scheduler já
      centralizado (`scheduler.tsx`+`scheduled-jobs.json`+
      `TASK_HANDLERS`+`node-cron`) e mecanismo de registro operacional já
      existente (`background_task_runs`+`claimTaskRun`/`finishTaskRun`/
      `failTaskRun`) e de exclusão mútua multi-processo já existente
      (`withScheduledTaskLock`, advisory lock de SESSÃO) — tudo
      encontrado e reutilizado, nada criado do zero.
- [x] Custo medido: recomputar 100.000 eventos sintéticos (hash+stringify)
      levou 377ms (~0,0038ms/evento). Verificação real contra o banco de
      teste: poucos ms. Frequência escolhida (6 em 6 horas) não é
      limitada por custo — é um intervalo operacional razoável para uma
      verificação interna sem urgência de detecção em tempo real.
- [x] `src/helpers/verifyAuditChainTask.tsx` (novo): reusa
      `verifyAuditLogChain` sem nenhuma segunda implementação. Registrado
      em `TASK_HANDLERS`, `SCHEDULED_TASK_LOCK_IDS` (objid 5) e
      `scheduled-jobs.json` (`0 */6 * * *`, UTC) — três pontos de
      integração mínimos na infraestrutura já existente, nenhuma tabela
      nova, nenhum mecanismo de lock novo.
- [x] Três resultados nunca confundidos: `integrity_valid`
      (`finishTaskRun`, status "concluida"); `integrity_invalid`
      (`failTaskRun` DE PROPÓSITO — reaproveita a rotina operacional já
      documentada "revisar background_task_runs com status=falhou" e o
      painel admin já existente em `plataforma.tsx`, sem nenhuma UI nova);
      `verification_error` (`failTaskRun` do catch externo, erro de
      infraestrutura, nunca confundido com corrupção real — provado com
      teste que mocka uma exceção e confirma `error.kind` diferente dos
      dois outros casos). `failTaskRun` ganhou um parâmetro opcional
      `extra` (aditivo, nenhum dos 4 chamadores existentes precisou
      mudar) para anexar `kind`/`divergencias`/contagens estruturadas.
      Nunca escreve o resultado de volta em `audit_log` (evitaria
      arquitetura circular — contaminar a cadeia que acabou de ser
      considerada possivelmente comprometida).
- [x] 9 testes novos: 4 em `test/auditChain.test.ts` (caso 2 — hash atual
      isolado; caso 3/6 — predecessor forjado mas internamente
      consistente; caso 4 — conteúdo divergente do hash; caso 5 — DELETE
      estruturalmente bloqueado pelo trigger, não "simulável" porque
      genuinamente impossível); 2 em `test/verifyAuditChainTask.test.ts`
      (tarefa com cadeia íntegra/corrompida, verificador real); 2 em
      `test/verifyAuditChainTaskMocked.test.ts` (erro de infraestrutura
      distinto de corrupção; concorrência real — duas chamadas
      simultâneas, só uma chama o verificador, provado contando
      invocações do mock).
- [x] Suíte completa (362→370 testes), `npx tsc --noEmit`, `npm run
      build` e `npm audit` (0 vulnerabilidades, nenhuma dependência nova
      — `node-cron` já existia) sem erros.
- [x] Validado contra o banco de desenvolvimento REAL (não só o de
      teste): tarefa executada manualmente, resultado
      `{kind: "integrity_valid", totalEventos: 39, eventosVerificados:
      26, eventosPreExistentesSemHash: 13, duracaoMs: 3}` gravado em
      `background_task_runs`, visível no painel "Tarefas de fundo" real
      de `/plataforma` (desktop + mobile, sem overflow) — zero UI nova
      necessária, o painel já existia.
- [x] Não regressão: Modelo B, Matching 1.4, RBAC, rate limiting, React
      Router, security headers/CSP, identidade de e-mail, mitigação de
      timing/enumeração não tocadas — confirmado pela suíte completa e
      pelo diff restrito aos arquivos listados acima.
- [ ] SEC-08 (achado restante da Fase 47) permanece fora do escopo desta
      fase, para uma fase dedicada futura.

## Fase 54 — CI security gates e reprodutibilidade (CONCLUÍDA)

Fecha SEC-08 da Fase 47 — o último achado da auditoria de segurança
original.

- [x] Auditoria do pipeline existente: checkout + Node 22
      (`actions/setup-node@v4`, cache npm) + `npm ci` + typecheck + testes
      — sem build, sem `npm audit`, sem lint, sem `permissions:` explícito.
      Confirmado lendo `.github/workflows/ci.yml` diretamente, não
      presumido das fases anteriores.
- [x] `npm ci` já era usado (reprodutibilidade confirmada: rodado
      localmente com sucesso, 0 vulnerabilidades). `npm run build`
      confirmado sem exigir NENHUMA variável de ambiente (testado com
      `env -i`, ambiente completamente limpo).
- [x] `engines.node: "22.x"` adicionado a `package.json` — mesma versão
      já usada pelo CI, agora declarada no projeto como fato único (antes
      só existia dentro do YAML).
- [x] `.github/workflows/ci.yml`: adicionados `permissions: contents:
      read` (menor privilégio — o workflow só lê e roda scripts, nunca
      escreve no repositório), step `Build` (`npm run build`) e step
      `Dependency audit` (`npm audit --audit-level=moderate` — política
      de severidade deliberada e documentada: moderate+ bloqueia, low/info
      não). Ordem final: `npm ci → typecheck → testes → build → audit`.
- [x] `security-review` avaliado para CI e descartado por motivo técnico
      concreto (não achado/limitação genérica): é uma skill do Claude
      Code, não um binário/script invocável por um `run:` do GitHub
      Actions — não existe caminho de automação determinístico para ela
      neste ambiente. `npm audit` continua como o gate determinístico de
      segurança de dependências.
- [x] Lint investigado e confirmado ausente (zero config ESLint, zero
      script `lint`, zero dependência) — não instalado, conforme
      instrução explícita de não transformar esta fase numa reforma geral
      do projeto.
- [x] Os 4 gates testados de propósito, não só "YAML parece correto":
      erro de tipo introduzido temporariamente em
      `src/helpers/rateLimit.tsx` (typecheck falhou, exit code 2,
      revertido); assertion falsa introduzida em
      `test/rateLimit.test.ts` (teste falhou, exit code 1, revertido);
      erro de sintaxe introduzido em `src/App.tsx` (build falhou, exit
      code 2, revertido); gate de audit provado com uma fixture ISOLADA
      fora deste repositório (nunca tocando o lockfile real), fixando
      `react-router-dom@6.28.0` (conhecidamente vulnerável) — `npm audit
      --audit-level=moderate` retornou exit code 1 ali. Todos os 4
      reverted e confirmados limpos de novo depois.
- [x] CI remoto: **não executado nesta sessão** (nenhum push realizado —
      registrado honestamente, não fingido). Os comandos exatos do
      workflow foram validados localmente, incluindo os 4 testes de
      falha acima.
- [x] Suíte completa (370 testes, sem alteração — fase não mexeu em
      código de aplicação), `npx tsc --noEmit`, `npm run build` e
      `npm audit --audit-level=moderate` (0 vulnerabilidades) sem erros.
- [x] Central Visual mínima (fase é CI, não UI): login e dashboard
      carregando normalmente depois das alterações de configuração —
      nenhuma UI nova criada.
- [x] Não regressão: Modelo B, Matching 1.4, RBAC, rate limiting, React
      Router, security headers/CSP, identidade de e-mail, mitigação de
      timing/enumeração, hash-chain não tocadas — único ponto de
      integração foi o workflow de CI e `package.json#engines`.

**Com isto, todos os 8 achados da auditoria de segurança da Fase 47
(SEC-01 a SEC-08) foram endereçados** — SEC-01 (Fase 49), SEC-02 (Fase
48), SEC-03/04 (Fase 51), SEC-05 (Fase 50), SEC-06 (Fase 53), SEC-07
(Fase 52), SEC-08 (esta fase). SEC-02 foi na verdade a Fase 48 em si
(identidade de e-mail), não um item separado da lista original.

## Fase 55 — Auditoria de prontidão para produção (CONCLUÍDA — só diagnóstico/documentação)

Fecha o ciclo das Fases 47–54 com uma pergunta diferente: não "o código
tem uma vulnerabilidade?", mas "o que falta para hospedar isto de
verdade?". Nenhum deploy, nenhuma infraestrutura contratada, nenhum
código de aplicação alterado — só investigação e um documento novo.

- [x] `docs/PRODUCTION_READINESS.md` criado (22 seções): arquitetura
      runtime completa, frontend, API, Postgres/migrations, scheduler
      (multi-processo já seguro via advisory lock — confirmado, não
      presumido), storage, e-mail, IA, matriz de secrets (12 variáveis,
      presença/ausência sem valores), TLS/proxy (`TRUST_PROXY` —
      depende da topologia real, nunca `true` cego), rate limiting
      (limitação multi-processo documentada com threshold explícito),
      backup/restore (ausente — acha real, não fabricado), observabilidade,
      health checks (`/_api/__health` é só liveness, não verifica
      Postgres — achado real), graceful shutdown (ausente — confirmado
      por busca exaustiva, zero `process.on("SIGTERM"/"SIGINT")`),
      escalabilidade, CI/CD (CD não existe e não foi implementado aqui),
      bloqueadores reais (3: camada estática do frontend indefinida,
      backup nunca testado, TLS não decidido — autenticação por cookie
      `Secure` não funciona sem HTTPS real), decisões pendentes, e itens
      explicitamente adiáveis para pós-MVP.
- [x] Nenhuma infraestrutura nova instalada, nenhum provedor escolhido,
      nenhum dado real usado — confirmado pelo próprio conteúdo do
      documento (cada item tem uma classificação objetiva, nunca "parece
      pronto").
- [x] Suíte completa (370 testes, inalterada — fase não tocou código de
      aplicação), `npx tsc --noEmit`, `npm run build` e
      `npm audit --audit-level=moderate` sem erros.
- [x] Central Visual (smoke test, conforme pedido pela fase): login,
      dashboard, uma rota autenticada de organização — tudo carregando
      normalmente, nenhuma UI nova criada.
- [x] Não regressão: nenhum arquivo de domínio (Modelo B, Matching,
      needs, stock, RBAC, autenticação, rate limiter, audit chain, React
      Router, CSP, CI, migrations históricas) tocado — o único arquivo
      novo é o próprio documento.

## Fase 56 — Arquitetura-alvo de produção (CONCLUÍDA)

Transforma o diagnóstico da Fase 55 numa decisão concreta. Nenhum deploy
real feito; uma mudança de código pequena e diretamente justificada pela
arquitetura escolhida.

- [x] Arquitetura decidida: **Alternativa B** — nginx same-origin
      (serve `dist/` com fallback de SPA + proxy reverso de `/_api/*`
      para o Express) + Postgres gerenciado. Comparada explicitamente
      contra origens separadas (CDN+API em domínios diferentes) —
      rejeitada por exigir CORS novo (hoje zero) e por forçar revisão da
      análise de CSRF já fechada em `docs/SECURITY.md`, sem nenhum
      ganho técnico que compense no estágio atual.
      `TRUST_PROXY=1` (exatamente 1 salto — o nginx). Express nunca
      exposto diretamente à internet (só `127.0.0.1`/rede interna).
- [x] **Graceful shutdown implementado** (único ponto de código desta
      fase, diretamente exigido pela arquitetura escolhida — systemd/
      orquestrador envia SIGTERM a cada deploy): `server/index.ts`
      (handlers SIGTERM/SIGINT, `server.close()` com timeout de 10s) +
      `closeDbPool()` novo em `db.tsx` (fecha o pool do `postgres`
      de verdade). Verificado com o processo real rodando: o handler
      dispara, `server.close()` e `closeDbPool()` completam sem erro.
      **Limitação de ambiente registrada explicitamente**: entrega de
      SIGTERM entre processos diferentes não é testável de forma
      confiável no Windows (libuv não suporta SIGTERM nativo nessa
      plataforma) — verificado via `process.emit` no mesmo processo
      (prova a lógica do handler) e documentado que o destino real de
      produção é Linux, onde SIGTERM é nativo e este é o padrão
      universal do Express/Node.
- [x] Storage: disco local com volume persistente aceito para o
      lançamento inicial (single-instance); gatilho de migração para S3
      documentado explicitamente (adapter já existe, zero código novo
      quando chegar a hora).
- [x] Rate limiting: mantido em memória — decisão explícita de que a
      arquitetura escolhida (1 processo) não justifica Redis/Postgres
      agora; gatilho de migração documentado.
- [x] Backup/restore: único item classificado como bloqueador real sem
      nenhuma mitigação parcial — frequência/retenção/RPO/RTO/teste de
      restauração definidos como requisitos obrigatórios, nada
      implementado (depende do provedor).
- [x] `docs/PRODUCTION_READINESS.md` ganhou a seção "Arquitetura-alvo de
      produção": matriz consolidada, comparação de alternativas, 15
      subseções (frontend/API/Postgres/storage/scheduler/rate limiting/
      secrets/headers/TRUST_PROXY/cookies/e-mail/IA/health/shutdown/
      backup/CI-CD/deploy order/rollback/observabilidade/ambientes) e
      diagrama final — nenhum componente crítico ficou "indefinido".
- [x] Suíte completa (370 testes, inalterada), `npx tsc --noEmit`,
      `npm run build` e `npm audit --audit-level=moderate` sem erros.
- [x] Central Visual (smoke test): login, dashboard, rota autenticada de
      organização — tudo carregando normalmente.
- [x] Não regressão: Modelo B, Matching, needs, stock, RBAC,
      autenticação, rate limiter (lógica), audit chain, React Router,
      CSP, CI, migrations históricas não tocados — único código alterado
      foi o shutdown gracioso, diretamente justificado pela arquitetura
      escolhida nesta mesma fase.

## Fase 57 — Backup, restore e recuperação do PostgreSQL (CONCLUÍDA)

Fecha o único bloqueador real identificado nas Fases 55/56. Nenhum dado
de produção usado — tudo contra o banco de desenvolvimento, num banco de
teste separado (`levora_solidaria_restore_test`), descartado ao final.

- [x] Inventário: Postgres 16.15, 26 tabelas, 22 triggers, 71 índices,
      276 constraints, 23 sequences, 2 extensões (`pgcrypto`/`plpgsql`),
      3 funções próprias da aplicação. **Achado real corrigido**:
      `schema_migrations` tinha só 12/13 migrations rastreadas — `0013`
      (Fase 48) foi aplicada via `psql -f` direto na época e nunca
      registrada, apesar de seus efeitos estarem corretos no schema.
      Corrigido inserindo a linha faltante (investigado antes de
      modificar, como pedido pela fase).
- [x] Formato escolhido: `pg_dump -Fc -Z 6` (custom, comprimido) — tabela
      de comparação contra plain SQL documentada em
      `docs/DATABASE_RECOVERY.md`.
- [x] Backup real executado (142.386 bytes, 279ms), integridade
      verificada (tamanho, SHA-256, `pg_restore --list` sem tocar no
      banco).
- [x] Restore real num banco separado (599ms) — estrutura idêntica ao
      original em TODOS os itens comparados (contagem exata, não
      estimativa — achado: `pg_stat_user_tables.n_live_tup` estava
      desatualizado neste ambiente, `COUNT(*)` real usado em seu lugar).
- [x] Validação funcional real: trigger append-only rejeitou um `DELETE`
      de verdade contra o banco restaurado; `verifyAuditLogChain()` (o
      verificador canônico, não uma reimplementação) confirmou
      `integra: true`; aplicação real (servidor+cliente) apontada
      temporariamente para o banco restaurado (nunca o `.env` editado)
      validada via Central Visual — login, dashboard, organização,
      painel de tarefas de fundo, desktop + mobile.
- [x] Tempo medido (não estimado): banco+restore+validação estrutural
      1.250ms; aplicação pronta (health check) +2.110ms — **≈3,4s
      total**, com a ressalva explícita de que isso não inclui
      provisionar um Postgres novo do zero (não exercido, nenhuma
      infraestrutura contratada).
- [x] RPO/RTO/retenção/criptografia/PITR documentados com justificativa
      (PITR avaliado e conscientemente adiado — backup diário já cumpre
      a meta de RPO≤24h para o volume atual).
- [x] `docs/DATABASE_RECOVERY.md` criado (21 seções: inventário, formato,
      backup, integridade, restore, validação estrutural/funcional,
      audit chain, tempo, RPO, RTO, retenção, criptografia, storage
      independente, PITR, disaster recovery, migrations pós-restore,
      backup≠audit-chain, failure modes, storage de uploads, requisitos
      do provedor, checklist repetível).
      `docs/PRODUCTION_READINESS.md` atualizado (bloqueador de backup
      fechado, matriz consolidada e bloqueadores reais revisados).
- [x] Suíte completa (370 testes, inalterada — fase não tocou código de
      aplicação, só um dado de bookkeeping no banco de desenvolvimento),
      `npx tsc --noEmit`, `npm run build` e `npm audit --audit-level=moderate`
      sem erros.
- [x] Não regressão: nenhum arquivo de domínio tocado — o único "código"
      alterado nesta fase foi uma correção de dado (`schema_migrations`)
      no banco de desenvolvimento, não um arquivo versionado.

## Fase 58 — Pacote de deploy e provisionamento reprodutível (CONCLUÍDA)

Transforma a arquitetura das Fases 56/57 num procedimento de instalação
concreto, validado de verdade contra um servidor Linux limpo (container
Docker real) — nenhum deploy real, domínio real ou certificado real
usado, como pedido pela fase.

- [x] **Achado real 1 — `npm run build:server` nunca tinha funcionado**:
      executado de verdade pela primeira vez nesta fase (a CI só roda
      `npm run build`, o front-end), deu 535 erros em 109 arquivos —
      `tsconfig.server.json` (NodeNext) exige extensão `.js` explícita em
      imports relativos, nenhum arquivo do projeto tinha isso, e o
      `include` varria hooks de front-end (`useScrollReveal.tsx` etc.) e
      dois arquivos nunca usados (`connectorsManual.tsx`,
      `connectorsTypes.tsx`). Corrigido: `.js` adicionado a 403
      especificadores em 103 arquivos reais do backend; os 7 arquivos de
      front-end/não usados excluídos explicitamente do
      `tsconfig.server.json`. Build limpo depois, suíte de 370 testes e
      `npx tsc --noEmit` inalterados.
- [x] **Achado real 2 — `tsx` só em `devDependencies`**: as migrations
      oficiais (`db:migrate`, `db:migrate:incremental`, `db:seed`) chamam
      `tsx` direto; um `npm ci --omit=dev` de produção real não o
      instalaria. Corrigido movendo `tsx` para `dependencies`; validado
      de verdade com `npm ci --omit=dev` dentro de um container Linux.
- [x] **Achado real 3 — agendador sem config no build compilado**:
      `scheduler.tsx` lê `scheduled-jobs.json` via `fs`, relativo ao
      próprio `__dirname` — `tsc` nunca copia esse arquivo, então o build
      compilado rodava sem nenhuma tarefa agendada. Corrigido com
      `scripts/copy-server-assets.cjs`, chamado por `build:server`.
      Confirmado rodando o build real: 5 tarefas registradas.
- [x] **Achado real 4 — descoberta de endpoints só reconhecia `.ts`**:
      rodando o servidor compilado de verdade por trás, o log mostrou
      "Descobertos 0 endpoints" — o regex de descoberta em
      `server/index.ts` nunca casava `.js`. Um deploy real antes desta
      correção teria subido saudável (health check OK) e completamente
      sem nenhuma rota de API — falha silenciosa grave. Corrigido;
      confirmado 54 endpoints descobertos e uma chamada real (sessão)
      respondendo corretamente contra o Postgres.
- [x] Migração em banco novo, do zero, só via mecanismo oficial, testada
      de verdade em container Linux: 26/26 tabelas, 13/13 migrations.
      Confirmado que `db:migrate:incremental` sozinho falha num banco
      vazio (depende de `db:migrate` ter rodado primeiro) — documentado
      como comportamento esperado, não um bug.
- [x] SIGTERM real entre processos, em Linux, pela primeira vez nesta
      sessão (a Fase 56 só validou no mesmo processo, por limitação do
      Windows): `docker stop` → log de encerramento gracioso em ~0,4s.
- [x] `TRUST_PROXY=1` validado através de nginx real pela primeira vez
      (a Fase 52 só tinha testado contra o Express isolado): 25
      requisições com `X-Forwarded-For` forjado e diferente a cada vez,
      através de nginx real, todas no mesmo bucket de rate limit —
      resistência a spoofing confirmada com a topologia completa.
- [x] `deploy/nginx.conf` (SPA fallback, proxy `/_api/*`, CSP/HSTS de
      referência, cache de assets com hash vs. `index.html`) — validado
      com `nginx -t` real.
- [x] `deploy/levora-api.service` (usuário dedicado, `EnvironmentFile`,
      `Restart=on-failure`, `TimeoutStopSec` compatível com o shutdown
      gracioso da Fase 56) — validado com `systemd-analyze verify`.
- [x] `.env.example` revisado contra todo `process.env.*` real do
      backend — sem lacunas, nenhuma alteração necessária.
- [x] `docs/DEPLOYMENT_RUNBOOK.md` criado (16 seções: pré-requisitos,
      provisionamento, instalação, secrets, PostgreSQL, migrations,
      build, Nginx, Express/systemd, TLS, health check, backup,
      rollback, troubleshooting, restore — mais checklist operacional).
      `docs/PRODUCTION_READINESS.md` atualizado com o estado do pacote de
      deploy e a atualização dos bloqueadores reais.
- [x] Central Visual contra a build de produção real (`dist/` via `vite
      preview`, mesmo proxy same-origin que o nginx real fará) + backend
      compilado real: login, cadastro, dashboard, rota de convite
      inválido (fallback de SPA), desktop e mobile — sem erro de CSP,
      fonte ou asset no console.
- [x] Checagem de segurança contra o ambiente de referência (não um
      pentest completo): CSP/`frame-ancestors`/`X-Frame-Options` no
      documento, cookie de sessão com `HttpOnly`/`Secure`/`SameSite=Lax`
      já corretos (sem alteração necessária), API nunca exposta
      diretamente (só via proxy nginx), `TRUST_PROXY=1` resistente a
      spoofing (ver acima).
- [x] CI re-confirmada sem alteração ampla: `npm run typecheck`,
      `npm test` (370 testes), `npm run build`,
      `npm audit --audit-level=moderate` (0 vulnerabilidades) — todos
      rodados de novo depois de todas as correções desta fase.
- [x] Ambiente Linux de validação (containers Docker descartáveis:
      backend compilado + nginx real) totalmente desmontado ao final —
      nenhum container, imagem ou banco de teste desta fase ficou
      residente.

## Fase 59 — Qualificação final do artefato de produção (CONCLUÍDA)

Reproduz o procedimento da Fase 58 do zero, num segundo ambiente Linux
totalmente independente (rede Docker nova, imagem base diferente,
Postgres novo, nenhum arquivo reaproveitado) — prova que o resultado não
dependeu do container específico da fase anterior. Nenhum deploy real.

- [x] Build (frontend + backend) reproduzido do zero, hashes idênticos.
- [x] `npm ci --omit=dev` + `npm start`/`node` direto confirmados sem
      nenhuma instalação manual, em imagem `bullseye` nova (diferente da
      `bookworm` da Fase 58).
- [x] Server import closure: confirmado que nenhum dos 7 arquivos de
      front-end excluídos de `tsconfig.server.json` é referenciado, direta
      ou dinamicamente, por nenhum arquivo real do backend.
- [x] Descoberta de endpoints: 54 arquivos no código-fonte = 54 no build
      compilado = 54 descobertos em runtime, diff vazio.
- [x] Endpoints críticos testados através do router real (não um atalho):
      registro, login, sessão, organizações, logout, needs, opportunities,
      inventory-items, platform-organizations (403 corretamente para
      usuário comum), background-tasks (403), health. Validação Zod e
      autorização por papel confirmadas funcionando de ponta a ponta.
- [x] Scheduler confirmado carregado no build compilado (5 tarefas).
- [x] Banco novo do zero via mecanismo oficial, reconfirmado
      independentemente: 26 tabelas, 13/13 migrations (`0013` incluída).
- [x] Restore real de um novo backup + `verifyAuditLogChain()` canônico
      contra o banco restaurado: `integra: true`. Backend compilado
      iniciado contra o banco restaurado com sucesso.
- [x] **Achado real 1 — `deploy/nginx.conf` vazava headers do documento
      para `/_api/*`**: `add_header` no nível do `server{}` era herdado
      pela location do proxy, duplicando o `Content-Security-Policy` do
      Express. Corrigido: headers do documento movidos para dentro de
      `location = /index.html` e `location /` apenas. Reconfirmado sem
      duplicação.
- [x] **Achado real 2 — `npm start` nunca deve ser o `ExecStart`**:
      testado isoladamente, `npm start` não repassa SIGTERM de forma
      confiável ao processo Node filho (log mostrava `npm error signal
      SIGTERM`, sem nenhuma linha de encerramento gracioso).
      `deploy/levora-api.service` já chamava `node` diretamente desde a
      Fase 58 — mas essa escolha agora tem evidência real, não só
      convenção. Com `node` direto: SIGTERM funcionou (~0,3s, saída
      limpa).
- [x] Achado de processo: validar nginx só com `curl` não detecta
      `mime.types` ausente — só um Central Visual real (navegador, não
      `curl`) expôs que o JavaScript viria como `text/plain` nessa
      condição. Nota adicionada em `deploy/nginx.conf`.
- [x] Rate limiting + `TRUST_PROXY=1` reconfirmados através do nginx
      real (já corrigido): 25 requisições com `X-Forwarded-For` forjado
      e diferente a cada vez, mesmo bucket de rate limit.
- [x] Restart limpo confirmado: banco íntegro, scheduler, 54 endpoints e
      configuração todos de volta depois de `stop`/`start`.
- [x] Environment sanitization: nenhum path absoluto de ambiente de dev
      hardcoded no backend; referências a `localhost` são fallbacks
      documentados e substituíveis por variável de ambiente.
- [x] `package.json` auditado: nenhuma dependência duplicada entre
      `dependencies`/`devDependencies`, lockfile consistente
      (`npm ls --depth=0` sem erro).
- [x] CI re-confirmada (`typecheck`, 370 testes, `build`,
      `npm audit --audit-level=moderate`, `build:server`) — `build:server`
      avaliado como estável e determinístico nesta fase (dois ambientes
      Linux independentes, resultado idêntico), mas **não adicionado à
      CI automaticamente** nesta fase, por decisão explícita do escopo.
- [x] Central Visual completo através da topologia real (nginx + backend
      compilado + Postgres novo): login, cadastro, dashboard, mobile —
      sem erro de CSP/fonte/asset depois das correções.
- [x] `docs/DEPLOYMENT_RUNBOOK.md` e `docs/PRODUCTION_READINESS.md`
      atualizados com os dois achados reais e a tabela de requalificação.
- [x] Ambiente de validação (containers, rede, imagem Docker, arquivos de
      scratch) totalmente desmontado ao final.

## Fase 60 — Seleção e validação da infraestrutura de produção (CONCLUÍDA)

Sai da arquitetura abstrata (Fases 56–59) para a seleção factual de
fornecedores reais para o primeiro ambiente de produção/staging. Pesquisa
feita em 01/10/2026 direto nos sites/documentação oficiais de cada
provedor. Nenhuma conta criada, nenhum domínio registrado, nenhum deploy
real.

- [x] Requisitos extraídos só da documentação já existente (Fases 55–59),
      nenhum inventado: Linux, nginx, Node 22.x, HTTPS, Postgres 16+,
      `sslmode=require`, backup com retenção ≥30 dias, RPO≤24h, RTO≤4h,
      volume persistente, rede privada quando suportada, Postgres nunca
      exposto diretamente.
- [x] VPS pesquisados com preço/specs reais e atuais: Hetzner Cloud
      (CPX22: 2vCPU/4GB/80GB/20TB, €19,99/mês) e DigitalOcean (Basic
      Droplet: 2vCPU/4GB/80GB/4TB, US$24/mês).
- [x] PostgreSQL gerenciado pesquisado: DigitalOcean Managed PostgreSQL
      (US$15,15/mês, VPC gratuita com o Droplet), Neon (pay-as-you-go,
      ~US$19-22/mês sem scale-to-zero), Supabase (US$25/mês Pro).
      **Achado real**: Hetzner não oferece PostgreSQL gerenciado —
      qualquer VPS Hetzner exigiria um provedor de banco separado, sem
      VPC, só `sslmode=require` pela internet pública.
- [x] **Achado real central**: nenhum dos três provedores de PostgreSQL
      pesquisados cumpre sozinho a retenção ≥30 dias já exigida pelo
      próprio projeto (Fase 57) — todos oferecem só 7 dias de backup/PITR
      nativo no plano de entrada (Supabase precisaria do plano Team,
      US$599/mês, para chegar a 14 dias, ainda assim menos que 30). O
      procedimento `pg_dump`/`pg_restore` já validado na Fase 57 continua
      sendo a camada que garante os 30 dias, qualquer que seja o provedor.
- [x] DNS (Cloudflare, grátis) e TLS (Let's Encrypt, já referência desde
      a Fase 58) confirmados sem custo e sem amarração a um único
      provedor de VPS.
- [x] Storage de backup independente pesquisado: Hetzner Storage Box
      (1TB, €3,20/mês, SFTP/rsync — encaixa direto no `pg_dump` da Fase
      57) e DigitalOcean Spaces (250GB, US$5/mês, S3-compatível).
- [x] Duas topologias concretas comparadas (não ranqueadas por opinião,
      só por custo e aderência aos requisitos já documentados): mesmo
      provedor (DigitalOcean) com rede privada via VPC vs. provedores
      cruzados (Hetzner + Neon) sem rede privada — custo mensal
      equivalente (~US$44-47/mês) nas duas.
- [x] **Decisão**: DigitalOcean Droplet (4GB/2vCPU) + DigitalOcean
      Managed PostgreSQL (1GB/1vCPU) + DigitalOcean Spaces, mesma VPC —
      critério de decisão explícito e factual: é a única das duas
      topologias que cumpre, sem contorno, o requisito já documentado de
      Postgres nunca exposto à internet / rede privada quando suportada.
      Justificativa registrada em `docs/INFRASTRUCTURE_DECISION.md`, sem
      nenhum "é o melhor" subjetivo.
- [x] Staging, networking, security baseline e gatilhos de escalabilidade
      futura (rate limiter compartilhado, object storage para uploads,
      mudança de plano do Postgres Standard Edition anunciada pelo
      provedor para out/nov de 2026) documentados, nenhum implementado.
- [x] `docs/INFRASTRUCTURE_DECISION.md` criado;
      `docs/PRODUCTION_READINESS.md` atualizado com o resumo da decisão.
- [x] Regressão completa sem alteração de domínio do código:
      `npx tsc --noEmit` (ambos tsconfigs), `npm run build`,
      `npm run build:server`, `npm audit --audit-level=moderate`, suíte
      de testes — todos verdes, inalterados desde a Fase 59.

## Fase 61 — Staging zero-custo real via Docker + Cloudflare Tunnel (CONCLUÍDA)

Mudança de estratégia: a Fase 60 tinha decidido uma infraestrutura paga
(DigitalOcean), mas o projeto decidiu não assumir custo de hospedagem
antes de haver investimento. Esta fase prova a mesma arquitetura
validada nas Fases 58-60 de forma **real, pública e com custo zero**,
usando Docker local + Cloudflare Tunnel gratuito (sem conta). Nenhum
provedor pago, nenhum cartão, nenhuma conta nova.

- [x] `Dockerfile` novo (multi-stage: build completo depois `npm ci
      --omit=dev` só com o compilado) e `deploy/nginx.staging.conf`
      (adaptação de `deploy/nginx.conf` só para rede Docker e ausência
      de TLS local — a correção de headers da Fase 59 replicada de
      propósito). `deploy/nginx.conf`/`deploy/levora-api.service`/
      `docs/DEPLOYMENT_RUNBOOK.md` (deploy em VPS real) preservados sem
      alteração para quando houver investimento.
- [x] `docker-compose.staging.yml`: 3 serviços (postgres, app, nginx),
      volumes nomeados persistentes (`postgres_data`, `uploads_data`).
      `app` e `postgres` sem nenhuma porta publicada no host; `nginx` só
      em `127.0.0.1:8088` — nenhum port forwarding necessário.
- [x] Build real: `npm ci --omit=dev` (confirmado `tsx` presente, achado
      da Fase 58 reconfirmado num ambiente novo), `npm run build`,
      `npm run build:server`.
- [x] Migrations pelo mecanismo oficial (nunca `psql -f`) contra um
      Postgres novo: 26 tabelas, 22 triggers, **13/13 migrations,
      incluindo `0013`**.
- [x] **Cadeia de confiança de IP investigada e comprovada de verdade**
      (não assumida): `CF-Connecting-IP` não pode ser forjado pelo
      cliente (testado — a borda da Cloudflare devolveu 403 antes de a
      requisição chegar ao túnel); `X-Forwarded-For` pode ser forjado,
      mas a Cloudflare só acrescenta o IP real ao final, nunca
      substitui. `nginx.staging.conf` usa só `CF-Connecting-IP`.
- [x] Rate limiting reconfirmado através da cadeia completa real
      (`Cloudflare → túnel → nginx → Express`): 25 tentativas de login
      com XFF forjado e diferente a cada vez, 20 permitidas + 5
      bloqueadas, mesmo bucket.
- [x] Scheduler confirmado (5 tarefas) em toda subida/restart do
      container.
- [x] **Decisão de storage de uploads registrada explicitamente: volume
      Docker local (Opção A)**, não object storage — testado (escrita,
      leitura, persistência depois de `docker compose down`/`up` sem
      `-v`).
- [x] Backup real (`pg_dump`, 126.361 bytes, SHA-256 registrado) salvo
      em `backups/` no host, fora de qualquer volume do Postgres —
      inclui um usuário de teste real criado através do túnel público.
- [x] Restore real num banco separado: 26/26 tabelas, 13/13 migrations,
      dado do usuário preservado, `verifyAuditLogChain()` canônico
      rodado com sucesso (`integra: true`), e um container `app`
      temporário apontado para o banco restaurado respondeu login com
      sucesso.
- [x] Persistência confirmada: `docker compose down`/`up` completo sem
      perder banco nem uploads.
- [x] SIGTERM real (`docker stop`, ~303ms, saída limpa) e restart
      limpos — reconfirma o achado da Fase 59 (nunca `npm start` como
      entrypoint) num ambiente novo.
- [x] Acesso externo real confirmado via navegador rodando num ambiente
      isolado, genuinamente fora da rede local — Central Visual completo
      (login, dashboard, fallback de SPA, mobile) pela URL pública do
      Cloudflare Tunnel, nunca por `localhost`.
- [x] Segurança confirmada: Postgres e Express sem porta publicada no
      host, `JWT_SECRET` de staging gerado fresco e nunca commitado,
      `.env` real nunca tocado, cookies com `HttpOnly`/`Secure`/
      `SameSite=Lax` intactos.
- [x] Custo real: **US$0,00** — nenhuma conta paga criada.
- [x] Limitações documentadas sem esconder: disponibilidade depende
      deste computador/conexão residencial, backup sem independência
      geográfica, instância única, sem alertas externos — classificado
      explicitamente como staging/demonstração, nunca produção
      empresarial.
- [x] `docs/STAGING_ZERO_COST.md` criado;
      `docs/PRODUCTION_READINESS.md` e `docs/INFRASTRUCTURE_DECISION.md`
      atualizados — a decisão de infraestrutura paga da Fase 60
      permanece válida para quando houver investimento, só adiada.
- [x] Ao final: processo `cloudflared` encerrado (URL pública para de
      responder) e `docker compose down` **sem `-v`** — volumes
      `postgres_data`/`uploads_data` preservados para reuso.
- [x] Regressão completa: `npx tsc --noEmit` (ambos tsconfigs), `npm
      audit --audit-level=moderate` (0 vulnerabilidades), 370/370 testes
      — todos verdes, nenhuma alteração de domínio do código.


## Fase 62 — Operacionalização do staging gratuito (CONCLUÍDA)

Transforma o staging zero-custo validado na Fase 61 em um ambiente
operacional reproduzível: scripts PowerShell (`scripts\staging-up.ps1`,
`staging-status.ps1`, `staging-down.ps1`, `staging-backup.ps1`,
`staging-restore.ps1`, `staging-reset.ps1`, `staging-destroy.ps1`),
runbook completo (`docs/STAGING_OPERATIONS.md`). Classificado
explicitamente como demonstração/teste, nunca produção. Custo: US$0,00.

- [x] `staging-up.ps1`: verifica/inicia o Docker, carrega ou gera
      `STAGING_JWT_SECRET` (persistido fora do Git em
      `.staging-runtime\secrets.env`), builda e sobe os containers,
      detecta sozinho se o banco é novo ou um volume reaproveitado para
      escolher entre `db:migrate` e `db:migrate:incremental` (achado
      real: a primeira versão do script sempre rodava `db:migrate`, que
      não é idempotente por design — corrigido antes de causar dano),
      espera a aplicação responder, sobe o Cloudflare Quick Tunnel e
      imprime a URL pública.
- [x] `staging-status.ps1`, `staging-down.ps1` (nunca apaga volumes),
      `staging-backup.ps1` (timestamp + SHA-256, sem BOM — achado real:
      `Out-File -Encoding utf8` do PowerShell grava BOM, quebrando
      `sha256sum -c` padrão, corrigido escrevendo o `.sha256` em ASCII
      puro), `staging-restore.ps1` (sempre banco separado, confere
      checksum antes de restaurar, valida schema + `verifyAuditLogChain`
      + login real contra o banco restaurado).
- [x] `staging-reset.ps1` e `staging-destroy.ps1`: perigosos por
      definição, nome do banco de staging fixo e não-parametrizável
      (nunca podem acertar outro banco), exigem digitar uma frase de
      confirmação exata (`Read-Host`) — testado que, sem terminal
      interativo, o script falha com segurança (nada é apagado) em vez
      de prosseguir.
- [x] Todos os scripts testados de verdade, não só lidos: dois achados
      reais de encoding/API corrigidos durante o teste (em-dash UTF-8
      sem BOM quebrando o parser do PowerShell 5.1;
      `RandomNumberGenerator.Fill` não existe no .NET Framework do
      Windows PowerShell 5.1, trocado por `RNGCryptoServiceProvider`;
      `Start-Process` recusa o mesmo arquivo para
      `RedirectStandardOutput`/`RedirectStandardError`).
- [x] **Achado real crítico, corrigido**: depois do staging ficar no ar
      por mais tempo que nas fases anteriores, login (e qualquer rota
      que tocasse o banco) passou a travar indefinidamente. Investigação
      real via `pg_stat_activity`: 3 conexões idle, última query
      `pg_try_advisory_lock` — o mecanismo do scheduler
      (`reserveDedicatedConnection`, `src/helpers/scheduledTaskLock.tsx`)
      disputava o MESMO pool pequeno (`max: 3`, `src/helpers/db.tsx`)
      usado por toda query comum da aplicação. Como as 5 tarefas
      agendadas podem reservar conexão ao mesmo tempo sem conflito entre
      si (cada uma com `objId` próprio), uma sobreposição real esgotava
      o pool inteiro, travando para sempre qualquer query comum
      (inclusive o corpo das próprias tarefas agendadas) — deadlock
      total e permanente, só resolvido reiniciando o processo.
      Reproduzido de propósito (5 tarefas disparadas em paralelo) antes
      e depois da correção. **Corrigido**: pool separado e dedicado só
      para o scheduler (`max: 5`), nunca compartilhado com o pool
      principal — depois da correção, as mesmas 5 tarefas simultâneas
      não afetam login (responde em 0,35s). Esse bug teria eventualmente
      travado qualquer deploy real de longa duração desta arquitetura,
      staging ou produção futura — só apareceu porque esta fase, ao
      operacionalizar o staging para ficar no ar por mais tempo, deu
      tempo real de execução suficiente para a condição ocorrer.
- [x] Central Visual completo pela URL pública real (não `localhost`):
      login, dashboard, mobile, sem erro de console numa aba nova —
      confirmado antes e depois da correção do deadlock.
- [x] `docs/STAGING_OPERATIONS.md` criado (17 seções);
      `docs/STAGING_ZERO_COST.md`, `docs/PRODUCTION_READINESS.md` e
      `docs/INFRASTRUCTURE_DECISION.md` atualizados com o achado do
      deadlock e a operacionalização.
- [x] Regressão completa depois da correção: `npx tsc --noEmit` (ambos
      tsconfigs), 370/370 testes, `npm run build`/`build:server`,
      `npm audit --audit-level=moderate` (0 vulnerabilidades) — todos
      verdes.

## Fase 63 — Auditoria de lifecycle, capacidade e concorrência dos pools PostgreSQL (CONCLUÍDA)

Audita se a correção da Fase 62 (pool separado para o scheduler) estava
completa: lifecycle, concorrência, exaustão, shutdown, restart, falhas
de banco, transações, locks e connection leaks. Nenhum terceiro pool
criado, nenhum limite aumentado por tentativa e erro.

- [x] Matriz completa de pools construída por busca textual em todo
      `src/`/`db/`: só existem 2 pools na aplicação (`pgClient` max 3,
      `scheduledTaskLockClient` max 5, ambos em `src/helpers/db.tsx`) +
      1 conexão `max:1` própria dos scripts de migration (CLI, curta
      duração, sempre fechada com `sql.end()`). Nenhum outro ponto do
      projeto cria pool ou conecta direto ao Postgres.
- [x] Lifecycle confirmado, não presumido: os dois pools da aplicação
      são singletons eager (criados uma vez na primeira importação de
      `db.tsx`, garantido pelo cache de módulos do Node mesmo com vários
      importadores); `closeDbPool()` fecha os dois em paralelo; restart
      real confirmou exatamente uma instância de cada depois.
- [x] Capacidade documentada: 8 conexões aplicacionais no total (3+5),
      9 no pico contando a migration — `max_connections` real do
      Postgres de staging é 100, folga ampla. Nenhum valor tornado
      configurável por variável de ambiente (sem necessidade operacional
      concreta demonstrada).
- [x] Pressão controlada real: 5 tarefas agendadas reais (corpo real,
      não mock) disparadas simultaneamente + login real simultâneo pela
      URL pública — login em 0,64s, tarefas em 76ms totais; needs/
      inventory-items/opportunities autenticados respondendo em ~0,25s
      cada durante a sobreposição.
- [x] Exaustão deliberada de cada pool (4 queries de 3s contra `max:3`;
      6 reservas de 3s contra `max:5`): fila graciosa confirmada em
      ambos — nunca erro, nunca trava permanente, recuperação completa
      logo depois.
- [x] Isolamento cruzado comprovado nas duas direções: pool do
      scheduler saturado (7×4s) não afeta 5 logins reais consecutivos
      (~0,3s cada); pool da API saturado (5×4s) não afeta uma reserva do
      scheduler (21ms).
- [x] Erro dentro de uma tarefa agendada: lock liberado corretamente
      mesmo com exceção — tentativa seguinte da mesma tarefa teve
      sucesso imediato.
- [x] SIGTERM real com reservas do scheduler ativas no momento exato do
      sinal: encerramento gracioso confirmado (~397ms), zero conexões
      residuais no Postgres depois — prova de que `closeDbPool()`
      realmente fecha os dois pools, não só um.
- [x] Falha real de PostgreSQL: container parado com o app rodando —
      `/_api/__health` (liveness pura) continuou 200; login falhou
      graciosamente (400, ~3,5s, nunca travou nem derrubou o processo).
      Depois do Postgres voltar, login funcionou de novo sozinho
      (reconexão automática do driver), sem pool ou timer duplicado.
- [x] Auditoria de transações (needs/stock/matching/audit log/background
      tasks): nenhuma transação mantém conexão presa por tempo
      indefinido, com uma exceção registrada como achado (não corrigida
      — fora do escopo "não tocar Matching 1.4"): `opportunityMatching.tsx`
      chama a IA (Anthropic, sem timeout configurado) dentro de um
      `db.transaction()`, prendendo uma conexão do pool da API durante
      toda a chamada externa — risco real de latência/pressão sob
      volume, não o mesmo tipo de deadlock permanente da Fase 62.
- [x] Auditoria de connection leak: único uso de `.reserve()` em todo o
      projeto é `reserveDedicatedConnection()`, sempre dentro de um
      try/finally que garante `.release()` — nenhum vazamento
      encontrado.
- [x] Achado registrado, não corrigido (fora do escopo "não tocar
      autenticação"): `login_with_password_POST.ts` tem um catch
      abrangente que devolve sempre "Falha na autenticação" (400),
      inclusive quando o erro real é o banco estar indisponível — sem
      nenhum log do erro real. Mascara problemas de infraestrutura como
      senha errada.
- [x] Central Visual real durante sobreposição ativa de scheduler: login
      e dashboard funcionando normalmente pela URL pública do túnel.
- [x] `test/dbPoolIsolation.test.ts` criado (2 testes, contra Postgres
      real) — satura cada pool deliberadamente e confirma que o outro
      responde rápido; fica no CI como proteção permanente contra a
      reintrodução do bug da Fase 62.
- [x] Requisito mínimo documentado para o PostgreSQL gerenciado futuro:
      8 conexões aplicacionais (9 no pico), margem operacional a definir
      no momento da contratação — nenhum fornecedor pesquisado de novo.
- [x] Achado real de script corrigido durante o teste de restart:
      `staging-up.ps1` tratava qualquer saída em stderr do `docker
      compose` (progresso normal do buildkit) como erro terminante por
      causa de `$ErrorActionPreference = "Stop"` no Windows PowerShell
      5.1 — corrigido para `"Continue"`, mantendo os checks explícitos
      de `$LASTEXITCODE` que já detectavam falhas de verdade.
- [x] Regressão completa: `npx tsc --noEmit` (ambos tsconfigs), `npm run
      build`/`build:server`, `npm audit --audit-level=moderate` (0
      vulnerabilidades), suíte de testes (370 + 2 novos) — todos verdes.

## Fase 64 — Hardening de timeout de IA, fronteira transacional e classificação de erros (CONCLUÍDA)

Corrige os dois achados registrados-mas-não-corrigidos na Fase 63
(estavam fora de escopo lá por proteção de domínio). Matching 1.4
preservado integralmente — só fronteira de timeout e tratamento de erro
alterados.

- [x] Fluxo de matching mapeado linha a linha a partir do código real:
      `BEGIN` → `SELECT ... FOR UPDATE` da oportunidade → leituras em
      lote (candidatos, saldos, capacidade/logística/área) → chamada de
      IA → loop de score/escrita → `COMMIT`. Confirmado que a chamada de
      IA não usa `trx` nem precisa de nenhum dado só disponível dentro da
      transação (recebe texto/candidatos já resolvidos em memória).
- [x] Investigado se seria seguro mover a IA para fora da transação:
      **não é, sem reestruturação maior** — o lock `FOR UPDATE` protege a
      consistência de `remaining`/`existingOrgIds` contra execuções
      concorrentes do mesmo matching, e esse lock só existe enquanto a
      transação está aberta; encerrá-la e reabri-la ao redor da IA
      reintroduziria uma corrida real sobre quanto da oportunidade já foi
      alocado. Decisão registrada e justificada, não executada — a
      reestruturação completa (revalidação de estado no ponto de
      escrita) fica para uma fase futura, fora do escopo "não alterar
      Matching 1.4".
- [x] **Correção escolhida — timeout real**: `src/helpers/aiClient.tsx`
      ganhou `AbortController` + limite de 8 segundos (justificado:
      latência típica do modelo usado — Haiku, lote de até 20
      candidatos, até 1024 tokens de saída — fica bem abaixo disso; o
      fallback determinístico por palavra-chave já existia para qualquer
      falha de IA, preservando o resultado funcional). O `fetch` é
      cancelado de verdade (não só uma desistência local) via
      `signal: controller.signal`.
- [x] Fallback existente confirmado como já cobrindo timeout: o
      try/catch amplo em `aiCategoryScores` (opportunityMatching.tsx)
      já tratava qualquer erro de IA como "seguir sem IA" — só o log foi
      melhorado para distinguir timeout de outras falhas
      (`AiTimeoutError`), sem mudar o comportamento.
- [x] Concorrência testada: duas execuções de matching em sequência após
      um timeout funcionam normalmente (sem lock/conexão presos);
      enquanto uma IA lenta segura uma conexão da transação de matching,
      uma query comum via `db` continua respondendo rápido (pool da API
      intacto, mesma categoria de proteção já provada para o scheduler
      na Fase 63).
- [x] Transação após timeout: nenhum registro parcial, nenhuma avaliação
      incompleta, `matching.executado` gravado normalmente no audit log
      mesmo quando a IA expira.
- [x] Pipeline global de erros investigado: `buildErrorResponse`
      (`src/helpers/errorResponse.tsx`, usado por ~40 endpoints) tem
      default 400 para erro desconhecido — **não alterado** (risco alto
      de quebrar validações de negócio legítimas que dependem desse
      default em endpoints não auditados nesta fase; registrado como
      achado mais amplo para investigação futura). `login_with_password_POST.ts`
      tinha seu próprio catch bespoke (não usa `buildErrorResponse`),
      corrigido isoladamente: `ZodError`/`SyntaxError` (entrada
      malformada) → 400; qualquer outra exceção inesperada (ex.: banco
      indisponível) → 500, logada no servidor, mensagem pública genérica
      sem vazar stack/SQL/host/credenciais. Falhas de credencial reais
      (e-mail/senha errados, rate limit) continuam exatamente como
      antes, tratadas antes deste catch.
- [x] `/_api/__health` confirmado inalterado — continua liveness-only,
      nenhuma necessidade concreta de readiness separado identificada.
- [x] Testado em staging real (não só unitário): PostgreSQL derrubado →
      login agora 500 (antes 400) com erro logado no servidor →
      religado → recuperação automática, sem pool/timer duplicado.
      Reprodução da IA lenta dentro do container real de staging (mock
      de `fetch`, nunca o provedor real): login respondeu em 0,36s
      enquanto a transação de matching segurava uma conexão esperando a
      IA, que abortou em ~8036ms exatamente como configurado.
- [x] Central Visual confirmado pela URL pública real do staging: login
      e dashboard normais, sem erro de console além dos 401 esperados
      pré-login.
- [x] `test/aiTimeoutAndPoolIsolation.test.ts` criado (3 testes, mock
      de `fetch` que só resolve quando o `AbortController` real
      dispara — nunca serviço externo real): timeout realmente abortado
      (~8s, nunca pendurado), segunda execução depois do timeout funciona
      sem resíduo, pool da API disponível durante a espera da IA.
- [x] Não regressão do Matching: nenhum peso, critério, threshold,
      renormalização, unidade, elegibilidade, desempate ou
      `ALGORITHM_VERSION` alterado — confirmado pelos testes existentes
      de matching (inalterados) continuando verdes.
- [x] Regressão completa: `npx tsc --noEmit` (ambos tsconfigs), `npm
      audit --audit-level=moderate` (0 vulnerabilidades), suíte de
      testes (375 + 3 novos = 378) — todos verdes.

## Fase 65 — Auditoria global da classificação de erros da API (CONCLUÍDA)

Investiga e corrige o achado registrado-mas-não-corrigido na Fase 64:
`buildErrorResponse` (49 dos 54 endpoints) tinha default 400 para erro
desconhecido e repassava `error.message` bruto ao cliente.

- [x] Helper mapeado por completo: assinatura, status default, tratamento
      de tipos conhecidos (`NotAuthenticatedError`→401,
      `OrganizationAccessError`/`PlatformAccessError`→403), ausência de
      tratamento de `ZodError`/`SyntaxError` explícito (ambos caíam no
      default), ausência total de uso do parâmetro `extraStatus` em
      qualquer dos 49 consumidores.
- [x] Todos os 49 consumidores mapeados (grep real, não inferência por
      nome de arquivo); confirmado que só 1 endpoint
      (`opportunities-status_POST.ts`) tinha um `throw new Error`
      deliberado de negócio — usando a mesma comparação de texto frágil
      (`msg.includes("recebida")`) que o comentário no topo do arquivo já
      dizia ter sido eliminada do projeto, mas não tinha.
- [x] **Achado real, reproduzido de verdade contra Postgres**:
      `error.message` de um erro de conexão real expõe o hostname
      interno (`getaddrinfo ENOTFOUND <host>`); de um erro de query real
      expõe nome de tabela/schema (`relation "x" does not exist`) — os
      49 endpoints repassavam isso direto ao cliente para QUALQUER
      `Error`, não só os tipos conhecidos.
- [x] **Correção central, um único ponto**: `src/helpers/errorResponse.tsx`
      — nova classe `ConflictError` (409, substitui a comparação de texto
      frágil no único caso real do projeto); default de erro desconhecido
      passa de 400 para 500; mensagem pública de erro desconhecido nunca
      mais é `error.message` — sempre `fallbackMessage`, já seguro e
      específico por endpoint.
- [x] **Dois achados reais de regressão, descobertos pela própria suíte
      de testes durante a correção** (não hipotéticos — a suíte real
      pegou os dois): `ZodError` precisava de classificação explícita
      (400, mensagem preservada) para não cair no novo default 500;
      `SyntaxError` nativo (corpo que nem chega a ser JSON válido, antes
      mesmo do Zod rodar — ex.: o cenário de CSRF com corpo não-superjson
      já coberto por `test/securityHardening.test.ts`) também precisava
      (400, mensagem genérica fixa "Corpo da requisição inválido", nunca
      o texto cru do parser nem o `fallbackMessage` do endpoint, que
      descreveria uma ação que nem chegou a começar). Ambos corrigidos
      antes de fechar a fase — a suíte completa (384 testes) confirma
      zero regressão depois.
- [x] Autorização (401/403) e Zod preservados integralmente — mesmo
      comportamento de antes, agora com teste direto do helper.
- [x] `executeTakeFirstOrThrow` (único uso no projeto,
      `organization-invites_POST.ts`) investigado: representa
      inconsistência real de dados (org que deveria existir, dado acesso
      já verificado), não um "recurso não encontrado" legítimo de
      usuário — 500 é a classificação correta, nenhuma mudança
      necessária.
- [x] Validado ao vivo em staging (não só teste automatizado): Postgres
      indisponível → 500 com mensagem genérica, erro real (hostname,
      errno) logado só no servidor; Zod inválido → 400; sem autenticação
      → 401; conflito real (oportunidade já recebida) → 409 com a
      mensagem preservada; corpo JSON malformado → 400 com "Corpo da
      requisição inválido". Recuperação confirmada após religar o
      Postgres.
- [x] Central Visual: login inválido mostra mensagem limpa sem stack
      trace nem tela branca; login válido funciona normalmente.
- [x] `test/errorResponse.test.ts` (7 testes, direto no helper central —
      "preferir testes do helper quando o comportamento for
      centralizado") e `test/opportunitiesStatusConflict.test.ts` (1
      teste de integração do único caso real de conflito) criados.
- [x] Nenhuma alteração em Matching 1.4, rate limiter, scheduler, pool
      architecture, security headers, Docker, Cloudflare ou backup.
- [x] Regressão completa: `npx tsc --noEmit` (ambos tsconfigs), `npm run
      build`/`build:server`, `npm audit --audit-level=moderate` (0
      vulnerabilidades), suíte de testes (384, confirmado limpo numa
      execução isolada depois de descartar falhas de duas execuções
      anteriores que se mostraram ruído de ambiente — múltiplos `npm
      test` concorrentes contra o mesmo Postgres de teste, não
      regressão real).

## Fase 66 — `build:server` como gate permanente do CI (CONCLUÍDA)

Fecha a lacuna descrita desde a Fase 58: até esta fase, `npm test` +
`npm run build` + `npm audit` verdes na CI nunca garantiam que o
artefato real de produção do backend (`dist-server/`) sequer compilava.

- [x] CI atual auditado linha a linha
      (`.github/workflows/ci.yml`) antes de qualquer alteração: `npm ci`
      → typecheck → testes → build (só frontend) → audit, com um
      comentário explicitamente (e incorretamente, confirmado pela Fase
      58) dizendo que `build:server` "já estava coberto pelo typecheck".
- [x] `build:server` reexecutado do zero: exit 0, 148 arquivos,
      entrypoint e `scheduled-jobs.json` presentes, 54 endpoints
      descobertos.
- [x] Determinismo confirmado: duas (e uma terceira) builds limpas em
      sequência produzem a mesma lista de arquivos e os mesmos hashes
      SHA-256 byte a byte (`scheduled-jobs.json`, `server/index.js`).
- [x] Gate adicionado ao workflow existente (nenhum workflow novo):
      `npm run build:server` depois do build do frontend, sem nenhum
      `|| true` nem saída mascarada.
- [x] Ordem final: `npm ci → typecheck → testes → build → build:server →
      verificação do artefato → audit` — exatamente a ordem sugerida
      pela fase, build:server antes do audit para falhar o mais cedo
      possível num problema de compilação antes de gastar tempo com
      dependências.
- [x] Verificação de artefato adicionada (não frágil — sem contar
      arquivos exatos): confere `dist-server/server/index.js`,
      `dist-server/src/static/__dev/scheduled-jobs.json` e que pelo
      menos 1 endpoint foi descoberto, falhando o job com mensagem clara
      se qualquer um faltar.
- [x] **Teste real de falha do gate (etapa obrigatória)**: import
      inexistente introduzido de propósito em `db.tsx`, `build:server`
      confirmado falhando com exit code 2 (não 0) — prova de que o gate
      realmente quebra o job. **Achado real durante a reversão**: usar
      `git checkout -- src/helpers/db.tsx` para desfazer a quebra
      proposital reverteu o arquivo para o último COMMIT (não para o
      estado anterior à quebra) — como nada tinha sido commitado nesta
      sessão inteira, isso apagou também a correção real de pool
      separado da Fase 62 (deadlock do scheduler). Detectado
      imediatamente pelo diff mostrado antes do checkout, reconstruído à
      mão a partir do conteúdo correto conhecido, e reconfirmado: 5
      testes de isolamento de pool (`dbPoolIsolation.test.ts`,
      `aiTimeoutAndPoolIsolation.test.ts`) voltaram a passar, e a suíte
      completa (384 testes) confirmou zero dano colateral.
- [x] Caso específico do `scheduled-jobs.json` (já causou um bug real na
      Fase 58) coberto explicitamente na verificação de artefato — não
      um teste artificial, um `test -f` simples e determinístico.
- [x] `npm ci --omit=dev` confirmado como o mecanismo de instalação da
      CI continua inalterado — nenhuma dependência movida de novo.
- [x] Backend não é iniciado na CI (sem `npm start`) — só o artefato de
      build é validado, exatamente como pedido.
- [x] CI remoto: não executado nesta sessão (nenhum push feito — regra
      mantida durante toda a sessão de nunca commitar/empurrar
      automaticamente) — declarado explicitamente, não fingido. Os
      mesmos comandos exatos do workflow foram validados localmente.
- [x] `permissions: contents: read` preservado sem alteração.
- [x] `docs/TESTING.md` e `docs/DEPLOYMENT_RUNBOOK.md` (uma nota pontual,
      não reescrita) atualizados.
- [x] Nenhuma alteração em Modelo B, Matching, needs, stock,
      autenticação, errorResponse, rate limiting, pools, scheduler,
      Docker, Cloudflare, Nginx, produção ou domínio.
- [x] Regressão completa: `npx tsc --noEmit` (ambos tsconfigs), `npm run
      build`/`build:server`, `npm audit --audit-level=moderate` (0
      vulnerabilidades), suíte de testes (384) — todos verdes depois da
      reconstrução de `db.tsx`.
## Fase 67 — Consolidação do estado e checkpoint seguro (CONCLUÍDA)

Motivação: as Fases 48–66 ficaram todas sem commit; o incidente da Fase 66
(`git checkout -- src/helpers/db.tsx` voltando ao último commit e apagando a
correção de pool da Fase 62) mostrou o risco. Sem funcionalidade nova.

- Inventário Git, mapeamento por fase e confirmação das correções críticas.
- Migration 0013 presente, ordem 0001–0013 intacta, `db/schema.sql` coerente.
- Gates finais: typecheck (2 tsconfigs), 384/384 testes (43 arquivos),
  `build`, `build:server` (54 endpoints), `npm audit` sem vulnerabilidades.
- Smoke do staging: containers, Postgres, Express, Nginx, Tunnel; cadastro,
  login, sessão, organização, necessidade e oportunidade.
- Varredura de segredos nos arquivos candidatos ao commit.
- `docs/DEVELOPMENT.md`: commitar antes de operações destrutivas e o risco
  do `git checkout --`.
- O commit de checkpoint só é criado com autorização explícita; sem push.

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
