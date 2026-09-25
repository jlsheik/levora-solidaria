# RBAC granular por permissão

Antes desta mudança, cada endpoint checava o papel do usuário "na unha",
com uma lista de papéis permitidos repetida em ~18 arquivos diferentes
(`requireOrganizationMembership(user.id, orgId, ["proprietario", "administrador", "operador"])`).
Isso funcionava, mas violava fonte única de verdade: mudar quem pode fazer
o quê exigia caçar a mesma regra espalhada por vários arquivos, e não havia
nenhum lugar único para ver "o que cada papel pode fazer".

## Catálogo real, não a lista completa do master prompt

O master prompt (seção 10) lista permissões para domínios que não existem
neste sistema ainda — `beneficiaries.*`, `donors.*`, `financial.*`. Criar
essas permissões agora seria nomear controle de acesso sobre nada. O
catálogo em `src/helpers/permissions.tsx` (`ALL_PERMISSIONS`) só tem
permissões que pelo menos um endpoint real exige hoje:

```
membros.leia          membros.gerencie
inventario.leia       inventario.lance
necessidades.leia     necessidades.gerencie
oportunidades.leia    oportunidades.gerencie
atribuicoes.leia      atribuicoes.decida
logistica.leia        logistica.gerencie
arquivos.leia         arquivos.envie
aprovacoes.leia       aprovacoes.decida
auditoria.leia
relatorios.leia
```

## Mapeamento papel → permissões

Definido uma vez em `ROLE_PERMISSIONS` (`src/helpers/permissions.tsx`):

- **proprietario** e **administrador**: todas as permissões. Os dois papéis
  têm exatamente o mesmo conjunto hoje — a distinção entre eles no sistema
  atual não é de capacidade, é de quem criou a organização (convite não
  pode nomear "proprietario", ver `docs/CONVITE_DE_MEMBROS.md`). Se um
  fluxo futuro precisar de uma ação exclusiva de proprietário (transferir
  propriedade, excluir a organização), a diferença nasce como uma nova
  permissão que só `proprietario` tem — não como caso especial espalhado
  pelos endpoints.
- **operador**: todas as permissões operacionais (`*.leia`, `*.lance`,
  `*.gerencie`, `atribuicoes.decida`, `arquivos.envie`) — mas nenhuma
  administrativa (`membros.gerencie`, `aprovacoes.*`, `auditoria.leia`,
  `relatorios.leia`).
- **voluntario**: só `*.leia` — nunca lança, gerencia, decide ou envia
  nada. Só visualiza.

## Como usar

`src/helpers/organizationAccess.tsx` agora tem duas funções:

- `requireOrganizationMembership(userId, organizationId)` — só exige ser
  membro ativo, sem checar permissão nenhuma. Usado pelos endpoints de
  leitura que qualquer membro pode acessar (ex.: ver o próprio inventário).
- `requirePermission(userId, organizationId, permission)` — exige
  membership ativo E que o papel do usuário tenha a permissão nomeada.
  Usado por todo endpoint que antes tinha uma lista de papéis solta.

Nenhum endpoint deveria voltar a checar `membership.role` diretamente
contra uma lista — se uma ação nova precisar de controle de acesso,
adicionar a permissão em `permissions.tsx` primeiro.

## Testado

- Migração de 18 endpoints, sem quebrar nenhum dos 57 testes já existentes
  (a migração preservou exatamente o mesmo comportamento observável —
  mesmos códigos de status, mesmas mensagens de erro).
- 7 testes novos dedicados ao catálogo de permissões (`test/permissions.test.ts`):
  todo papel tem permissões definidas, proprietario/administrador
  idênticos, proprietario tem tudo, voluntário só tem leitura, voluntário
  nunca tem permissão administrativa, operador tem operacional mas não
  administrativa, e nenhum papel escreve sem poder ler o mesmo domínio.
- Testado com o app rodando de verdade: proprietária vê a trilha de
  auditoria normalmente; operadora (Vera) recebe 403 com
  `"Seu papel nesta organização não permite esta ação"` ao tentar acessar
  `/_api/audit-log` diretamente.

## O que ainda não existe

- Customização de permissões por organização (hoje o mapeamento
  papel→permissões é global, igual para todas as organizações). Isso
  exigiria uma tabela `role_permissions` por organização e uma tela de
  administração — não construída porque não há necessidade de negócio
  identificada ainda para customizar por organização.
- Interface para o admin ver/editar o catálogo de permissões — hoje é só
  código (`permissions.tsx`), consistente com o fato de não haver
  customização por organização ainda.
