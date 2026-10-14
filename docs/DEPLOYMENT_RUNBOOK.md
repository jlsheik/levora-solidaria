# Runbook de deploy — Levora Solidária

> Fase 58. Procedimento para instalar a Levora Solidária em um servidor
> Linux limpo a partir do zero, usando só este repositório, as
> configurações de referência em `deploy/` e os serviços externos listados
> em "Pré-requisitos". Escrito para ser seguido sem depender de nenhuma
> conversa anterior.
>
> Arquitetura (decidida na Fase 56, ver `docs/PRODUCTION_READINESS.md`):
> nginx same-origin serve o front-end (`dist/`) e faz proxy reverso de
> `/_api/*` para um único processo Express (`127.0.0.1:3001`, nunca exposto
> direto à internet), sob systemd. Postgres gerenciado externamente
> (`sslmode=require`). Rate limiting em memória, processo único — não usar
> PM2 cluster nem múltiplas instâncias do Express sem primeiro migrar o
> rate limiter para um backend compartilhado.
>
> Tudo neste runbook foi validado de verdade nesta fase contra um
> container Linux real (Docker, Debian + Node 22) e nginx real — não é
> suposição. Onde algo não pôde ser validado (certificado TLS real, DNS
> real, domínio real), isso está dito explicitamente na seção
> correspondente.

## 1. Pré-requisitos

- Servidor Linux limpo (testado nesta fase em `node:22-bookworm-slim` /
  `debian:bookworm-slim`; qualquer distro com systemd ≥ 245 e Node 22.x
  serve).
- Node.js 22.x instalado no servidor (`engines.node` em `package.json`
  exige isso; não testado em outras versões major).
- PostgreSQL acessível pela rede, versão compatível com o `pg_dump`/driver
  usados (`postgres` npm package) — recomendado Postgres 16, a mesma
  versão usada em todo o desenvolvimento e na Fase 57 (backup/restore).
  `sslmode=require` obrigatório em produção (ver seção 5).
- nginx ≥ 1.18 (testado nesta fase com `nginx:1.27-alpine`).
- Certificado TLS válido para o domínio público, provisionado
  externamente (nenhum provedor ACME específico assumido — ver seção 11).
- Acesso para criar um usuário de sistema sem privilégios (`levora`) e um
  diretório de deploy (`/opt/levora-solidaria` neste runbook — ajustar se
  outro caminho for usado, e então ajustar `deploy/levora-api.service` e
  `deploy/nginx.conf` de acordo).
- Segredos reais (`JWT_SECRET`, credenciais do Postgres, e opcionalmente
  `ANTHROPIC_API_KEY`/SMTP) fornecidos por fora deste repositório — nunca
  gerados ou armazenados aqui.

## 2. Provisionamento

```bash
# Usuário de sistema sem shell de login, dedicado ao processo da API.
sudo groupadd --system levora
sudo useradd --system --gid levora --home-dir /opt/levora-solidaria \
  --shell /usr/sbin/nologin levora

sudo mkdir -p /opt/levora-solidaria
sudo mkdir -p /opt/levora-solidaria/storage/uploads
sudo mkdir -p /etc/levora-solidaria
sudo chown -R levora:levora /opt/levora-solidaria
sudo chmod 700 /etc/levora-solidaria
```

O diretório de uploads (`storage/uploads`, configurável via
`STORAGE_LOCAL_DIR`) fica **fora** de `dist/` (nunca servido estaticamente
por engano pelo nginx) e **fora** de `/tmp` (não pode ser limpo entre
reinícios do servidor) — precisa de um volume persistente real se o
servidor for uma VM efêmera/container. Não há migração para S3 nesta
fase (o adaptador já existe, ver `.env.example`, mas ativá-lo é decisão de
infraestrutura futura).

## 3. Instalação (build e artefatos)

Build feito **fora** do servidor de produção (CI ou máquina de build) e
os artefatos copiados para o servidor — nunca rodar `npm run build` como
parte do deploy em produção sem necessidade.

Artefatos que **precisam** ir para o servidor:

- `dist/` — front-end estático (gerado por `vite build`, dentro de
  `npm run build`).
- `dist-server/` — backend compilado (gerado por `npm run build:server`;
  inclui agora, desde esta fase, a cópia de
  `src/static/__dev/scheduled-jobs.json` — ver "Achado 2" abaixo).
