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
organizacao.gerencie
propriedade.gerencie    (só proprietário — Fase 73)
automacao.leia          automacao.gerencie   (Fase 74)
```

`automacao.leia` / `automacao.gerencie` (Fase 74): ver e tratar alertas de
integridade, decidir exceções das regras de proteção e pausar a automação da
própria organização. Só `proprietario` e `administrador` (menor privilégio:
operador e voluntário não veem alertas nem decidem exceções). A pausa/emergência
**global** não é uma permissão de organização: exige a **equipe da plataforma** (tabela `platform_access`: proprietário ou administrador da plataforma, via `requirePlatformAdmin`); `users.role` não é usado.

Fase 99K: a conciliação de comprovantes (`GET /destination-proofs-reconciliation`, somente leitura) exige `organizacao.gerencie`. Fase 99J (`docs/DESTINACAO_COMPROVANTES_99J.md`): anexar comprovante a destinação = `inventario.lance` (quem registrou, com o próprio arquivo) ou `organizacao.gerencie`; remover a referência = `organizacao.gerencie`; baixar `comprovante_destinacao` = `inventario.lance` + vínculo vigente; nenhuma permissão nova. Fase 99G (`docs/DESTINACAO_CORRECOES_99G.md`): reverter destinação (estorno documental, devolução física, correção de quantidade) exige `inventario.lance` **e** `organizacao.gerencie`; corrigir dados descritivos exige `inventario.lance` (apenas registros próprios, ou proprietário/administrador); listar destinações exige `inventario.lance`; nenhuma permissão nova. `necessidades.gerencie` também autoriza encerrar/reabrir necessidade (`POST /need-closure`, Fase 99F, `docs/ATENDIMENTO_NECESSIDADE_99F.md`); autorizar EXCEDENTE sobre o que falta da necessidade exige `organizacao.gerencie` (proprietário/administrador) — nenhuma permissão nova. `inventario.lance` autoriza o registro de saída com destinação (Fase 99E, `docs/DESTINACAO_REGISTRO_99E.md`); `organizacao.gerencie` também autoriza data retroativa (> 7 dias) nesse registro e `aprovacoes.decida` decide as saídas de alto risco (sem permissão nova). `organizacao.gerencie` (Fase 99C: também valida conferências, encerra casos e corrige a unidade da doação local na regularização de unidades — `docs/UNIDADES_REGULARIZACAO_99C.md`; a fila de pendências e a conferência usam `logistica.gerencie`; nenhuma permissão nova) (Fase 99B: também autoriza, só para leitura, o diagnóstico de unidades — `GET unit-inventory`, `docs/UNIDADES_INVENTARIO_99B.md`; nenhuma permissão nova) (Fase 21): edita capacidade por categoria, área de
atendimento e configuração de logística da própria organização (dados que
alimentam o motor de matching). Sem `organizacao.leia` correspondente —
ler essa configuração é aberto a qualquer membro ativo via
`requireOrganizationMembership` (é dado institucional, não sensível),
igual à leitura de inventário/necessidades.

## Mapeamento papel → permissões

Definido uma vez em `ROLE_PERMISSIONS` (`src/helpers/permissions.tsx`):

- **proprietario**: todas as permissões, inclusive `propriedade.gerencie`.
- **administrador**: todas as permissões **exceto `propriedade.gerencie`**,
  a única ação exclusiva de proprietário: qualquer operação de gestão de
  membros em que o alvo ou o novo papel seja `proprietario` (alterar,
  desativar ou promover). A diferença nasce numa permissão que só
  `proprietario` tem — não como caso especial espalhado pelos endpoints
  (ver `docs/MEMBROS_ESPECIFICACAO.md`, [T-7]). Convite continua sem poder
  nomear "proprietario"; o caminho para haver mais de um proprietário é a
  promoção por outro proprietário. Os dois papéis deixaram de ter o mesmo
  conjunto de propósito: `test/permissions.test.ts` agora fixa a diferença.
- **operador**: todas as permissões operacionais (`*.leia`, `*.lance`,
  `*.gerencie`, `atribuicoes.decida`, `arquivos.envie`) — mas nenhuma
  administrativa (`membros.gerencie`, `aprovacoes.*`, `auditoria.leia`,
  `relatorios.leia`, `organizacao.gerencie`).
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
