# Especificação — ciclo de vida dos membros da organização

> **Status (Fase 73): IMPLEMENTADO.** Decisões de produto confirmadas:
> **P-1 = SIM** (uma organização pode ter mais de um proprietário e um
> proprietário pode promover outro) e **P-2 = SIM** (um administrador pode
> alterar o papel de outro administrador). P-3 a P-7 seguem os padrões da
> seção 12. O comportamento efetivamente implementado, o que a auditoria da
> Fase 73 corrigiu e as evidências estão na **seção 13**. O restante deste
> documento é a especificação original da Fase 72, preservada.

Fase 72. **Especificação, não implementação.** Nenhum código, migration,
tabela, endpoint, componente, permissão ou sessão foi alterado. Escrita
sobre o checkpoint `dbc4fe3` para que a fase seguinte possa implementar
sem redescobrir o domínio.

Convenção: **[T-n]** é decisão técnica (pode ser tomada na implementação,
com a justificativa daqui). **[P-n]** é decisão de produto: tem um valor
padrão recomendado, mas é do dono do projeto confirmar **antes** de
codificar (seção 12).

## 1. Estado atual (medido, com evidência)

### 1.1 Estrutura

`memberships` (`db/schema.sql`):

| Coluna | Tipo / regra |
|---|---|
| `id` | `SERIAL` PK |
| `organization_id` | FK → `organizations`, `ON DELETE CASCADE` |
| `user_id` | FK → `users`, `ON DELETE CASCADE` |
| `role` | enum `membership_role`: `proprietario`, `administrador`, `operador`, `voluntario` |
| `status` | enum `membership_status`: `ativo` (padrão), `convidado`, `inativo` |
| `invited_by_user_id` | FK → `users`, nulo |
| `created_at`, `updated_at` | trigger `set_updated_at` |
| **Única restrição de negócio** | `UNIQUE (organization_id, user_id)` |

Nenhuma outra tabela referencia `memberships`. **Não há** `CHECK`,
índice parcial ou trigger que garanta ao menos um proprietário.
`convidado` nunca é usado pelo código (convites vivem em
`organization_invites`).

### 1.2 Quem lê e quem escreve

| Ponto | Comportamento | Onde |
|---|---|---|
| Guard de acesso | Lê `role` e `status` **do banco a cada requisição**; recusa se não existir ou `status != 'ativo'` | `helpers/organizationAccess.tsx:111` |
| Lista de organizações do usuário | Filtra `status = 'ativo'` | `organizations_GET.ts:35` |
| Criação de organização | Insere o criador como `proprietario`/`ativo` | `organizations_POST.ts:68` |
| Criação de convite | Recusa se já há membro **ativo** com o e-mail; revoga convite pendente anterior | `organization-invites_POST.ts:42-46` |
| Aceite de convite | `INSERT … ON CONFLICT (organization_id, user_id) DO UPDATE SET role, status='ativo'` — **já reativa** um membro inativo, com o papel do convite | `organization-invites-accept_POST.ts:44-52` |
| Exclusão de conta | **Escreve** `status='inativo'` em todas as memberships do usuário; antes, recusa se o usuário é o **único proprietário ativo** de alguma organização | `auth/account-delete_POST.ts:76-125` |
| Lista de membros | Qualquer membro ativo vê **todos** (inclusive inativos) com e-mail e status | `organization-members_GET.ts:20-33` |
| Alterar papel / desativar / sair | **Não existem** | — |

Correção à Fase 71: `inativo` **tem** uso (escrito pela exclusão de conta).
O que falta é qualquer fluxo de gestão que o defina.

### 1.3 Permissões

- `proprietario` e `administrador` têm **o mesmo conjunto** (`ADMIN_PERMISSIONS`,
  `permissions.tsx:51,80-81`), fixado por `test/permissions.test.ts:13`.
  A única diferença real entre os dois hoje está em `account-delete`.
- `membros.gerencie` protege convites (criar, listar, revogar) e nada mais.
- `membros.leia` existe, mas `organization-members_GET` usa apenas
  `requireOrganizationMembership`.
- `docs/RBAC_PERMISSOES.md` já fixa a regra: ação exclusiva de proprietário
  nasce como **uma permissão que só `proprietario` tem**, nunca como caso
  especial espalhado.
- Convite **não pode** nomear `proprietario` (decisão deliberada,
  `docs/CONVITE_DE_MEMBROS.md`). Logo, **hoje toda organização tem
  exatamente um proprietário: quem a criou**, e não há transferência.