- `package.json` + `package-lock.json` — para `npm ci --omit=dev` no
  servidor.
- `db/` — `schema.sql` e `migrations/*.sql`, lidos em runtime pelos
  scripts de migração (que correm via `tsx`, direto do código-fonte, não
  do build compilado — ver seção 6).

**Nunca** copiar `.env` para o servidor (segredos sempre via
`EnvironmentFile`, ver seção 4) nem `node_modules` da máquina de build
(reinstalar no servidor com `npm ci`).

```bash
# Na máquina de build / CI:
npm ci
npm run build          # gera dist/ (tsc -p tsconfig.json && vite build)
npm run build:server   # gera dist-server/ + copia scheduled-jobs.json

# Transferir para o servidor (rsync/scp) — exemplo:
rsync -az dist dist-server package.json package-lock.json db \
  usuario@servidor:/opt/levora-solidaria/

# No servidor, como usuário levora, dentro de /opt/levora-solidaria:
npm ci --omit=dev
```

### Achado 1 — `npm run build:server` estava quebrado (corrigido nesta fase)

Antes desta fase, `npm run build:server` **nunca tinha sido executado
com sucesso** (a CI só rodava `npm run build`, que é só o front-end + o
typecheck do projeto inteiro — nunca o `tsc -p tsconfig.server.json`
real). **Atualização (Fase 66): a CI agora roda `npm run build:server`
como gate obrigatório a cada push/PR** — ver `.github/workflows/ci.yml`
e `docs/TESTING.md` — exatamente para que uma regressão como esta nunca
mais passe silenciosamente. Ao executar de verdade pela primeira vez
nesta fase (58), apareceram 535 erros em 109 arquivos:

- `tsconfig.server.json` usa `module`/`moduleResolution: NodeNext`
  (correto para um pacote `"type": "module"` rodando em Node puro, sem
  bundler), que exige extensão `.js` explícita em todo import relativo —
  nenhum arquivo do projeto tinha isso (o `tsconfig.json` principal usa
  `moduleResolution: Bundler`, que nunca exigiu isso). Corrigido
  adicionando `.js` aos imports relativos nos 103 arquivos de
  `server/`, `db/`, `src/endpoints/` e `src/helpers/` realmente usados
  pelo backend.
- `tsconfig.server.json` incluía `src/helpers` por completo, varrendo
  hooks de front-end que usam APIs de DOM/browser inexistentes em Node
  (`useScrollReveal.tsx`, `useIsMobile.tsx`, `useMediaQuery.tsx`,
  `useAuth.tsx`, `themeMode.tsx`) e dois arquivos não utilizados em
  nenhum lugar do projeto (`connectorsManual.tsx`, `connectorsTypes.tsx`,
  confirmados sem nenhum import real). Nenhum desses é importado por
  `server/` ou `src/endpoints/` — excluídos explicitamente em
  `tsconfig.server.json` (`exclude`).

Depois da correção, `npm run build:server` compila limpo e
`npx tsc --noEmit` (projeto inteiro) e os 370 testes continuam passando
sem alteração.

### Achado 2 — `scheduled-jobs.json` nunca chegava ao build compilado

`src/helpers/scheduler.tsx` lê `src/static/__dev/scheduled-jobs.json` via
`fs.readFileSync`, relativo ao próprio `__dirname`. Em produção (rodando
`dist-server/server/index.js`), isso resolve para
`dist-server/src/static/__dev/scheduled-jobs.json` — mas `tsc` nunca
copia arquivos não-TypeScript, então esse caminho nunca existia no build
real. Confirmado rodando o servidor compilado de verdade: o processo
subia, mas o agendador falhava silenciosamente ao ler a config (teria
ficado sem nenhuma tarefa agendada em produção — expiração de reservas,
de oportunidades, varredura de matching e verificação do hash chain nunca
rodariam). Corrigido com um passo extra no build
(`scripts/copy-server-assets.cjs`, chamado por `npm run build:server`)
que copia esse JSON para o mesmo caminho relativo dentro de
`dist-server/`. Validado: depois da correção, o agendador registra as 5
tarefas normalmente ao iniciar o build compilado.

### Achado 3 — descoberta de endpoints só reconhecia `.ts`, nunca `.js`

