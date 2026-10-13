# Checkpoint de continuidade â€” LEVORA SOLIDÃRIA / Microsoft OIDC â€” Fase 93.3

> **ESTADO MAIS RECENTE â€” 12/10/2026:** App Registration exclusivo da LEVORA SOLIDÃRIA existe; o segredo estÃ¡ no .env local ignorado pelo Git; preflight 0. O login real com conta pessoal chegou ao ramo â€œEsta conta nÃ£o estÃ¡ vinculada Ã  Microsoftâ€, apÃ³s troca do cÃ³digo e validaÃ§Ã£o do ID token; nenhum usuÃ¡rio/vÃ­nculo foi criado. RegressÃµes sintÃ©ticas: 93/93; Discovery/JWKS pÃºblicos reais: 3/3. O usuÃ¡rio nÃ£o tem conta corporativa/escolar nem cÃ³digo vÃ¡lido disponÃ­vel agora. NÃ£o insistir nesse teste, nÃ£o fabricar identidade/cÃ³digo na base da aplicaÃ§Ã£o e nÃ£o declarar produÃ§Ã£o homologada.



**Ãšltima verificaÃ§Ã£o:** 2026-10-12 (horÃ¡rio de BrasÃ­lia)
**Workspace:** `C:\Users\JL\code\levora-f933`\
**Branch:** `fase-93-3-microsoft-qualificacao`\
**HEAD inicial da fase:** `2f34aa2254002a7c75bf9caab3cf9851aca6c5e4` (`2f34aa2 Fase 93.3: registra qualificacao real Microsoft bloqueada por configuracao`)\
**Checkpoints commitados:** `3422010` (estado inicial), `e356ce7` (segredo criado, aguardando cÃ³pia local).\
**Estado Git apÃ³s o checkpoint:** limpo; `.env` Ã© ignorado pelo Git.

## Objetivo e restriÃ§Ãµes

Concluir a qualificaÃ§Ã£o real do provedor Microsoft OIDC para **LEVORA SOLIDÃRIA**, sem reutilizar a identidade do LEVORA CRM. NÃ£o declarar a fase homologada sem login real com conta pessoal e conta corporativa/escolar, inspeÃ§Ã£o segura de claims e regressÃµes exigidas pela auditoria. Nunca gravar segredos no Git, no checkpoint ou no chat. NÃ£o ativar assinatura pagÃ¡vel nem fazer upgrade para Pay-As-You-Go sem decisÃ£o explÃ­cita.

## Efeitos externos confirmados

Foi criado no diretÃ³rio prÃ³prio `DEFAULT DIRECTORY (joaolucaspereiratavaresoutl.onmicrosoft.com)` o registro de aplicativo:

- Nome: `LevoraSolidariaAuth93`
- Client ID (pÃºblico): `9284543b-64f9-497c-8f90-76219c23ff32`
- Tipos de conta selecionados: qualquer locatÃ¡rio Microsoft Entra **e** contas Microsoft pessoais.
- Plataforma: Web.
- Redirect URI registrado: `http://localhost:5173/_api/v1/auth/microsoft-callback`.
- O nome com acentos/em dash e a variante com espaÃ§os foram recusados pelo portal; o nome compacto acima foi criado com Ãªxito. NÃ£o registrar outro aplicativo para contornar isso.
- A permissÃ£o padrÃ£o `Microsoft Graph / User.Read` foi removida com sucesso para reduzir permissÃµes. A pÃ¡gina de permissÃµes mostrou â€œNenhuma permissÃ£o adicionadaâ€.
- A configuraÃ§Ã£o de declaraÃ§Ãµes opcionais estÃ¡ vazia na Ãºltima verificaÃ§Ã£o. Durante a tentativa anterior uma declaraÃ§Ã£o incorreta `acct` foi adicionada e removida com sucesso; nÃ£o consta atualmente na tabela. A declaraÃ§Ã£o `email` ainda precisa ser configurada/validada com cuidado, mantendo o desenho de identidade mÃ­nima (`openid profile email`) e sem acrescentar acesso amplo ao Graph.
- O portal tem **1 segredo do cliente** com descriÃ§Ã£o `LEVORA SOLIDARIA Fase 93.3 - desenvolvimento local`, vencimento em **10/04/2027**. O usuÃ¡rio confirmou que copiou o valor para o `.env` local ignorado pelo Git. O valor em si nunca foi lido de volta nem impresso em logs, chat ou checkpoint.

