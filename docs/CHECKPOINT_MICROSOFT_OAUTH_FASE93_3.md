# Checkpoint de continuidade — LEVORA SOLIDÁRIA / Microsoft OIDC — Fase 93.3

**Última verificação:** 2026-10-12 (horário de Brasília)  
**Workspace:** `C:\Users\JL\code\levora-f933`  
**Branch:** `fase-93-3-microsoft-qualificacao`  
**HEAD inicial da fase:** `2f34aa2254002a7c75bf9caab3cf9851aca6c5e4` (`2f34aa2 Fase 93.3: registra qualificacao real Microsoft bloqueada por configuracao`)  
**Checkpoints commitados:** `3422010` (estado inicial), `e356ce7` (segredo criado, aguardando cópia local).  
**Estado Git após o checkpoint:** limpo; `.env` é ignorado pelo Git.

## Objetivo e restrições

Concluir a qualificação real do provedor Microsoft OIDC para **LEVORA SOLIDÁRIA**, sem reutilizar a identidade do LEVORA CRM. Não declarar a fase homologada sem login real com conta pessoal e conta corporativa/escolar, inspeção segura de claims e regressões exigidas pela auditoria. Nunca gravar segredos no Git, no checkpoint ou no chat. Não ativar assinatura pagável nem fazer upgrade para Pay-As-You-Go sem decisão explícita.

## Efeitos externos confirmados

Foi criado no diretório próprio `DEFAULT DIRECTORY (joaolucaspereiratavaresoutl.onmicrosoft.com)` o registro de aplicativo:

- Nome: `LevoraSolidariaAuth93`
- Client ID (público): `9284543b-64f9-497c-8f90-76219c23ff32`
- Tipos de conta selecionados: qualquer locatário Microsoft Entra **e** contas Microsoft pessoais.
- Plataforma: Web.
- Redirect URI registrado: `http://localhost:5173/_api/v1/auth/microsoft-callback`.
- O nome com acentos/em dash e a variante com espaços foram recusados pelo portal; o nome compacto acima foi criado com êxito. Não registrar outro aplicativo para contornar isso.
- A permissão padrão `Microsoft Graph / User.Read` foi removida com sucesso para reduzir permissões. A página de permissões mostrou “Nenhuma permissão adicionada”.
- A configuração de declarações opcionais está vazia na última verificação. Durante a tentativa anterior uma declaração incorreta `acct` foi adicionada e removida com sucesso; não consta atualmente na tabela. A declaração `email` ainda precisa ser configurada/validada com cuidado, mantendo o desenho de identidade mínima (`openid profile email`) e sem acrescentar acesso amplo ao Graph.
- O portal tem **1 segredo do cliente** com descrição `LEVORA SOLIDARIA Fase 93.3 - desenvolvimento local`, vencimento em **10/04/2027**. O usuário confirmou que copiou o valor para o `.env` local ignorado pelo Git. O valor em si nunca foi lido de volta nem impresso em logs, chat ou checkpoint.

## Estado local do ambiente

O arquivo `.env` **existe localmente e é ignorado pelo Git**. Foi confirmado sem imprimir valores:
- `MICROSOFT_CLIENT_ID`: definido e corresponde ao Client ID do registro acima.
- `MICROSOFT_CLIENT_SECRET`: definida (presença validada sem expor conteúdo).
- `MICROSOFT_REDIRECT_URI`: definido e corresponde exatamente ao redirect URI registrado.
- `MICROSOFT_TENANT`: definido como `common`.

`npm run microsoft:preflight` executado em 2026-10-12 após salvar o segredo:
- As quatro variáveis foram reconhecidas como definidas.
- O Discovery oficial real de `common` foi aceito; o preflight terminou com exit code 0.
- Isso ainda não valida troca de código nem ID token real.

O código existente em `src/helpers/microsoftOidc.tsx` usa Authorization Code + PKCE S256 e scopes `openid profile email`; a auditoria documenta que não deve solicitar permissões Graph adicionais, nem `offline_access`. Consultar primeiro os testes/documentos existentes antes de alterar implementação.

## Próxima sequência segura

1. Retomar o **mesmo** registro `LevoraSolidariaAuth93`; verificar identidade de diretório e redirect URI, sem recriar aplicativo.
2. Se necessário, configurar apenas escopos OIDC mínimos `email`, `openid`, `profile`; não selecionar `offline_access` nem `User.Read`. Configurar a declaração opcional `email` no token ID somente após verificar a semântica suportada pelo fluxo e sem ampliar permissões indevidas.
3. O segredo de cliente de 180 dias já foi criado. **Não criar outro** sem antes confirmar se o atual está utilizável. O valor aparece uma única vez no portal e ainda precisa ser copiado localmente para `MICROSOFT_CLIENT_SECRET=` em `.env`. Não imprimir o valor em snapshots, logs, terminal ou chat; não confundir o Secret ID com o valor.
4. Executar `npm run microsoft:preflight`; deve informar presença das variáveis e validar o Discovery real sem mostrar segredos.
5. Executar testes reais de OAuth por conta pessoal e por conta corporativa/escolar, com o usuário fazendo diretamente senha/MFA/consentimentos quando necessário. Verificar `iss`, `tid`, `email` e o issuer da chave contra os tokens reais sem armazenar tokens brutos ou credenciais.
6. Rodar as verificações de regressão documentadas, atualizar a auditoria e manter o status como **não qualificado** até a evidência exigida estar completa.