### 1.4 Sessões

A sessão é uma linha em `sessions` ligada ao **usuário**, não à organização
(cookie assinado com o id da sessão). O papel e o status são resolvidos **por
requisição**, no banco. Consequências:

- uma alteração em `memberships` vale para a **próxima** requisição, sem
  invalidar sessão nenhuma;
- invalidar a sessão seria errado: o usuário pode pertencer a outras
  organizações;
- uma requisição que já passou do guard termina normalmente (janela de uma
  requisição). A fase de implementação reduz isso revalidando dentro da
  transação.

### 1.5 Auditoria

`audit_log` é append-only (triggers) com hash encadeado, gravado na mesma
transação (`recordAuditLogEntry(entry, trx)`). Padrão de nome real:
`dominio.acao_no_participio` em português, p.ex. `organizacao.convite_aceito`,
`organizacao.convite_revogado`, `usuario.conta_excluida`. **Não** o
`organization.member_*` sugerido no pedido da fase.

### 1.6 Interface

`pages/organizacoes.$organizationId.tsx`: lista de membros com papel e status
(badges), botão "Convidar" e convites pendentes com "Revogar" visíveis para
`proprietario`/`administrador` (`canManageMembers`). Nenhuma ação por membro.

### 1.7 Dois achados que a especificação precisa tratar

- **A1 — corrida latente na exclusão de conta.** A regra "único proprietário
  ativo" roda **fora da transação e sem lock** (`account-delete_POST.ts:76-95`).
  Hoje é inofensiva (há um proprietário por organização), mas com co-proprietários
  dois deles poderiam excluir a conta ao mesmo tempo e deixar a organização sem
  proprietário.
- **A2 — o aceite de convite sobrescreve papel/status sem olhar o estado
  atual.** Com gestão de membros, isso pode **rebaixar ou promover** um membro
  ativo através de um convite antigo. Precisa de guarda.

## 2. Invariantes

1. **I1 — toda organização tem ao menos um proprietário ativo.** Nenhuma
   operação pode terminar violando isso.
2. **I2 — o histórico nunca é apagado.** Sem `DELETE` em `memberships`.
3. **I3 — toda mutação é auditada na mesma transação.**
4. **I4 — mutações de membros de uma mesma organização são serializadas.**
5. **I5 — efeito imediato** para novas requisições (consequência de 1.4).

## 3. Fluxos

Três endpoints novos, no padrão `organization-<substantivo>-<verbo>_POST`
(como `organization-invites-revoke_POST`). O alvo é identificado por
`membershipId` (já exposto por `organization-members_GET`) e sempre filtrado
por `organization_id`, o que dá 404 para membership de outra organização.

### 3.1 A. Alterar papel — `organization-members-role_POST`

Entrada: `{ organizationId, membershipId, role }` (`role` ∈ os 4 papéis).
Saída: o membro atualizado.

Quem pode: `membros.gerencie` (proprietário/administrador) e organização
`ativa` (`requirePermission`, como os convites). **Regras sobre proprietário:**
se o alvo é `proprietario` **ou** o novo papel é `proprietario`, o ator precisa
de `propriedade.gerencie` (permissão nova, só do proprietário — [T-7]).

Matriz (padrão [P-2] = paridade com a permissão de convidar):

| Ator \ Alvo (papel atual) | voluntário | operador | administrador | proprietário |
|---|---|---|---|---|
| **Voluntário / operador** | ✗ | ✗ | ✗ | ✗ |
| **Administrador** | ✓ (→ voluntário/operador/administrador) | ✓ (idem) | ✓ (idem) | ✗ |
| **Proprietário** | ✓ (→ qualquer, inclusive proprietário) | ✓ | ✓ | ✓ (→ rebaixar, se houver outro proprietário ativo) |

Regras adicionais:

- só alvo com `status = 'ativo'` (senão 409);
- novo papel igual ao atual → 409 ("já tem este papel");
- **auto-alteração**: permitida apenas para **baixo** (hierarquia
  proprietário > administrador > operador > voluntário), nunca para cima; um
  proprietário só se rebaixa se existir **outro** proprietário ativo (I1);
- rebaixar um proprietário exige que, após a mudança, reste ao menos um
  proprietário ativo (I1);
