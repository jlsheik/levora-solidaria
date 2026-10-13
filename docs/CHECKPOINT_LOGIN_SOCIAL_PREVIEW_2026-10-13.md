# Checkpoint — login social no preview integrado (2026-10-13)

## Diagnóstico

A ausência dos botões Google/Microsoft no preview original era causada por divergência entre worktrees/branches, não por CSS: o checkout principal `levora-solidaria` e a branch da Fase 94 não incluíam a integração social da linha Fase 92/93.3. A implementação já existia na worktree `levora-f933`, mas não havia sido integrada à Fase 94.

## Integração isolada

- Worktree: `C:\Users\JL\code\levora-f94-login-preview`
- Branch: `fase-94-login-integrado-preview`
- Base funcional da Fase 94: `6a1d209`
- Inclui UI e código de OAuth Google/Microsoft, MFA, identidade, sessões, códigos de acesso, migrations 0015–0020, testes e documentação das Fases 89–93.
- Mantém as correções funcionais, de layout e acessibilidade já presentes na Fase 94.
- O teste de regressão executado nesta integração passou: 13 arquivos, 386 testes, exit code 0. Builds cliente e servidor passaram; `npm audit` informou 0 vulnerabilidades.
- O primeiro teste completo de tentativa foi descartado porque a configuração de teste estava incompleta e houve processos de teste concorrentes. A validação válida foi repetida sequencialmente com o banco de teste.
- O projeto declara Node 22.x; o ambiente usado tinha Node 24.19.0. Builds e testes citados passaram nesse ambiente, mas essa diferença de versão deve ser levada em conta em homologação.
- Nenhum push ou deploy foi feito. O checkout principal, a worktree original Fase 94, a linha Microsoft Fase 93.3, os demais worktrees e o banco original não foram alterados.
- A integração foi criada numa worktree nova para não sobrescrever as alterações locais existentes no checkout que alimentava o preview do Claude.

## Configuração de provedores — importante

A presença dos botões não significa que o fluxo real esteja configurado/homologado.

- Google: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REDIRECT_URI` estavam ausentes/vazios nos ambientes locais inspecionados. Sem esses valores, o backend deve responder `google_nao_configurado`.
- Microsoft: a configuração local existe na worktree original Fase 93.3, mas não foi copiada para esta integração. Não copiar segredos implicitamente entre worktrees. Configurar as variáveis no ambiente local integrado, mantendo-as fora do Git, depois de conferir o redirect URI registrado.
- A autenticação Microsoft continua **NÃO QUALIFICADA para produção**: os testes sintéticos não substituem a qualificação real ainda pendente documentada em `docs/CHECKPOINT_MICROSOFT_OAUTH_FASE93_3.md`.
- Nenhum segredo, token, senha ou código de acesso foi incluído neste checkpoint.

## Preview isolado

A configuração do proxy Vite agora aceita `LEVORA_API_PROXY_TARGET`, preservando `http://localhost:3001` como padrão. Isso permite rodar o preview integrado em outra porta e direcionar suas chamadas para uma API isolada, sem interferir no servidor já aberto pelo checkout principal.

Para ver os botões, abrir no Claude/IDE a pasta `C:\Users\JL\code\levora-f94-login-preview` e reiniciar seu preview. O preview aberto no checkout antigo não muda automaticamente. A configuração de OAuth real deve ser concluída separadamente antes de usar os botões para autenticar.

## Próximas verificações

1. Executar um smoke test visual da rota `/login` na worktree integrada e confirmar que ambos os botões aparecem.
2. Confirmar que a API de preview aponta exclusivamente para banco descartável/local de teste, nunca para o banco original.
3. Configurar Google e Microsoft somente com credenciais autorizadas e URIs correspondentes; não imprimir variáveis secretas.
4. Revalidar os fluxos sociais com regressões e, quando houver as contas/condições humanas necessárias, qualificação real. Não declarar login social pronto para produção antes disso.