## Estado local do ambiente

O arquivo `.env` **existe localmente e Ã© ignorado pelo Git**. Foi confirmado sem imprimir valores:
- `MICROSOFT_CLIENT_ID`: definido e corresponde ao Client ID do registro acima.
- `MICROSOFT_CLIENT_SECRET`: definida (presenÃ§a validada sem expor conteÃºdo).
- `MICROSOFT_REDIRECT_URI`: definido e corresponde exatamente ao redirect URI registrado.
- `MICROSOFT_TENANT`: definido como `common`.

`npm run microsoft:preflight` executado em 2026-10-12 apÃ³s salvar o segredo:
- As quatro variÃ¡veis foram reconhecidas como definidas.
- O Discovery oficial real de `common` foi aceito; o preflight terminou com exit code 0.
- Isso ainda nÃ£o valida troca de cÃ³digo nem ID token real.

O cÃ³digo existente em `src/helpers/microsoftOidc.tsx` usa Authorization Code + PKCE S256 e scopes `openid profile email`; a auditoria documenta que nÃ£o deve solicitar permissÃµes Graph adicionais, nem `offline_access`. Consultar primeiro os testes/documentos existentes antes de alterar implementaÃ§Ã£o.

## PrÃ³xima sequÃªncia segura

1. Retomar o **mesmo** registro `LevoraSolidariaAuth93`; verificar identidade de diretÃ³rio e redirect URI, sem recriar aplicativo.
2. Se necessÃ¡rio, configurar apenas escopos OIDC mÃ­nimos `email`, `openid`, `profile`; nÃ£o selecionar `offline_access` nem `User.Read`. Configurar a declaraÃ§Ã£o opcional `email` no token ID somente apÃ³s verificar a semÃ¢ntica suportada pelo fluxo e sem ampliar permissÃµes indevidas.
3. O segredo de cliente de 180 dias jÃ¡ foi criado. **NÃ£o criar outro** sem antes confirmar se o atual estÃ¡ utilizÃ¡vel. O valor aparece uma Ãºnica vez no portal e ainda precisa ser copiado localmente para `MICROSOFT_CLIENT_SECRET=` em `.env`. NÃ£o imprimir o valor em snapshots, logs, terminal ou chat; nÃ£o confundir o Secret ID com o valor.
4. Executar `npm run microsoft:preflight`; deve informar presenÃ§a das variÃ¡veis e validar o Discovery real sem mostrar segredos.
5. Executar testes reais de OAuth por conta pessoal e por conta corporativa/escolar, com o usuÃ¡rio fazendo diretamente senha/MFA/consentimentos quando necessÃ¡rio. Verificar `iss`, `tid`, `email` e o issuer da chave contra os tokens reais sem armazenar tokens brutos ou credenciais.
6. Rodar as verificaÃ§Ãµes de regressÃ£o documentadas, atualizar a auditoria e manter o status como **nÃ£o qualificado** atÃ© a evidÃªncia exigida estar completa.

## Continuidade de UI

O navegador utilizado Ã© um perfil separado em `%LOCALAPPDATA%\LevoraMicrosoftPersonalProfile`, aberto pelo helper local `%LOCALAPPDATA%\Temp\entra-personal-browser.cjs`. Processo Node atual: PID 27316. O portal confirmou `Segredos do cliente (1)` e vencimento em 10/04/2027; o helper substitui o conteÃºdo adjacente a `Valor` por `[valor oculto]`. O segredo nÃ£o consta ainda no `.env`. Se a conexÃ£o for interrompida, primeiro inspecionar os registros existentes e os segredos jÃ¡ criados **antes de repetir qualquer mutaÃ§Ã£o**.

## NÃ£o fazer

- NÃ£o colar segredos, cÃ³digos MFA, tokens ou senhas no chat.
- NÃ£o imprimir o conteÃºdo de `.env`, nem fazer `git add -f .env`.
- NÃ£o dar consentimento de administrador amplo, adicionar permissÃµes Graph nÃ£o exigidas pelo cÃ³digo, ou mudar para assinatura paga.
- NÃ£o declarar login â€œfuncionandoâ€ antes de completar os testes reais exigidos.