`server/index.ts` descobre os endpoints em `src/endpoints/` varrendo o
diretório e casando o nome do arquivo contra
`/^(.*)_(GET|POST)\.ts$/`. Rodando o servidor **compilado** de verdade
pela primeira vez nesta fase, o log mostrou `Descobertos 0 endpoints em
src/endpoints/` — os arquivos reais em `dist-server/src/endpoints/` são
`.js`, não `.ts`, então o regex nunca casava com nada. **Isto
significa que, antes desta correção, um deploy real em produção teria
subido um processo saudável (health check OK) mas completamente sem
nenhuma rota de API funcionando** — um dos piores tipos de falha
silenciosa possível. Corrigido trocando o regex para
`/^(.*)_(GET|POST)\.(ts|js)$/`. Validado: depois da correção, o servidor
compilado descobre os 54 endpoints reais e uma chamada de verdade (ex.:
`GET /_api/v1/auth/session`) responde corretamente, com os headers de
segurança intactos, contra o Postgres real.

## 4. Secrets

Nunca em `.env` versionado, nunca inline no unit systemd. Fluxo:

```bash
sudo touch /etc/levora-solidaria/levora.env
sudo chmod 600 /etc/levora-solidaria/levora.env
sudo chown levora:levora /etc/levora-solidaria/levora.env
# editar com os valores reais (ver .env.example para a lista completa e
# o que é obrigatório/opcional):
#   DATABASE_URL, JWT_SECRET, PORT=3001, TRUST_PROXY=1,
#   APP_PUBLIC_URL=https://<domínio real>, e opcionalmente
#   ANTHROPIC_API_KEY/LEVORA_AI_MODEL, SMTP_*, S3_* (se não usar disco
#   local), APPROVAL_REQUEST_EXPIRATION_DAYS.
```

`.env.example` já documenta, para cada variável, se é obrigatória,
opcional, e o que acontece se for omitida (degradação graciosa, nunca
"fake feature") — revisado nesta fase e confirmado completo contra um
grep de todo `process.env.*` usado no backend; nenhuma variável real
usada no código estava faltando no exemplo.

Nenhuma variável de ambiente é necessária em **build time** — confirmado
na Fase 54 (`env -i npm run build` funciona) e reconfirmado nesta fase:
todas as variáveis acima são lidas em runtime pelo processo Express, não
durante `vite build`/`tsc`.

`TRUST_PROXY=1` é obrigatório nesta topologia (nginx como único hop
confiável) — ver seção 8 e a validação real na seção 13.

## 5. PostgreSQL

- `sslmode=require` (ou mais estrito) na `DATABASE_URL` de produção —
  nunca desabilitar validação de TLS por conveniência.
- Rede privada entre o servidor da API e o Postgres sempre que o provedor
  gerenciado suportar (VPC/peering) — a porta do Postgres nunca deve
  ficar exposta à internet pública.
- O pool de conexões (`src/helpers/db.tsx`) já é pequeno por padrão
  (`max: 3`) — adequado a um único processo; não precisa de ajuste para
  esta arquitetura de instância única.

## 6. Migrations — mecanismo oficial, nunca manual

**Nunca aplicar migrations via `psql -f` manual.** A Fase 57 descobriu
que a migration `0013_users_email_case_insensitive.sql` tinha sido
aplicada assim no banco de dev (Fase 48) e nunca ficou registrada em
`schema_migrations`, apesar do efeito estar presente no schema — uma
divergência silenciosa entre "o que o banco realmente tem" e "o que o
mecanismo oficial acha que já aplicou", só corrigida manualmente meses
depois. Por isso o procedimento abaixo é o único sancionado.

### 6.1. Banco novo, vazio (primeira instalação)

```bash
DATABASE_URL="postgres://..." npm run db:migrate
```

Aplica `db/schema.sql` por completo **e** popula `schema_migrations` com
os nomes de todos os arquivos em `db/migrations/`, marcando-os como já
incorporados ao schema base. **Importante, validado de verdade nesta
fase**: `npm run db:migrate:incremental` sozinho, contra um banco
vazio, **falha** (a primeira migration incremental pressupõe tipos/
tabelas que só existem depois do `schema.sql` base) — a ordem não é
intercambiável. `db:migrate` é sempre o primeiro passo em um banco novo.

### 6.2. Banco já existente, aplicando uma migration nova

