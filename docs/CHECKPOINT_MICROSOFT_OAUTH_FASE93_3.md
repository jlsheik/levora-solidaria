# Checkpoint de continuidade — LEVORA SOLIDÁRIA / Microsoft OIDC — Fase 93.3

**Última verificação:** 2026-10-12 (horário de Brasília)  
**Workspace:** `C:\Users\JL\code\levora-f933`  
**Branch:** `fase-93-3-microsoft-qualificacao`  
**HEAD confirmado:** `2f34aa2254002a7c75bf9caab3cf9851aca6c5e4` (`2f34aa2 Fase 93.3: registra qualificacao real Microsoft bloqueada por configuracao`)  
**Estado Git na verificação:** limpo antes deste checkpoint; `.env` é ignorado pelo Git.

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
- Nenhum segredo do cliente foi criado até a última verificação.

## Estado local do ambiente

O arquivo `.env` **existe localmente e é ignorado pelo Git**. Foi confirmado sem imprimir valores:
- `MICROSOFT_CLIENT_ID`: definido e corresponde ao Client ID do registro acima.
- `MICROSOFT_CLIENT_SECRET`: vazio/ausente.
- `MICROSOFT_REDIRECT_URI`: definido e corresponde exatamente ao redirect URI registrado.
- `MICROSOFT_TENANT`: definido como `common`.

Último comando `npm run microsoft:preflight`:
- Client ID: definida.
- Client secret: AUSENTE.
- Redirect URI: definida.
- Tenant: definida.
- Resultado: configuração não aceita por falta de secret; nenhum login/token real foi testado nesse comando.

O código existente em `src/helpers/microsoftOidc.tsx` usa Authorization Code + PKCE S256 e scopes `openid profile email`; a auditoria documenta que não deve solicitar permissões Graph adicionais, nem `offline_access`. Consultar primeiro os testes/documentos existentes antes de alterar implementação.

## Próxima sequência segura

1. Retomar o **mesmo** registro `LevoraSolidariaAuth93`; verificar identidade de diretório e redirect URI, sem recriar aplicativo.
2. Se necessário, configurar apenas escopos OIDC mínimos `email`, `openid`, `profile`; não selecionar `offline_access` nem `User.Read`. Configurar a declaração opcional `email` no token ID somente após verificar a semântica suportada pelo fluxo e sem ampliar permissões indevidas.
3. Criar um segredo de cliente de curta duração (a UI recomenda 180 dias). Seu valor será mostrado uma única vez. O valor **não pode** ser impresso em snapshots, logs, saída de terminal ou chat. Salvá-lo diretamente no `.env` local ignorado pelo Git. Nunca salvar Secret ID no lugar do valor do segredo.
4. Executar `npm run microsoft:preflight`; deve informar presença das variáveis e validar o Discovery real sem mostrar segredos.
5. Executar testes reais de OAuth por conta pessoal e por conta corporativa/escolar, com o usuário fazendo diretamente senha/MFA/consentimentos quando necessário. Verificar `iss`, `tid`, `email` e o issuer da chave contra os tokens reais sem armazenar tokens brutos ou credenciais.
6. Rodar as verificações de regressão documentadas, atualizar a auditoria e manter o status como **não qualificado** até a evidência exigida estar completa.

## Continuidade de UI

O navegador utilizado é um perfil separado em `%LOCALAPPDATA%\LevoraMicrosoftPersonalProfile`, aberto pelo helper local `%LOCALAPPDATA%\Temp\entra-personal-browser.cjs`. Processo Node anteriormente ativo: PID 17924. A página estava no painel “Adicionar um segredo de cliente” (sem secret criado); duração recomendada visível: 180 dias. O helper é apenas mecanismo de navegação e não deve ler/imprimir valores de segredos. Se a conexão for interrompida, primeiro inspecionar os registros existentes e os segredos já criados no portal **antes de repetir qualquer mutação**.

## Não fazer

- Não colar segredos, códigos MFA, tokens ou senhas no chat.
- Não imprimir o conteúdo de `.env`, nem fazer `git add -f .env`.
- Não dar consentimento de administrador amplo, adicionar permissões Graph não exigidas pelo código, ou mudar para assinatura paga.
- Não declarar login “funcionando” antes de completar os testes reais exigidos.