## AtualizaÃ§Ã£o de continuidade â€” preflight concluÃ­do e ambiente isolado

Em 2026-10-12 o usuÃ¡rio confirmou que salvou o segredo localmente. O estado das quatro variÃ¡veis foi verificado sÃ³ por presenÃ§a; Client ID, redirect URI e tenant correspondem Ã  configuraÃ§Ã£o registrada; o .env continua ignorado pelo Git. O comando npm run microsoft:preflight terminou com cÃ³digo 0: Discovery real common aceito. O primeiro fluxo real com uma conta pessoal foi concluÃ­do atÃ© a consulta do vÃ­nculo: o app retornou â€œconta nÃ£o vinculada Ã  Microsoftâ€, a resposta de negÃ³cio esperada depois da validaÃ§Ã£o do ID token e da busca por (provider, issuer, subject). Isso confirma que o fluxo OIDC real alcanÃ§ou a etapa posterior Ã  validaÃ§Ã£o, mas ainda nÃ£o qualifica login em conta jÃ¡ vinculada.

NÃ£o foi seguro migrar o banco local existente: nele hÃ¡ 3 administradores legados ativos e a migraÃ§Ã£o 0015 exige escolha explÃ­cita de um Ãºnico Platform Owner. Antes de avanÃ§ar, foi criado backup Ã­ntegro em C:\Users\JL\code\levora-solidaria\backups\levora_solidaria_pre_fase93_20261012.dump (142568 bytes; SHA-256 3BDD4C5D0C1FE98E55FC7769A97189306B93B72784D505254306C299C52BB514; 334 itens no pg_restore --list). O banco original nÃ£o recebeu migraÃ§Ãµes.

Foi criado o banco de teste isolado levora_f933_test, usando npm run db:migrate apenas no banco vazio. As tabelas user_identities, registration_access_codes e oauth_attempts existem; hÃ¡ 19 entradas de migraÃ§Ã£o. O .env deste worktree aponta para localhost:5433/levora_f933_test. Chaves auxiliares de desenvolvimento foram geradas localmente, sem serem impressas ou versionadas.

ServiÃ§os locais iniciados:
- API: PID 25328, npm run dev, 78 endpoints descobertos.
- Vite: PID 19216, npm run client:dev, http://localhost:5173.
- Health: http://localhost:3001/_api/__health respondeu HTTP 200 com status ok, 78 endpoints e API v1; /login respondeu HTTP 200.
- Teste real de conta pessoal efetuado em Edge InPrivate: apÃ³s â€œEntrar com Microsoftâ€ e autenticar manualmente, a tela retornou â€œEsta conta nÃ£o estÃ¡ vinculada Ã  Microsoftâ€, resultado esperado no ramo de negÃ³cio posterior Ã  verificaÃ§Ã£o do ID token e da busca por identidade. VerificaÃ§Ã£o read-only do banco levora_f933_test apÃ³s esse callback: users=0, user_identities com provider Microsoft=0, oauth_attempts=1 com status failed=1. Nenhuma conta foi criada nem identidade vinculada, conforme esperado para intent=login. NÃ£o usar â€œCriar contaâ€ nesta fase: o banco de teste nÃ£o tem cÃ³digos de acesso.
- NÃ£o coletar nem registrar senha, MFA, cÃ³digo, state, token, cookie ou URL de callback completa. Microsoft OIDC permanece NÃƒO QUALIFICADO atÃ© testes reais pessoal e corporativo/escolar, e regressÃµes relevantes.

## RegressÃµes automatizadas apÃ³s isolar o ambiente

