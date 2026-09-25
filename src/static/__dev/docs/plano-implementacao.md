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
- [ ] Cobertura de isolamento multi-organização ainda não estendida a todos
      os domínios (`opportunity_registry`, `opportunity_allocations`,
      `logistics_events`, `approval_requests`) — só `stock_transactions` e
      `needs` têm teste explícito hoje. Ver "o que ainda falta" em
      `docs/TESTING.md`.
- [ ] Sem pipeline de CI configurado neste repositório — a suíte roda hoje
      só localmente/sob demanda.



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