- **promover a `proprietario` é permitido** ([P-1]): é o único caminho para
  haver transferência de propriedade, já que convite não pode nomear
  proprietário. Transferir = promover o sucessor e, depois, rebaixar-se ou
  sair.

### 3.2 B. Desativar membro — `organization-members-deactivate_POST`

Entrada: `{ organizationId, membershipId }`. **Desativação lógica**
(`status = 'inativo'`), nunca `DELETE` ([T-3]). Compatível com tudo o que
existe: o guard e `organizations_GET` já tratam `inativo`; a UNIQUE
`(organization_id, user_id)` continua satisfeita; nenhuma FK depende da linha.

- Quem pode: `membros.gerencie` + organização `ativa`.
- **Não pode ser o próprio ator** (409 orientando a usar "Sair"): mantém
  semânticas separadas e a auditoria distinta.
- Alvo `proprietario`: exige `propriedade.gerencie` **e** outro proprietário
  ativo (I1).
- Alvo precisa estar `ativo` (senão 409).
- **Convites:** nenhum convite pendente endereçado ao alvo existe por
  construção (`organization-invites_POST` recusa membro ativo). Convites
  **emitidos pelo alvo** permanecem válidos (a autoridade era da organização,
  e o convite está auditado). Aprovações pendentes pedidas pelo alvo seguem
  existindo; quem decide precisa ser membro ativo, então o alvo deixa de
  poder decidir sozinho.
- **Histórico preservado:** linha em `memberships`, `audit_log.actor_user_id`,
  atribuições, movimentos de estoque e demais autorias continuam apontando
  para o usuário.
- **Reativação** = novo convite + aceite (o `upsert` atual já faz isso, com o
  papel do convite) — sem endpoint próprio ([P-5]).

### 3.3 C. Sair da organização — `organization-members-leave_POST`

Entrada: `{ organizationId }`. Ação sobre a **própria** membership.

- Qualquer papel pode sair, **sem permissão específica**: basta ser membro
  ativo (`requireOrganizationMembership`). Sair não depende de a organização
  estar `ativa` ([T-13]).
- **Proprietário:** só pode sair se existir outro proprietário ativo; senão 409
  ("promova outro proprietário antes de sair"). Mesma regra de
  `account-delete`.
- **Administrador, operador, voluntário:** sempre podem.
- **Último proprietário não sai** — logo, uma organização cujo único membro é
  o proprietário nunca fica sem proprietário (e não existe, nesta fase, como
  encerrá-la; ver [P-6]).
- Transferência de propriedade **não é pré-requisito** para membros comuns;
  é pré-requisito, na prática, só para o único proprietário.
- Interface: ação **separada** "Sair da organização" (seção 8).

### 3.4 D. Efeito sobre quem entra de novo (mudança no aceite de convite)

`organization-invites-accept_POST` passa a:

1. travar a organização (seção 5) antes de tocar em `memberships`;
2. se já existe membership **ativa** do usuário na organização → 409
   ("Você já é membro desta organização"), **sem** alterar papel (corrige A2);
3. se existe `inativo` → reativa com o papel do convite (comportamento atual) e
   audita com `reativacao: true`;
4. se não existe → insere (comportamento atual).

## 4. Sessões — decisão técnica explícita [T-4]

- **Não invalidar sessões.** O guard já relê `memberships` a cada requisição;
  desativar ou rebaixar vale na próxima chamada. A sessão é do usuário.
- **Dentro das mutações novas**, o ator é **relido sob o lock** (papel e status
  atuais), nunca confiando no que o guard leu antes do lock. Isso fecha a
  janela entre o guard e a escrita.
- Requisições de outras rotas que já passaram do guard terminam (janela de uma
  requisição); aceito e documentado.
- **Cache do cliente:** `myRole` vem de `organizations_GET` via react-query. Após
  desativação, a próxima chamada retorna 403 e a lista deixa de conter a
  organização; a UI trata o 403 invalidando `organizations` e voltando ao painel
  (seção 8).

## 5. Concorrência — protocolo de locks [T-1]

**Ordem global: `organizations` → `memberships` (por `id` crescente) →
`organization_invites`.** Toda mutação de membros começa travando a linha da
organização:

```sql
SELECT id FROM organizations WHERE id = $1 FOR NO KEY UPDATE;
```