- A primeira tentativa de regressÃµes foi invÃ¡lida por falta do .env.test no worktree. Corrigido localmente com um .env.test ignorado pelo Git, banco levora_f933_vitest_test dedicado e JWT de teste sintÃ©tico; nenhum cÃ³digo-fonte do produto foi alterado por essa correÃ§Ã£o de ambiente.
- ReexecuÃ§Ã£o: microsoftAuth.test.ts + microsoftSecurity.test.ts + microsoftLifecycle.test.ts â€” 3 arquivos passaram, 93/93 testes passaram.
- Teste opt-in de leitura pÃºblica: microsoftRealDiscovery.test.ts com MICROSOFT_REAL_DISCOVERY=1 â€” 3/3 testes passaram. Ele validou Discovery/JWKS pÃºblicos de common, organizations e consumers; nÃ£o usa credenciais e nÃ£o Ã© login real.
- A autenticaÃ§Ã£o real com conta pessoal continua aguardando interaÃ§Ã£o manual na janela Edge InPrivate. O teste corporativo/escolar tambÃ©m permanece pendente; nÃ£o declarar a Fase 93.3 homologada.

## Resultado do primeiro login real â€” conta pessoal

O usuÃ¡rio concluiu um fluxo real com uma conta Microsoft pessoal e viu a mensagem â€œEsta conta nÃ£o estÃ¡ vinculada Ã  Microsoftâ€. No cÃ³digo, essa resposta Ã© retornada apenas depois de exchangeAndVerify concluir a validaÃ§Ã£o do ID token e a consulta da identidade por provider + issuer + subject nÃ£o encontrar vÃ­nculo. Portanto, o teste demonstra que o Authorization Code + PKCE, a troca do cÃ³digo e a validaÃ§Ã£o real do ID token chegaram ao ramo esperado de identidade ainda nÃ£o vinculada; nÃ£o Ã© evidÃªncia de login numa conta previamente associada.

VerificaÃ§Ã£o read-only no banco isolado levora_f933_test apÃ³s o callback:
- users: 0.
- user_identities Microsoft: 0.
- oauth_attempts: 1, status failed: 1 (resultado esperado ao nÃ£o encontrar vÃ­nculo).
- Nenhum usuÃ¡rio ou vÃ­nculo foi criado. NÃ£o foi inspecionado nem guardado qualquer token, e-mail, cookie, code ou state.

PrÃ³xima aÃ§Ã£o: testar uma conta corporativa/escolar autorizada. Na janela InPrivate, repetir â€œEntrar com Microsoftâ€; no seletor da Microsoft, escolher â€œUsar outra contaâ€/â€œEntrar com outra contaâ€ para nÃ£o reutilizar a sessÃ£o pessoal. O resultado de â€œnÃ£o vinculadaâ€ tambÃ©m serÃ¡ esperado se ainda nÃ£o houver identidade corporativa vinculada. Confirmar sÃ³ o texto visÃ­vel, nunca enviar credenciais ou dados do token.


## AtualizaÃ§Ã£o de continuidade â€” limitaÃ§Ã£o humana confirmada e reteste seguro (2026-10-12)

O usuÃ¡rio confirmou que **nÃ£o possui atualmente uma conta LEVORA vinculada Ã  Microsoft**, nÃ£o dispÃµe de uma conta corporativa/escolar Microsoft para o cenÃ¡rio adicional e **nÃ£o consegue emitir um cÃ³digo de acesso vÃ¡lido neste momento**. NÃ£o insistir nesse teste agora e nÃ£o contornar os controles criando usuÃ¡rio/vÃ­nculo/cÃ³digo fictÃ­cio em banco de aplicaÃ§Ã£o. Essa limitaÃ§Ã£o humana nÃ£o impede executar regressÃµes sintÃ©ticas isoladas.

### VerificaÃ§Ãµes repetidas nesta retomada

- npm run test -- test/microsoftAuth.test.ts test/microsoftSecurity.test.ts test/microsoftLifecycle.test.ts: **3 arquivos, 93/93 testes passaram**, exit code 0. Inclui cadastro sintÃ©tico com cÃ³digo gerado pelo helper de teste, criaÃ§Ã£o de identidade Microsoft sintÃ©tica, login vinculado, controles de seguranÃ§a, ciclo de vida, MFA, exclusÃ£o/reauth e concorrÃªncia. Isso comprova a nossa implementaÃ§Ã£o com fixtures, nÃ£o autenticaÃ§Ã£o real de uma conta vinculada.
- MICROSOFT_REAL_DISCOVERY=1 npm run test -- test/microsoftRealDiscovery.test.ts: **1 arquivo, 3/3 testes passaram**, exit code 0. Discovery/JWKS pÃºblicos de common, organizations e consumers, sem credenciais ou login.
- npm run microsoft:preflight: **exit code 0**. As variÃ¡veis obrigatÃ³rias estÃ£o definidas apenas por presenÃ§a, o redirect URI corresponde Ã  configuraÃ§Ã£o local e o Discovery real foi aceito; nenhum segredo foi impresso.
- A tentativa real anterior com conta Microsoft pessoal chegou Ã  resposta de negÃ³cio â€œEsta conta nÃ£o estÃ¡ vinculada Ã  Microsoftâ€. O banco isolado registrou somente a tentativa OAuth falha esperada; nÃ£o criou usuÃ¡rio nem user_identities Microsoft. O caminho real demonstra troca/validaÃ§Ã£o do ID token antes de procurar o vÃ­nculo, mas nÃ£o prova o login final de conta jÃ¡ vinculada.