## Continuidade de UI

O navegador utilizado é um perfil separado em `%LOCALAPPDATA%\LevoraMicrosoftPersonalProfile`, aberto pelo helper local `%LOCALAPPDATA%\Temp\entra-personal-browser.cjs`. Processo Node atual: PID 27316. O portal confirmou `Segredos do cliente (1)` e vencimento em 10/04/2027; o helper substitui o conteúdo adjacente a `Valor` por `[valor oculto]`. O segredo não consta ainda no `.env`. Se a conexão for interrompida, primeiro inspecionar os registros existentes e os segredos já criados **antes de repetir qualquer mutação**.

## Não fazer

- Não colar segredos, códigos MFA, tokens ou senhas no chat.
- Não imprimir o conteúdo de `.env`, nem fazer `git add -f .env`.
- Não dar consentimento de administrador amplo, adicionar permissões Graph não exigidas pelo código, ou mudar para assinatura paga.
- Não declarar login “funcionando” antes de completar os testes reais exigidos.

## Atualização de continuidade — preflight concluído e ambiente isolado

Em 2026-10-12 o usuário confirmou que salvou o segredo localmente. O estado das quatro variáveis foi verificado só por presença; Client ID, redirect URI e tenant correspondem à configuração registrada; o .env continua ignorado pelo Git. O comando npm run microsoft:preflight terminou com código 0: Discovery real common aceito. Nenhum login real foi concluído nesta atualização.

Não foi seguro migrar o banco local existente: nele há 3 administradores legados ativos e a migração 0015 exige escolha explícita de um único Platform Owner. Antes de avançar, foi criado backup íntegro em C:\Users\JL\code\levora-solidaria\backups\levora_solidaria_pre_fase93_20261012.dump (142568 bytes; SHA-256 3BDD4C5D0C1FE98E55FC7769A97189306B93B72784D505254306C299C52BB514; 334 itens no pg_restore --list). O banco original não recebeu migrações.

Foi criado o banco de teste isolado levora_f933_test, usando npm run db:migrate apenas no banco vazio. As tabelas user_identities, registration_access_codes e oauth_attempts existem; há 19 entradas de migração. O .env deste worktree aponta para localhost:5433/levora_f933_test. Chaves auxiliares de desenvolvimento foram geradas localmente, sem serem impressas ou versionadas.

Serviços locais iniciados:
- API: PID 25328, npm run dev, 78 endpoints descobertos.
- Vite: PID 19216, npm run client:dev, http://localhost:5173.
- Health: http://localhost:3001/_api/__health respondeu HTTP 200 com status ok, 78 endpoints e API v1; /login respondeu HTTP 200.
- Edge InPrivate aberto em http://localhost:5173/login. Próxima ação manual: clicar em “Entrar com Microsoft” na aba “Entrar” e autenticar uma conta pessoal. Não usar “Criar conta” ainda: o banco de teste está sem códigos de acesso. Caso o token valide e a conta ainda não esteja vinculada, o retorno “Esta conta não está vinculada à Microsoft” é esperado.
- Não coletar nem registrar senha, MFA, código, state, token, cookie ou URL de callback completa. Microsoft OIDC permanece NÃO QUALIFICADO até testes reais pessoal e corporativo/escolar, e regressões relevantes.

## Regressões automatizadas após isolar o ambiente

- A primeira tentativa de regressões foi inválida por falta do .env.test no worktree. Corrigido localmente com um .env.test ignorado pelo Git, banco levora_f933_vitest_test dedicado e JWT de teste sintético; nenhum código-fonte do produto foi alterado por essa correção de ambiente.
- Reexecução: microsoftAuth.test.ts + microsoftSecurity.test.ts + microsoftLifecycle.test.ts — 3 arquivos passaram, 93/93 testes passaram.
- Teste opt-in de leitura pública: microsoftRealDiscovery.test.ts com MICROSOFT_REAL_DISCOVERY=1 — 3/3 testes passaram. Ele validou Discovery/JWKS públicos de common, organizations e consumers; não usa credenciais e não é login real.
- A autenticação real com conta pessoal continua aguardando interação manual na janela Edge InPrivate. O teste corporativo/escolar também permanece pendente; não declarar a Fase 93.3 homologada.
