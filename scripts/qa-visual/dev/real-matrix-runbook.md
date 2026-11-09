# Runbook: homologação visual no produto REAL (M02)

Pré-requisito único: um PostgreSQL 16 **exclusivo e descartável** acessível em loopback (ver "Infraestruturas aceitáveis"). Nada abaixo altera dados reais, o checkout principal ou outros projetos; o banco de QA termina em `_qa` e é recriado/derrubado pelo próprio `run.mjs` (guarda em `lib/guard.mjs`).

## 0. Variáveis (exemplo; use a SUA instância descartável, porta livre, usuário exclusivo)
```bash
export PATH="<node 22.23.4 fixado>:$PATH"                    # igual ao CI Local V2
export QA_EDGE_PATH="<tools>/edge-wrapper/edge-wrap.exe"      # wrapper de ambiente já fixado do CI
export QA_DATABASE_URL="postgres://<usuario_exclusivo>:<senha_exclusiva>@127.0.0.1:<porta>/levora_m02_visual_qa"   # nunca .env de outro projeto
cd <raiz da worktree do QA>   # worktree dedicada (HEAD = master 3dd1282 + QA M02)
```
Conferir antes: `git rev-parse HEAD` = `3dd1282…`; `git status` mostra só os arquivos do QA M02; o banco é novo (`SELECT datname FROM pg_database` não tem bancos históricos); nenhum usuário real (a semente `scripts/qa-visual/seed.ts` é sintética).

## 1. Sanidade do app real (funcional, sem visual)
`npm run qa:visual -- --profile ci --browser both --out <DIR>/funcional-ci.json --diagnostics <DIR>/diag` → esperado: o mesmo do C24 (todas as células PASS). Qualquer MISSING/UNMEASURABLE agora vem com a causa do D6 (`causa=` no detalhe) — comparar com o histórico antes de seguir.

## 2. Duas capturas independentes (determinismo) — candidatas, nunca aprovadas
```bash
npm run qa:visual -- --visual capture --visual-only --browser both --visual-dir <DIR>/A/baselines --visual-out <DIR>/A/run
npm run qa:visual -- --visual capture --visual-only --browser both --visual-dir <DIR>/B/baselines --visual-out <DIR>/B/run
node scripts/qa-visual/visual.mjs determinism --a <DIR>/A/run --b <DIR>/B/run --out <DIR>/determinismo
```
Esperado: 112 células por execução, `deterministico: SIM`. Se alguma variar: investigar a causa (data, contador, id aleatório, animação, fonte, conteúdo assíncrono) **antes** de qualquer máscara; máscara só na matriz (`visual-matrix.mjs`), com `reason`, região exata e impacto na cobertura.

## 3. Galeria para revisão humana
`node scripts/qa-visual/visual.mjs gallery --baseline-dir <DIR>/A/baselines --out <DIR>/galeria --source produto --title "LEVORA SOLIDÁRIA — revisão das baselines"` e abrir `<DIR>/galeria/index.html`. A galeria nunca aprova nada.

## 4. Só depois da revisão humana
`node scripts/qa-visual/visual.mjs approve --id <célula> --sha256 <hash> --reviewer "<nome de quem revisou>" --yes` (uma por célula, comandos prontos em cada card da galeria). Depois: `... --visual compare --visual-only` deve dar exit 0 (homologado).

## 5. Encerramento
Parar/remover a instância descartável (e só ela), conferir que nada de outros projetos foi tocado, e preservar `<DIR>` como evidência.

## Infraestruturas aceitáveis (nenhuma é iniciada sem autorização)
1. PostgreSQL 16 **portátil** (binários oficiais) em diretório temporário, `listen_addresses=127.0.0.1`, porta livre, usuário exclusivo, sem serviço do Windows, sem Registro, sem firewall; encerrado com `pg_ctl stop` e diretório apagado. Requer baixar os binários (autorização de download) e conferir o checksum oficial.
2. Docker Desktop + `docker start levora-postgres-local` (contêiner do próprio Solidária, `127.0.0.1:5433`, sem restart automático). **Atenção:** iniciar o engine do Docker Desktop religa `levora-dev-postgres-1`, `levora-dev-redis-1` e `levora-dev-minio-1` (projeto LEVORA CRM, `restart: unless-stopped`, portas 5432/6379/9000/9001 em 0.0.0.0). Só com autorização específica do proprietário.