### PrÃ³ximos limites e retomada

Nenhum cÃ³digo de acesso Ã© necessÃ¡rio para a intenÃ§Ã£o **login**; o cÃ³digo sÃ³ Ã© necessÃ¡rio para **cadastro**. Para a qualificaÃ§Ã£o real restante, dependem de uma interaÃ§Ã£o humana futura uma conta Microsoft corporativa/escolar autorizada e, caso se queira provar o cadastro real de uma identidade nova, um cÃ³digo legÃ­timo emitido pelo fluxo administrativo. NÃ£o gerar bypass nem inserir linhas artificiais no banco da aplicaÃ§Ã£o para simular esses fatos.

**Estado continua: Microsoft OIDC NÃƒO QUALIFICADA para produÃ§Ã£o.** Enquanto a conta corporativa/escolar nÃ£o estiver disponÃ­vel, seguir apenas com auditorias, regressÃµes sintÃ©ticas isoladas e documentaÃ§Ã£o; manter explÃ­cita a distinÃ§Ã£o entre verificaÃ§Ãµes locais/sintÃ©ticas e login real. Worktree inicial estava limpo em 31bf0dc; nenhuma alteraÃ§Ã£o de cÃ³digo de produto foi feita nesta retomada.

## AtualizaÃ§Ã£o â€” continuaÃ§Ã£o independente de conta real/cÃ³digo (2026-10-12)

- Auditoria ponta a ponta e novos testes de resiliÃªncia/higiene: ver Â§22 de `docs/IDENTIDADE_FASE93_MICROSOFT_AUDITORIA.md`.
- CÃ³digo alterado (defeito demonstrado): `safeEmail`/`cleanDisplayName` em `src/helpers/microsoftOidc.tsx` (e-mail malformado â‡’ ausente; nome sem controle/bidi). Testes: `test/microsoftResilience.test.ts` (13). Microsoft sintÃ©tico: 106/106.
- EvidÃªncia real nova (sem dado sensÃ­vel): o evento de auditoria `login_microsoft_falhou/identidade_nao_vinculada` do login pessoal prova que o ID token real passou por TODA a validaÃ§Ã£o (inclui o `issuer` da chave fail-closed) antes da busca de vÃ­nculo.
- **Continua NÃƒO QUALIFICADA.** Pendentes humanos: conta corporativa/escolar, identidade vinculada/cadastro (exige cÃ³digo legÃ­timo emitido pelo fluxo administrativo), MFA/reauth/exclusÃ£o reais, negativos reais. NÃ£o fabricar conta/cÃ³digo/vÃ­nculo no banco.

## AtualizaÃ§Ã£o â€” revisÃ£o de 8a5a0c0 e higiene de segredos (2026-10-12)

- Defeito achado na revisÃ£o e corrigido: regex global com `.test()` guardava `lastIndex` entre chamadas (e-mail seguinte podia escapar da checagem de invisÃ­veis/bidi). Teste de regressÃ£o em `test/microsoftResilience.test.ts`.
- Novo `test/secretsHygiene.test.ts`; varredura do segredo real/JWT/chaves do `.env` na Ã¡rvore e no histÃ³rico: 0 ocorrÃªncias (sÃ³ contagens, nenhum valor impresso).
- Parte executÃ¡vel da Slice 93.3 concluÃ­da; **Microsoft continua NÃƒO QUALIFICADA**. Detalhes: Â§23 da auditoria.