`FOR NO KEY UPDATE` (suportado pelo Kysely instalado, 0.29.6:
`.forNoKeyUpdate()`) conflita com outras mutações de membros e **não** com
os `INSERT` filhos que só pedem `FOR KEY SHARE` na organização (necessidades,
movimentos de estoque…), então não congela o resto da organização. Com o lock
de organização, as demais leituras na transação já enxergam o estado
confirmado; a linha-alvo ainda é lida `FOR UPDATE` como defesa em profundidade.

Quem trava a organização: os 3 endpoints novos, o **aceite de convite**, e a
**exclusão de conta** (que passa a travar, em ordem crescente de `id`, todas as
organizações onde o usuário tem membership ativa, e a reexecutar a verificação
de proprietário único **dentro** da transação — corrige A1 [T-10]).
`organizations_POST` não precisa (organização nova, sem concorrência).

Em todos os casos a transação **relê** ator e alvo depois do lock e
**revalida** todas as regras; o resultado é decidido pelo estado relido.

| # | Cenário | Lock | Condição transacional | Resultado | Auditoria | Erro |
|---|---|---|---|---|---|---|
| 1 | Dois administradores desativam o **mesmo** membro | Org (serializa) → alvo | 1ª tx: alvo `ativo` → vira `inativo`. 2ª tx (depois do lock): alvo já `inativo` | 1ª sucede; 2ª não altera nada | **1** evento (`membro_desativado`) | 2ª: **409** "Este membro já não está ativo" |
| 2 | Dois administradores alteram o papel do **mesmo** membro | Org → alvo | 1ª aplica. 2ª relê: se o papel atual já é o pedido → conflito; senão aplica sobre o estado novo | Último a adquirir o lock vence se pediu algo diferente; igual ao atual → 409 | 1 evento por mudança efetivamente aplicada | 409 "já tem este papel" |
| 3 | Dois atores desativam/rebaixam o **último** proprietário (ou cada um o do outro) | Org | `ativos(proprietario) ≥ 2` antes da mudança, relido sob o lock | A 1ª só passa se sobrar um proprietário; a 2ª vê `ativos = 1` e é recusada. **I1 nunca é violado** | Só a que sucedeu | **409** "A organização precisa ter ao menos um proprietário ativo" (ou 403 se o ator já perdeu o papel) |
| 4 | Administrador altera o membro **enquanto ele sai** | Org | Se "sair" vence: alvo `inativo` → a alteração falha. Se a alteração vence: o membro ainda é ativo e sai depois, com o novo papel | Ordem do lock decide; estado final sempre consistente | Um evento por operação aplicada | Alteração: **409** alvo inativo; ou "sair": **403** se a alteração tinha desativado |
| 5 | Dois proprietários se promovem/rebaixam ao mesmo tempo (A rebaixa B, B rebaixa A) | Org | Cada tx relê o **ator** sob o lock; depois da 1ª, o ator da 2ª já não é proprietário | A 1ª aplica; a 2ª perde `propriedade.gerencie` | Só a 1ª | 2ª: **403** (e I1 preservado: sobra o vencedor) |

Casos extras cobertos pelo mesmo protocolo: aceite de convite × desativação do
mesmo usuário (serializados; um convite aceito depois de desativado
**reativa**, por desenho); exclusão de conta × mudança de papel do mesmo
usuário (a exclusão trava a organização antes de desativar).

## 6. Auditoria [T-8]

Ações novas, no padrão do projeto:

| Ação | Quando | `entityType` / `entityId` |
|---|---|---|
| `organizacao.membro_papel_alterado` | papel alterado com sucesso | `membership` / `membershipId` |
| `organizacao.membro_desativado` | alvo desativado por outra pessoa | `membership` / `membershipId` |
| `organizacao.membro_saiu` | o próprio membro saiu | `membership` / `membershipId` |
| `organizacao.convite_aceito` (existente) | aceite; com `reativacao: true` se havia `inativo` | `organization_invite` |

`organizationId` sempre preenchido; `actorUserId` é quem executou (no
`membro_saiu`, o próprio membro).

Metadata mínima, **sem segredo e sem dado pessoal além de ids** (o `audit_log`
é imutável; e-mail em metadata persistiria mesmo após a anonimização da conta,
o que já ocorre em `convite_criado` e não deve ser ampliado):

- `papel_alterado`: `{ alvoUserId, papelAnterior, papelNovo }`
- `desativado`: `{ alvoUserId, papelNoMomento }`
- `saiu`: `{ papelNoMomento }`
- `convite_aceito` (acréscimo): `{ reativacao, papelAnterior? }`