```bash
DATABASE_URL="postgres://..." npm run db:migrate:incremental
```

Idempotente: cada arquivo de `db/migrations/` só é aplicado se seu nome
ainda não estiver em `schema_migrations`. Correndo de novo sem nenhuma
migration nova não faz nada (`Nenhuma migração pendente.`).

### 6.3. Validação real desta fase (dois cenários independentes)

Executados nesta fase contra um container Linux real (Docker) e um banco
Postgres novo a cada cenário:

- **Do zero via `db:migrate`**: banco vazio → `npm run db:migrate` → 26
  tabelas (igual ao banco de desenvolvimento real) e as 13 migrations
  marcadas em `schema_migrations`. Rodar `db:migrate:incremental` depois
  disso é um no-op correto (todas puladas).
- **Restore de backup (procedimento completo e já medido na Fase 57,
  `docs/DATABASE_RECOVERY.md`)**: restaura um dump real para um banco
  separado, nunca sobrescrevendo o original — não repetido nesta fase,
  só referenciado, já que o procedimento e as métricas de tempo já
  existem documentados.

Sempre fazer **backup antes de aplicar qualquer migration em produção**
(`pg_dump`, ver `docs/DATABASE_RECOVERY.md`) — não existe rollback
automático de migration nesta arquitetura; a única forma de desfazer é
restaurar o backup anterior.

## 7. Build

Ver seção 3. Resumo: `npm run build` (front-end) e
`npm run build:server` (backend) rodam fora do servidor de produção,
numa máquina de build/CI; só os artefatos resultantes (`dist/`,
`dist-server/`) + `package.json`/`package-lock.json`/`db/` vão para o
servidor.

## 8. Nginx

Config de referência completa em [`deploy/nginx.conf`](../deploy/nginx.conf) —
validada nesta fase com `nginx -t` real (sintaticamente correta) e, numa
versão simplificada, contra um Express real rodando em container Linux
(ver seção 13). Pontos centrais:

- Serve `dist/` como SPA (`try_files $uri /index.html`), com
  `Cache-Control: no-cache` em `index.html` e cache agressivo/imutável em
  `/assets/*` (nomes com hash do Vite).
- Proxy reverso de `/_api/*` para `127.0.0.1:3001` (porta do Express,
  nunca exposta direto à internet), repassando
  `X-Forwarded-For`/`X-Real-IP`/`X-Forwarded-Proto` de forma que o
  Express (com `TRUST_PROXY=1`) veja o IP real do cliente e não um valor
  forjável por quem está do outro lado do nginx — ver seção 13.
- Cabeçalhos de segurança do **documento HTML** (CSP com
  `frame-ancestors`, `X-Frame-Options`, etc.) são responsabilidade do
  nginx, copiados de `DOCUMENT_CSP_WITH_FRAME_ANCESTORS` em
  `src/helpers/securityHeaders.ts` — fonte única da verdade documentada
  no próprio `deploy/nginx.conf`; se esse arquivo TypeScript mudar, o
  nginx.conf precisa ser atualizado manualmente (adicionado ao checklist
  de deploy abaixo). Os headers da **API** (`/_api/*`) já vêm do próprio
  Express em toda resposta — nginx não duplica nem sobrescreve nada ali.

### Achado real da Fase 59 — headers do documento vazavam para `/_api/*`

A primeira versão de `deploy/nginx.conf` (Fase 58) declarava os headers
do documento (`add_header Content-Security-Policy ...`, `X-Frame-Options`
etc.) no nível do `server {}`, **antes** de qualquer `location`. O nginx
herda `add_header` do nível do server para toda location que não declare
o seu próprio — incluindo `location /_api/`, que não tinha nenhum. Na
prática, isso fazia o proxy devolver respostas de API com **dois**
headers `Content-Security-Policy` (o do Express, `default-src 'none'`, e
o do documento por cima) — exatamente o que a separação de
responsabilidade acima diz que nunca deveria acontecer. Reproduzido de
verdade (container Linux + nginx real) e corrigido nesta fase: os
headers do documento agora só existem dentro de `location = /index.html`
e `location /` (as duas únicas locations que servem HTML) — nunca mais
no nível do server. Reconfirmado sem duplicação depois da correção.

