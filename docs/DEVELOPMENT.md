# Desenvolvimento — Levora Solidária

Guia curto de como manter o repositório seguro durante o desenvolvimento.
Não é um manual de Git: só registra o que já deu problema neste projeto.

## Estado consolidado (Fase 67)

As Fases 48–66 (segurança, rate limiting, auditoria, CI, build do backend,
staging zero-custo, pools de conexão, timeout de IA, classificação de erros)
foram desenvolvidas em sequência **sem commit intermediário** e consolidadas
num único commit de checkpoint na Fase 67. A partir dele:

- `git log` é o ponto de retorno confiável. Tudo que está nele passou em
  `npm run typecheck`, `npm test`, `npm run build`, `npm run build:server` e
  `npm audit --audit-level=moderate`.
- Migrations só crescem (`db/migrations/0001…0013`). Nunca edite uma
  migration já aplicada: crie a próxima.
- `db/schema.sql` deve refletir o resultado de todas as migrations.

## Commite antes de qualquer operação destrutiva

O que não está em um commit **não tem como ser recuperado** pelo Git.
`git status` limpo (ou trabalho aprovado já commitado) é a condição para
fazer qualquer coisa que reescreva o working tree.

Incidente real (Fase 66): ao desfazer uma alteração temporária de teste com
`git checkout -- src/helpers/db.tsx`, o arquivo voltou ao **último commit** —
que ainda era anterior à Fase 48 — e a correção de pool da Fase 62 (que só
existia no working tree) foi apagada. Foi reconstruída à mão e revalidada;
isso só foi possível porque o conteúdo correto ainda era conhecido.

## `git checkout -- <arquivo>` não "desfaz a minha última edição"

Há duas intenções diferentes que parecem iguais:

| Quero… | O que `git checkout -- arquivo` faz |
| --- | --- |
| Descartar uma alteração **temporária** que acabei de fazer | Só é seguro se o arquivo **não tinha** alterações aprovadas e não commitadas antes dela |
| Voltar ao **último commit** | É exatamente o que ele faz — apaga **todas** as alterações não commitadas do arquivo, inclusive as aprovadas |

Antes de reverter qualquer arquivo com alterações não commitadas:

1. Veja o que será perdido: `git diff -- arquivo`.
2. Se houver qualquer coisa que vale manter, guarde antes:
   `git stash push -- arquivo` (recuperável com `git stash pop`), ou faça um
   commit.
3. Para experimentos temporários, prefira editar, testar e desfazer a edição
   manualmente — ou trabalhar em um branch/commit próprio.

O mesmo vale para `git restore`, `git reset --hard` e `git clean -fd`.

## Nunca vai para o commit

`.env*`, `.staging-runtime/` (contém `STAGING_JWT_SECRET`), `backups/`,
`dist/`, `dist-server/`, `node_modules/`, dados de staging e a pasta
`graphify-out/` (gerada). `.gitignore` cobre os quatro primeiros; confira
`git status` antes de commitar.

## Rotina mínima antes de commitar

```bash
npm run typecheck && npm test && npm run build && npm run build:server
npm audit --audit-level=moderate
git status --short   # só o que você espera
```

Não rode duas execuções de `npm test` ao mesmo tempo contra o mesmo banco de
teste: `fileParallelism: false` só protege dentro de um processo do vitest, e
duas execuções simultâneas geram falhas espúrias (ver `docs/TESTING.md`).
