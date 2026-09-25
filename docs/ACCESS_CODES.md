# Códigos de ativação de organização

Master prompt, seção 142 (documentação obrigatória) e seção 9 (código de
acesso gerado pelo administrador da plataforma para ativar uma nova
organização).

## Estado real: fluxo diferente do descrito na seção 9

A seção 9 do master prompt descreve um fluxo específico: admin da
plataforma gera um código (`LS-8M4K-72Q9-X5`) para uma organização
específica, com validade e limite de ativações, a organização usa o código
para se ativar. **Esse fluxo não existe neste sistema.** O que existe é
diferente:

```
Usuário se cadastra (auth/register_with_password)
       ↓
Usuário cria a organização (organizations_POST) — vira "proprietario"
automaticamente, status inicial "em_analise"
       ↓
Admin de plataforma revisa e aprova/suspende
(platform-organizations-status_POST) — muda o status para "ativa"
```

Não há geração de código, não há hash de código, não há expiração de
código, não há limite de tentativas de ativação — porque não há código
nenhum. A organização nasce diretamente da ação de quem quer criá-la, e o
controle de qualidade acontece depois, pela aprovação do admin de
plataforma, não antes por um código que só ele pode gerar.

## Por que essa decisão foi tomada (ou por que não foi corrigida ainda)

Este documento não vai fingir uma justificativa que não foi tomada
deliberadamente — a auditoria que levou a esta documentação (ver
`src/static/__dev/docs/plano-implementacao.md`, Fase 1) mostra que o fluxo
de auto-cadastro + aprovação foi o que a Fase 1 implementou, e o fluxo de
código de ativação da seção 9 nunca foi revisitado depois. É uma lacuna
real, não uma decisão de arquitetura documentada como as outras deste
projeto (convite de membro, upload de arquivo, etc., que têm um "por quê"
registrado).

## Risco de segurança da lacuna (RESOLVIDO)

Sem código de ativação, qualquer pessoa cadastrada podia criar uma
organização e começar a operá-la (cadastrar necessidades, inventário, etc.)
antes de qualquer aprovação — ficava com status "em_analise" até o admin
agir, mas nada no código impedia as ações operacionais de uma organização
"em_analise". **Corrigido**: `requirePermission`
(`src/helpers/organizationAccess.tsx`) agora também exige
`organizations.status === 'ativa'`, além de membership ativo e a permissão
nomeada — qualquer uma das 18 ações restritas por permissão (lançar
estoque, convidar membro, decidir aprovação, etc., ver
`docs/RBAC_PERMISSOES.md`) retorna 403 com
"Esta organização ainda não tem acesso liberado — aguardando aprovação da
equipe da Levora Solidária" enquanto a organização não for aprovada.

**Decisão de escopo**: a checagem fica só em `requirePermission`, não em
`requireOrganizationMembership` — o dono de uma organização "em_analise"
continua conseguindo VER os próprios dados (inventário, necessidades,
membros) enquanto espera aprovação; só as ações restritas por permissão
ficam bloqueadas. Isso inclui convidar membros para ajudar a preparar a
organização antes da aprovação — decisão deliberada de errar para o lado
mais restritivo (segurança antes de conveniência, como o master prompt
pede), revisável se virar um problema de UX real.

Testado (`test/organizationStatusGate.test.ts`): ação bloqueada com
organização "em_analise"/"suspensa", permitida assim que aprovada, leitura
não afetada em nenhum dos dois casos.

## Se o fluxo de código de ativação da seção 9 for implementado

Precisa seguir as regras já corretamente aplicadas em outro fluxo de
token deste sistema (convite de membro, ver `docs/CONVITE_DE_MEMBROS.md`):
nunca guardar o código em texto puro (só hash), aleatório
criptograficamente seguro, expiração configurável, uso único por padrão,
registro de quem gerou/quando/quando foi usado, limite de tentativas e
rate limiting na validação (mesmo padrão de
`src/helpers/rateLimit.tsx`), e nunca mostrar o código de novo depois da
exibição inicial.