Achado relacionado: `deploy/nginx.conf` só contém blocos `server {}` —
pressupõe que o `nginx.conf` principal da distro já inclua
`mime.types` (padrão em qualquer instalação via pacote). Usá-lo como um
`nginx.conf` autônomo sem esse include faz o navegador recusar o
JavaScript da aplicação (`Content-Type: text/plain` em vez de
`application/javascript`) — página carrega em branco, sem nenhum erro no
lado do servidor. Reproduzido de verdade montando um Central Visual
através do nginx real (algo que a Fase 58 não tinha feito — só validara
o nginx via `curl`, que não detecta esse tipo de problema). Nota
explícita adicionada no próprio `deploy/nginx.conf`.

## 9. Express (systemd)

Config de referência completa em
[`deploy/levora-api.service`](../deploy/levora-api.service).

```bash
sudo cp deploy/levora-api.service /etc/systemd/system/levora-api.service
sudo chmod 644 /etc/systemd/system/levora-api.service
sudo systemctl daemon-reload
sudo systemctl enable --now levora-api
sudo systemctl status levora-api
```

Pontos centrais:

- Usuário/grupo dedicados sem privilégio (`levora`), `ProtectSystem=strict`,
  `NoNewPrivileges=true`, só `storage/` com permissão de escrita.
- `EnvironmentFile` (seção 4), nunca segredo inline no unit.
- `Restart=on-failure` + `RestartSec=5` — reinicia em crash real, sem
  loop instantâneo.
- `TimeoutStopSec=15`, maior que o timeout interno de 10s que
  `server/index.ts` já usa para se encerrar graciosamente
  (`GRACEFUL_SHUTDOWN_TIMEOUT_MS`, Fase 56) — dá margem antes do systemd
  mandar SIGKILL. Processo manda `server.close()` (para de aceitar
  conexão nova, espera as em andamento) e depois `closeDbPool()` antes de
  sair.

### Validação real desta fase — SIGTERM no Linux

A Fase 56 só conseguiu validar o desligamento gracioso **no mesmo
processo** (`process.emit("SIGTERM")`), porque o host de desenvolvimento
é Windows e o libuv não entrega SIGTERM de verdade entre processos ali
(só `TerminateProcess`, que nunca invoca o listener registrado). Esta é a
primeira vez, nesta sessão, que isso foi testado com SIGTERM **real,
entre processos, em Linux**: `docker stop` (que manda SIGTERM por
padrão, com até 10s de espera antes do SIGKILL) contra o servidor
compilado rodando em container Linux real produziu exatamente os logs
esperados:

```
SIGTERM recebido — encerrando graciosamente (até 10000ms para requisições em andamento)...
Encerrado graciosamente.
```

Em ~0,4s, bem dentro do timeout de 10s — nenhum SIGKILL necessário. Isto
confirma, com evidência real (não suposição), que o código da Fase 56
funciona como desenhado no ambiente de produção real (Linux/systemd),
mesmo tendo sido impossível confirmar isso daquela vez no Windows.

### Achado real da Fase 59 — nunca usar `npm start` como `ExecStart`

Ao requalificar o pacote num segundo ambiente Linux independente, uma
tentativa inicial de container de teste usava `CMD ["npm", "start"]`
(em vez de chamar `node` diretamente) — e o SIGTERM nunca chegou ao
código de shutdown gracioso: o log mostrou `npm error signal SIGTERM` /
`npm error command failed`, sem nenhuma linha de "encerrando
graciosamente" e saindo com código 1. O `npm` (quando é o processo PID 1
de um container, e provavelmente também sob systemd) não repassa SIGTERM
de forma confiável ao processo Node filho — ele mesmo captura o sinal e
mata a árvore de processos abruptamente. **`deploy/levora-api.service`
já estava correto desde a Fase 58** (`ExecStart=/usr/bin/node
dist-server/server/index.js`, nunca `npm start`) — mas essa é a primeira
vez que a razão concreta para essa escolha foi comprovada com evidência
real, e não apenas por convenção. Refeito o teste chamando `node`
diretamente (igual ao `ExecStart` real): SIGTERM funcionou
perfeitamente, ~0,3s, saída limpa (código 0). **Nunca trocar o
`ExecStart` do unit systemd para `npm start`, mesmo que pareça mais
simples** — quebraria silenciosamente o desligamento gracioso.