Operações recusadas (409/403/404) **não** geram evento, como no restante do
projeto.

## 7. RBAC [T-7]

Já existe: `membros.gerencie` (proprietário e administrador), `membros.leia`.
Falta uma **única** permissão nova, justificada pela regra já escrita em
`docs/RBAC_PERMISSOES.md`:

| Operação | Permissão |
|---|---|
| Alterar papel, desativar (alvo não proprietário, novo papel não proprietário) | `membros.gerencie` (existente) |
| Qualquer operação em que alvo **ou** novo papel seja `proprietario` | `membros.gerencie` **e** `propriedade.gerencie` (**nova**, só `proprietario`) |
| Sair da organização | nenhuma (basta ser membro ativo) |
| Listar membros | `requireOrganizationMembership` (como hoje) |

Efeito colateral a tratar na implementação: `proprietario` e `administrador`
deixam de ter o mesmo conjunto; `test/permissions.test.ts:13` (que fixa a
igualdade) e a seção correspondente de `docs/RBAC_PERMISSOES.md` precisam ser
atualizados **de propósito**, não "consertados".

## 8. Interface (somente especificação)

Tela: aba de equipe de `organizacoes.$organizationId`. Sem mockup.

- **Quem vê o quê:** todos veem membros ativos; **ex-membros** (inativos)
  ficam numa seção recolhida visível só para quem tem `membros.gerencie`
  ([P-3]).
- **Ações por membro** (menu de ações na linha, só para `proprietario` e
  `administrador`, nunca na própria linha): "Alterar papel" e "Desativar
  acesso". O seletor de papéis lista **somente** os papéis que a matriz da
  seção 3.1 permite àquele ator para aquele alvo; "Proprietário" só aparece
  para proprietário.
- **Própria linha:** botão "Sair da organização", visível para **todos os
  papéis**, separado das ações de gestão. Para o único proprietário fica
  desabilitado com a explicação "Promova outro proprietário antes de sair".
- **Confirmação:** "Desativar acesso" e "Sair" abrem diálogo de confirmação com
  o efeito ("perde o acesso imediatamente; os registros dessa pessoa
  continuam no histórico; para voltar é preciso um novo convite"). Alterar
  papel confirma quando for rebaixamento ou envolver proprietário.
- **Mensagens de erro** (texto do servidor, em português): "Este membro já não
  está ativo", "Este membro já tem este papel", "A organização precisa ter ao
  menos um proprietário ativo", "Somente proprietários podem alterar quem é
  proprietário".
- **Estados concorrentes:** em 409, atualizar a lista e avisar "A equipe foi
  alterada por outra pessoa; atualizamos a lista" — sem repetir a ação
  automaticamente.
- **Sucesso:** toast curto e lista atualizada; após "Sair", ir ao painel e
  invalidar `organizations`.
- **Acesso perdido (403) em qualquer rota da organização:** invalidar
  `organizations`, voltar ao painel com aviso.
- **Mobile (375/390 px):** alvos de toque ≥ 44 px; ações em menu (não em
  linha); diálogos usam o `Dialog` compartilhado (já responsivo, Fase 69); e-mails
  longos quebram linha (`overflow-wrap`, Fase 69); nada de rolagem horizontal.

## 9. Mudanças previstas para a fase de implementação

Sem migration ([T-2]: nenhuma coluna, enum ou constraint nova; o invariante I1
fica na aplicação, sob o lock — um trigger de banco colidiria com o
`ON DELETE CASCADE` de organizações e não é necessário com o lock).

| Arquivo | Mudança |
|---|---|
| `src/helpers/permissions.tsx` | `propriedade.gerencie` só em `proprietario` |
| `src/helpers/membershipAdmin.tsx` (novo) | travar organização, reler ator/alvo, contar proprietários ativos, aplicar a matriz |
| `src/endpoints/organization-members-role_POST.ts` + `.schema.ts` | novo |
| `src/endpoints/organization-members-deactivate_POST.ts` + `.schema.ts` | novo |
| `src/endpoints/organization-members-leave_POST.ts` + `.schema.ts` | novo |
| `src/endpoints/organization-invites-accept_POST.ts` | lock da organização; recusa se já ativo; `reativacao` na auditoria |
| `src/endpoints/auth/account-delete_POST.ts` | regra de proprietário único dentro da transação, sob lock (A1) |
| `src/endpoints/organization-members_GET.ts` | visibilidade de ex-membros ([P-3]) |
| `src/pages/organizacoes.$organizationId.tsx` (+ módulo CSS) | seção 8 |
| `docs/RBAC_PERMISSOES.md`, `docs/CONVITE_DE_MEMBROS.md`, `docs/ROADMAP_ATUAL.md`, `plano` | atualização |
| `test/permissions.test.ts` | atualizar a igualdade para a nova diferença |

Os 3 endpoints novos seguem o padrão existente: `getServerUserSession` →
Zod (`superjson`) → `requirePermission` → transação → `buildErrorResponse`,
com `ConflictError` para 409 e limite por usuário (bucket `organization-members`,
30/hora, no mesmo estilo de `RATE_LIMITING.md` [T-12]). Erros: 400 (Zod), 401,
403 (`OrganizationAccessError`), 404 (membership de outra organização ou
inexistente), 409 (`ConflictError`).

## 10. Plano de testes da fase de implementação

Contra Postgres real, no estilo de `test/organizationInvites.test.ts`:

1. **Matriz de autorização** completa (ator × alvo × papel novo), inclusive
   voluntário/operador recusados e administrador sem poder tocar proprietário.
2. **I1**: rebaixar, desativar e sair como único proprietário → 409; com 2
   proprietários → sucesso e sobra 1.
3. **Auto-alteração**: só para baixo.
4. **Isolamento entre organizações**: `membershipId` de outra organização → 404.
5. **Status da organização**: alterar/desativar recusados em `em_analise`/`suspensa`;
   sair permitido.
6. **Efeito imediato**: membro desativado recebe 403 na requisição seguinte e a
   organização some de `organizations_GET`; sessão continua válida para outra
   organização.
7. **Reativação**: convite → aceite reativa com o papel do convite;
   `convite_aceito` com `reativacao: true`.
8. **A2**: aceitar convite com membership já ativa → 409, papel intocado.
9. **Auditoria**: um evento por operação aplicada, nenhum por recusa; metadata sem
   e-mail; cadeia de hash íntegra (`verifyAuditLogChain`).
10. **Concorrência** (cenários 1–5, `Promise.all` de `handle()` com sessões
    distintas, repetidos N vezes): exatamente um sucesso onde aplicável; I1
    verdadeiro ao final; sem deadlock.
11. **Exclusão de conta × co-proprietário** (A1): dois co-proprietários excluindo
    ao mesmo tempo → exatamente um é recusado.
12. `test/permissions.test.ts` atualizado; `members_GET` conforme [P-3].

## 11. Fora de escopo (para não misturar)

Editar dados da organização, encerrar/arquivar organização, customização de
permissões por organização, reenvio de convite, notificações por e-mail das
mudanças (dependem de SMTP), e qualquer mudança em matching, ledger, lifecycle,
pools, staging ou seed.

## 12. Decisões que exigem definição

### Decisões técnicas (podem ser tomadas na implementação, justificadas acima)

| ID | Decisão | Padrão |
|---|---|---|
| T-1 | Lock de organização `FOR NO KEY UPDATE`; ordem organizações → memberships → convites | adotar |
| T-2 | Sem migration nem trigger; I1 sob lock na aplicação | adotar |
| T-3 | Desativação lógica (`inativo`), nunca `DELETE` | adotar |
| T-4 | Não invalidar sessões; reler ator sob lock | adotar |
| T-5 | Três endpoints separados (papel / desativar / sair) | adotar |
| T-6 | Alvo por `membershipId`, sempre filtrado por organização | adotar |
| T-7 | Nova permissão só do proprietário: `propriedade.gerencie` | adotar |
| T-8 | Nomes `organizacao.membro_*`; metadata só com ids | adotar |
| T-9 | Aceite de convite trava a organização e recusa membro já ativo (A2) | adotar |
| T-10 | Exclusão de conta trava as organizações em ordem e revalida (A1) | adotar |
| T-11 | Estado já aplicado = 409, não "sucesso idempotente" | adotar |
| T-12 | Limite por usuário nas mutações | adotar |
| T-13 | "Sair" não exige organização `ativa`; alterar/desativar exigem | adotar |

### Decisões de produto (do dono do projeto, com padrão recomendado)

| ID | Pergunta | Padrão recomendado | Efeito se mudar |
|---|---|---|---|
| **P-1** | Pode haver **mais de um proprietário** e o proprietário pode promover outro a proprietário? | **Sim.** Sem isso o único proprietário fica preso para sempre (não pode sair, rebaixar-se nem excluir a conta) | Se "não": remove-se a promoção; "último proprietário" vira regra permanente e a transferência precisa de outro fluxo |
| **P-2** | Administrador pode alterar/desativar **outro administrador**? | **Sim** (paridade com o que já pode convidar) | Se hierarquia estrita: administrador só mexe em operador/voluntário, e passa a ser incoerente com o convite de administradores |
| **P-3** | Quem vê **ex-membros** e e-mails? | Ex-membros só para quem tem `membros.gerencie`; ativos visíveis a todos (como hoje) | Muda só `organization-members_GET` e a UI |
| **P-4** | Gestão de membros com a organização `em_analise`/`suspensa`? | Bloqueada, exceto "Sair" | Se permitida: usar `requirePermissionToRead` nesses endpoints |
| **P-5** | Reativar um ex-membro | Só por novo convite (já funciona) | Se quiser botão direto: um quarto endpoint |
| **P-6** | Organização cujo único membro é o proprietário (sem como encerrá-la) | Fica como está nesta fase; encerrar/arquivar é fase própria | Nenhum impacto aqui |
| **P-7** | Campo livre de "motivo" na desativação? | Não (evita dado pessoal em auditoria imutável) | Muda schema de entrada e metadata |

**Resumo:** nenhuma decisão de produto bloqueia o subconjunto que não envolve
proprietário (alterar papel entre administrador/operador/voluntário,
desativar e sair para esses papéis). P-1 e P-2 definem as regras de
proprietário e de hierarquia e devem ser confirmadas antes de começar; os
padrões acima são consistentes com o código e a documentação existentes.

## 13. Implementação (Fase 73) — comportamento final e evidências

### 13.1 Decisões confirmadas

| ID | Decisão | Efeito implementado |
|---|---|---|
| **P-1 = SIM** | Mais de um proprietário; proprietário promove outro | `organization-members-role_POST` aceita `proprietario` como novo papel quando o ator tem `propriedade.gerencie`. Transferir propriedade = promover o sucessor e depois rebaixar-se ou sair |
| **P-2 = SIM** | Administrador altera outro administrador | Administrador altera/desativa operador, voluntário e outro administrador; **nunca** toca em proprietário (403) |
| P-3 a P-7 | Padrões da seção 12 | Ex-membros só para quem tem `membros.gerencie`; gestão bloqueada com a organização não `ativa`, exceto "Sair"; reativação só por novo convite; sem campo de motivo |

### 13.2 Endpoints

| Endpoint | Entrada | Regras |
|---|---|---|
| `organization-members-role_POST` | `organizationId`, `membershipId`, `role` | `membros.gerencie` + organização `ativa`. Alvo ou novo papel `proprietario` exige `propriedade.gerencie`. Auto-alteração só para baixo. Rebaixar proprietário exige outro proprietário ativo |
| `organization-members-deactivate_POST` | `organizationId`, `membershipId` | `membros.gerencie` + organização `ativa`. Não vale para si mesmo (409, usar "Sair"). Alvo proprietário: `propriedade.gerencie` + outro proprietário ativo. Desativação lógica (`inativo`), nunca `DELETE` |
| `organization-members-leave_POST` | `organizationId` | Basta ser membro ativo; funciona com a organização em qualquer status. Proprietário só sai havendo outro proprietário ativo (409) |

Erros: 400 (Zod), 401, 403 (`OrganizationAccessError`), 404 (membership de
outra organização ou inexistente), 409 (`ConflictError`), 429 (limite de 30/h
por usuário, bucket `organization-members`).

**Ordem das validações (ajuste da auditoria da Fase 73):** a autorização sobre
proprietário vem **antes** dos conflitos de estado. Quem não tem
`propriedade.gerencie` recebe 403 sempre ao tentar tocar em proprietário,
mesmo que ele já tenha saído; antes, o resultado dependia da ordem
(`409 "já não está ativo"` revelava o estado a quem não podia agir).

### 13.3 Permissão

`propriedade.gerencie` existe só em `proprietario` (`permissions.tsx`).
`administrador` tem as outras 19. O teste que fixava a igualdade entre os dois
papéis foi atualizado de propósito. Sair não exige permissão.

### 13.4 Invariante e locks

**I1 — toda organização tem ao menos um proprietário ativo**, garantida na
aplicação, sob lock, sem migration e sem trigger (T-2). Protocolo:

1. `SELECT … FROM organizations … FOR NO KEY UPDATE` (lock da organização);
2. membership do ator (relida e travada) → membership do alvo (filtrada pela
   organização) → convite;
3. todas as regras são revalidadas com o estado relido sob o lock.

Ordem global **organizations → memberships → organization_invites**, sem
exceção. O aceite de convite, que antes travava o convite antes da membership,
foi corrigido na auditoria (e deixou de usar `JOIN … FOR UPDATE`, que promovia
o lock da organização para `FOR UPDATE`). A exclusão de conta trava várias
organizações em ordem crescente de `id`.

### 13.5 Aceite de convite (A2)

- membro **ativo** → 409 ("Você já é membro desta organização"); papel
  intocado; o convite continua pendente;
- membro **inativo** → reativa com o papel **do convite**; auditoria
  `organizacao.convite_aceito` com `reativacao: true` e `papelAnterior`;
- convite **expirado** ou **revogado** → 410, não reativa;
- um novo convite revoga o anterior: o token antigo nunca tem precedência;
- convite não pode nomear `proprietario` (400).

### 13.6 Exclusão de conta (A1)

A verificação "único proprietário" roda **dentro** da transação, depois de
travar as organizações do usuário em ordem crescente de `id`. Se for o último
proprietário de alguma organização → 409; havendo outro proprietário ativo, a
exclusão prossegue. Provado por um teste determinístico (a exclusão espera o
lock) e por testes de concorrência.

### 13.7 Sessões

Nenhuma sessão é invalidada: o guard relê papel e status a cada requisição.
Provado: depois de rebaixar, a mesma sessão perde `membros.gerencie` na
requisição seguinte e continua lendo; depois de sair/ser desativado, recebe 403
e a organização some de `organizations_GET`, e a sessão segue válida para
outras organizações.

### 13.8 Auditoria

`organizacao.membro_papel_alterado` (`alvoUserId`, `papelAnterior`,
`papelNovo`), `organizacao.membro_desativado` (`alvoUserId`, `papelNoMomento`),
`organizacao.membro_saiu` (`papelNoMomento`) e `organizacao.convite_aceito`
(`reativacao`, `papelAnterior`). Só ids; nenhuma recusa gera evento; cadeia de
hash verificada pelos testes.

### 13.9 Interface

Aba Equipe: menu de ações por membro (só para quem gerencia, nunca na própria
linha, com os papéis permitidos pela matriz), "Sair da organização" para todos
(desabilitado para o único proprietário, com a explicação), seção recolhida de
ex-membros e diálogos de confirmação. O erro é mapeado pelo status HTTP
(`ApiRequestError`): **401** → aviso e `/login` com reset do cache; **403** →
mensagem estável e lista recarregada; **404**; **409** → mensagem do servidor
+ aviso de equipe alterada; **429**; qualquer outra falha → mensagem
genérica (texto de 5xx nunca é exibido). Alvos de toque de ~44 px (botões,
itens de menu, seletor e botões dos diálogos) em telas ≤ 768 px.

### 13.10 Evidências

- **Testes:** 460/460 (434 anteriores + 26 novos), em worktree isolado só com
  as alterações da fase e banco de teste próprio; typecheck dos dois projetos,
  `build`, `build:server` (57 endpoints) e `npm audit` (0).
- **Concorrência (Postgres real, `Promise.all`):** casos 1–6 do briefing,
  mistura de 8 operações, e provas determinísticas de que sair, aceitar convite
  e excluir conta **esperam o lock** e decidem com o estado confirmado.
- **Controle negativo:** removendo o lock da organização, os testes falham com
  `deadlock detected (40P01)`; removendo o lock da exclusão de conta, os testes
  de concorrência e o determinístico falham. Os locks foram restaurados.
- **Central Visual (aplicação real, banco descartável semeado com o seed
  oficial):** promoção a proprietário, desativação, saída, 409 por alteração
  concorrente, 403 por rebaixamento concorrente, 401 por sessão expirada;
  375, 390, 768 px e desktop; 8 rotas × 3 larguras sem overflow; `/plataforma`.

### 13.11 Limites conhecidos

- O "X" de fechar do componente `Dialog` compartilhado mede ~30 px; é
  anterior a esta fase e usado em todo o app.
- O `Input` compartilhado (`width: 100%` + `content-box`) segue como na
  Fase 69.
- Notificar por e-mail a pessoa afetada depende de SMTP (bloqueado).