## 10. Startup order

```
Postgres acessível
    → migrations aplicadas (seção 6, SEMPRE antes de liberar tráfego)
        → systemctl start levora-api (Express sobe, descobre os 54
          endpoints, registra o agendador)
            → nginx start/reload (só depois do Express já estar de pé —
              senão o proxy reverso devolveria 502 para quem chegasse
              primeiro)
                → GET /_api/__health responde 200
                    → liberar tráfego real (DNS/load balancer apontando
                      para este servidor)
```

## 11. TLS

Nenhum provedor ACME específico assumido nesta fase — nenhum certificado
real foi provisionado. Nginx (seção 8/`deploy/nginx.conf`) espera os
arquivos em `/etc/letsencrypt/live/<domínio>/{fullchain,privkey}.pem`
(caminho padrão do Certbot, usado só como referência — qualquer CA
funciona desde que os arquivos fiquem nesse formato PEM). Pontos que
quem for provisionar precisa decidir/confirmar:

- Permissão da chave privada: leitura só para `root`/nginx, nunca
  world-readable.
- Renovação: depende do provedor escolhido (Certbot tem renovação
  automática via timer systemd próprio — não configurado aqui, decisão
  de infraestrutura).
- Redirecionamento HTTP→HTTPS: já no `deploy/nginx.conf` (bloco da porta
  80, `return 301 https://...`).
- HSTS: já no `deploy/nginx.conf`, só no bloco 443 — nunca habilitar
  antes de confirmar que HTTPS nunca falha para os usuários reais
  (reverter é lento, por causa do `max-age`).
- `X-Forwarded-Proto`: já repassado pelo nginx ao Express (seção 8) —
  usado caso o Express precise saber que a conexão original era HTTPS.

## 12. Health check

`GET /_api/__health` já existe (`server/index.ts`) e responde
`{"status":"ok","endpoints":<n>,"apiVersion":"v1"}` — é só liveness
(processo de pé e respondendo), não um readiness que verifica
dependências (Postgres etc.) separadamente. A arquitetura simples
nginx+systemd+instância única decidida na Fase 56 não exige um endpoint
de readiness separado — não foi criado nenhum nesta fase.

## 13. Validação real da topologia (nginx + TRUST_PROXY=1) — Fase 58

A Fase 52 só tinha validado `TRUST_PROXY`/resistência a spoofing contra o
Express puro, sem nenhum proxy real na frente (cabeçalhos forjados
manualmente no teste). Nesta fase, montado um ambiente com container
Linux real rodando o backend compilado + um container nginx real com uma
versão simplificada de `deploy/nginx.conf` na frente, `TRUST_PROXY=1`:

- 25 requisições ao endpoint de login, cada uma com um `X-Forwarded-For`
  **forjado e diferente** a cada vez, todas através do nginx real: as 20
  primeiras retornaram 400 (credencial inválida, como esperado) e as 5
  seguintes 429 (rate limit) — ou seja, todas as 25 cderam no **mesmo**
  bucket de rate limit, porque o nginx substitui o `X-Forwarded-For` do
  cliente pelo seu próprio (`$proxy_add_x_forwarded_for`, baseado no IP
  TCP real de quem conectou nele), nunca repassando o valor forjado
  cru. Confirma, com nginx real (não só o Express isolado), que a
  topologia resiste a spoofing exatamente como desenhada na Fase 56.
- Um `GET /_api/v1/auth/session` sem sessão, através do nginx, voltou
  `401` com o corpo e os headers de segurança esperados — confirma que o
  proxy reverso repassa corretamente requisição e resposta de ponta a
  ponta.

## 14. Backup

Procedimento completo, testado e medido na Fase 57
(`docs/DATABASE_RECOVERY.md`): `pg_dump` diário, retenção de 30 dias,
armazenamento independente do servidor de produção, checksum (SHA-256) do
arquivo de backup, teste de restore periódico. **Sempre rodar backup
antes de aplicar uma migration em produção** (seção 6) — nenhuma
automação de produção nova foi criada nesta fase, só a integração deste
passo no runbook de deploy.

## 15. Rollback

Não existe rollback automático de migration nesta arquitetura (decisão
já tomada antes desta fase). Em caso de problema após um deploy:

1. **Código**: reverter para o artefato de build anterior (`dist/` +
   `dist-server/` da versão anterior) e `systemctl restart levora-api`
   — rápido, porque o `systemctl stop` aciona o SIGTERM gracioso (seção
   9) antes de trocar os arquivos.
2. **Schema**: se uma migration já foi aplicada e causou problema, a
   única forma segura de desfazer é restaurar o backup pré-migration
   (seção 14/`docs/DATABASE_RECOVERY.md`) — nunca uma migration "reversa"
   improvisada manualmente.
3. Nunca pular a confirmação de health check (seção 12) depois de um
   rollback, antes de liberar tráfego de novo.

## 16. Troubleshooting

| Sintoma | Causa provável | Onde checar |
|---|---|---|
| `npm run db:migrate:incremental` falha com "type ... does not exist" num banco novo | Rodado antes de `npm run db:migrate` — ver seção 6.1 | Rodar `db:migrate` primeiro |
| Servidor sobe, health check OK, mas toda rota de API devolve 404 | Build antigo sem o fix do Achado 3 (descoberta de endpoints só reconhecia `.ts`) — confirmar `npm run build:server` atual | `journalctl -u levora-api`, procurar a linha "Descobertos N endpoints" — deve ser 54, nunca 0 |
| Agendador não registra nenhuma tarefa, log de erro lendo `scheduled-jobs.json` | Build antigo sem o fix do Achado 2 (asset não copiado) | Confirmar `dist-server/src/static/__dev/scheduled-jobs.json` existe |
| `EADDRINUSE` ao iniciar | Outro processo (ou instância antiga) ainda na porta configurada | `systemctl status levora-api`, `ss -ltnp \| grep 3001` |
| Rate limit disparando para todo cliente ao mesmo tempo | `TRUST_PROXY` não configurado ou nginx não repassando `X-Forwarded-For` corretamente | Seção 13; `.env` do processo (`EnvironmentFile`) |
| 502 do nginx ao acessar `/_api/*` | Express não está de pé ainda, ou caiu | `systemctl status levora-api`, ordem de startup (seção 10) |
| `npm ci --omit=dev` falha ao rodar uma migration depois | Checar se `tsx` está em `dependencies` (não só `devDependencies`) no `package.json` usado — bug real já corrigido nesta fase, mas relevante se o `package.json` de alguma branch antiga for usado por engano | `package.json`, campo `dependencies.tsx` |

## 17. Restore

Procedimento completo, já executado e medido de ponta a ponta na Fase 57
(`docs/DATABASE_RECOVERY.md`, seções de restore/RTO): restaura sempre
para um banco **separado** do original, nunca sobrescrevendo-o
diretamente; valida estrutura, dados e a cadeia de hash do audit log
antes de considerar o restore confiável. Este runbook não repete esse
procedimento — referencia-o como a fonte única.

## Checklist de deploy (resumo operacional)

- [ ] Backup do banco atual feito e com checksum confirmado (seção 14)
- [ ] `deploy/nginx.conf` revisado contra `src/helpers/securityHeaders.ts`
      (CSP pode ter mudado desde a última vez)
- [ ] `npm run build` e `npm run build:server` rodados na máquina de
      build, sem erro
- [ ] Artefatos (`dist/`, `dist-server/`, `package.json`,
      `package-lock.json`, `db/`) copiados para o servidor — nunca `.env`
- [ ] `npm ci --omit=dev` no servidor
- [ ] Migrations pendentes aplicadas via mecanismo oficial (seção 6) —
      nunca `psql -f` manual
- [ ] `systemctl restart levora-api` (ou `enable --now` na primeira vez)
- [ ] `GET /_api/__health` confirma 200 antes de liberar tráfego
- [ ] Central Visual rápido (login + uma página autenticada) **através
      do nginx real**, nunca só `curl` — o achado da Fase 59 (JS servido
      como `text/plain` por falta de `mime.types`) só aparece carregando
      a página de verdade num navegador
- [ ] `ExecStart` do unit systemd chama `node` diretamente, nunca
      `npm start` (achado da Fase 59 — `npm start` não repassa SIGTERM de
      forma confiável, quebrando o desligamento gracioso)
- [ ] Nenhum header do documento (CSP/X-Frame-Options/etc.) duplicado nas
      respostas de `/_api/*` — conferir com `curl -i` que cada header
      aparece uma única vez
