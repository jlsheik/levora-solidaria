# Staging / demonstração zero-custo — Levora Solidária

> **Classificação explícita: STAGING / DEMONSTRAÇÃO GRATUITA.** Este NÃO
> é um ambiente de produção empresarial, nem de alta disponibilidade. Ele
> existe para desenvolvimento, demonstrações, testes e preparação para
> investidores — enquanto o projeto não tem capital para contratar
> `docs/INFRASTRUCTURE_DECISION.md`. Fase 61, validado de verdade em
> 01/10/2026: containers Docker reais no computador do proprietário do
> projeto, expostos à internet real via Cloudflare Tunnel (gratuito, sem
> conta necessária). Nenhum serviço pago foi criado, nenhum cartão
> usado, nenhum domínio registrado.

## A. Arquitetura zero-cost

```
Internet (real; acessada pela borda da Cloudflare — ver §P e a ressalva da Fase 70)
   │  HTTPS (TLS terminado pela borda da Cloudflare)
   ▼
Cloudflare (Quick Tunnel, trycloudflare.com)
   │  túnel outbound — nenhuma porta aberta no roteador/firewall de casa
   ▼
cloudflared (processo no host, aponta para http://localhost:8088)
   │
   ▼
nginx (container, só publicado em 127.0.0.1:8088 — nunca 0.0.0.0)
   ├── frontend estático (dist/, SPA fallback)
   └── /_api/* → proxy_pass http://app:3001 (rede Docker interna)
                    │
                    ▼
                 Express compilado (container `app`, SEM porta publicada
                 no host — só alcançável pela rede Docker)
                    │
                    ▼
                 PostgreSQL 16 (container `postgres`, SEM porta
                 publicada no host, volume `postgres_data`)
```

Artefatos reutilizados sem alteração de arquitetura: `Dockerfile` (novo,
multi-stage, reproduz exatamente `npm ci --omit=dev` + `node
dist-server/server/index.js` direto — nunca `npm start`, achado real da
Fase 59), `deploy/nginx.staging.conf` (adaptação de `deploy/nginx.conf`
só para rede Docker e ausência de TLS local — ver seção F),
`docker-compose.staging.yml`. **Nada do material de deploy em VPS real
(`deploy/nginx.conf`, `deploy/levora-api.service`,
`docs/DEPLOYMENT_RUNBOOK.md`) foi apagado ou alterado em arquitetura** —
continuam documentados para quando houver investimento (seção T).

## B. Docker

`docker-compose.staging.yml` define 3 serviços: `postgres` (imagem
`postgres:16` oficial, volume nomeado `postgres_data`), `app` (build
local via `Dockerfile`, volume nomeado `uploads_data` em
`/app/storage/uploads`) e `nginx` (imagem `nginx:1.27-alpine` oficial,
monta `deploy/nginx.staging.conf` e `dist/` read-only). Rede interna
`levora_staging_net` (bridge) — `localhost` dentro de um container
significa o próprio container, nunca outro serviço (confirmado: o nginx
fala com o Express via `app:3001`, nunca `127.0.0.1:3001`).

Build real executado: `docker compose -f docker-compose.staging.yml
build` — `Dockerfile` reproduz exatamente a cadeia `npm run build:server`
já validada nas Fases 58/59, com um estágio de build completo (`npm ci`
com devDependencies, para ter `tsc`) e um estágio de runtime separado
(`npm ci --omit=dev`, só o compilado).

## C. PostgreSQL

`postgres:16`, volume `postgres_data` (persistente — nunca só a camada
efêmera do container). Credencial `staging_only_not_real`, só para este
ambiente descartável, nunca reaproveitada em nenhum outro lugar.

## D. Build e migrations

```bash
npm ci --omit=dev     # dentro da imagem, confirmado: tsx presente (Fase 58)
npm run build          # frontend, fora do container, dist/ montado no nginx
npm run build:server   # backend, dentro do Dockerfile
```

Migrations aplicadas pelo mecanismo oficial, nunca `psql -f` manual:

```bash
docker compose -f docker-compose.staging.yml run --rm --no-deps \
  -e DATABASE_URL="postgres://postgres:staging_only_not_real@postgres:5432/levora_staging" \
  --entrypoint npx app tsx db/migrate.ts
```

Resultado real confirmado: **26 tabelas, 22 triggers, 13/13 migrations em
`schema_migrations`, incluindo `0013_users_email_case_insensitive.sql`**
— idêntico ao inventário da Fase 57/58/59.

## E. Nginx

`deploy/nginx.staging.conf` — `nginx -t` validado dentro do próprio
container antes de servir tráfego. Diferenças deliberadas em relação a
`deploy/nginx.conf` (documentadas no topo do próprio arquivo): sem bloco
443/TLS (ver seção F), `proxy_pass` para `app:3001` (nome do serviço
Docker, não `127.0.0.1`), e `include mime.types` + `worker_processes`/
`events` explícitos porque este arquivo é o `nginx.conf` inteiro do
container, não um fragmento incluído pelo nginx.conf padrão da distro
(o mesmo cuidado documentado como achado real da Fase 59). A separação
de responsabilidade dos headers do documento (CSP/X-Frame-Options só em
`location /` e `location = /index.html`, nunca no nível do server, para
não vazar para `/_api/*`) é a mesma correção da Fase 59, replicada aqui
de propósito — confirmada sem duplicação (seção Q).

## F. TLS

HTTPS externo é responsabilidade da borda da Cloudflare (Quick Tunnel) —
confirmado real: toda requisição via
`https://fred-expiration-ensure-chocolate.trycloudflare.com` chegou
criptografada até a borda da Cloudflare, que termina TLS ali e entrega o
tráfego ao túnel já em texto claro (padrão do Cloudflare Tunnel). O
nginx local serve só HTTP puro na porta 80 — nunca exposta diretamente à
internet, só alcançável pelo `cloudflared` rodando no mesmo host via
`127.0.0.1:8088`. Nenhum Let's Encrypt instalado neste ambiente (seria
redundante — a proteção HTTPS externa já é a da Cloudflare).

**Limitação real**: a URL do Quick Tunnel
(`https://fred-expiration-ensure-chocolate.trycloudflare.com`) é
temporária e deixa de responder assim que o processo `cloudflared` é
encerrado — confirmado ao final desta fase (processo parado
deliberadamente, ver seção U). Para uma URL persistente e gratuita,
seria necessário um Tunnel nomeado vinculado a uma conta Cloudflare
gratuita com um domínio — não configurado nesta fase (exigiria decisão
do dono do projeto sobre qual domínio usar, fora do escopo "zero
decisão nova de domínio").

## G. TRUST_PROXY — cadeia de confiança investigada e comprovada

A cadeia real é diferente da Fase 59 (nginx direto) e da arquitetura de
VPS (Fase 56/58, nginx como único hop):

```
Browser → Cloudflare (borda) → Quick Tunnel → cloudflared (host) → nginx (Docker) → Express
```

Investigação real, não assumida:

1. **`$remote_addr` dentro do container nginx é sempre o IP do
   `cloudflared` local** (o gateway da rede Docker,
   `172.19.0.1` nesta execução) — nunca o do visitante. Confirmado via
   log de diagnóstico temporário (`log_format` customizado,
   removido depois do teste).
2. **`CF-Connecting-IP` carrega o IP real de quem conectou e NÃO pode
   ser forjado pelo cliente** — testado de verdade:
   `curl -H "CF-Connecting-IP: 6.6.6.6" https://.../​_api/__health`
   através do túnel real voltou **403**, rejeitado pela própria borda da
   Cloudflare antes de a requisição sequer chegar ao túnel.
3. **`X-Forwarded-For` PODE ser definido pelo cliente, mas a Cloudflare
   só acrescenta o IP real ao final** (`forjado,IP-real`), nunca
   substitui — confirmado via log:
   `x_forwarded_for_in=[9.9.9.9,2804:2488:...]` quando o cliente mandou
   `X-Forwarded-For: 9.9.9.9`.

**Decisão, baseada na investigação**: `nginx.staging.conf` repassa ao
Express `X-Forwarded-For: $http_cf_connecting_ip` (nunca o
`X-Forwarded-For` de entrada, que é manipulável) e `X-Real-IP` com o
mesmo valor. `TRUST_PROXY=1` no Express permanece correto nesta
topologia porque, do ponto de vista do Express, o nginx continua sendo o
único hop que ele precisa confiar — a complexidade de Cloudflare+túnel
fica inteiramente resolvida na configuração do nginx, não no Express.

## H. Rate limiting — teste real através do túnel completo

25 requisições de login reais, cada uma com `X-Forwarded-For` forjado e
diferente, através de `cliente → Cloudflare → túnel → nginx → Express`:
as 20 primeiras devolveram `401` (credencial inválida, esperado) e as 5
seguintes `429` — todas no mesmo bucket de rate limit, confirmando que o
`X-Forwarded-For` forjado nunca influenciou `req.ip`, mesmo passando pela
cadeia completa real (não só nginx isolado, como nas Fases 58/59).

## I. Scheduler

5 tarefas carregadas e registradas a cada subida do container `app`
(`runMatchingSweep`, `expireReservations`, `expireOpportunities`,
`expireApprovalRequests`, `verifyAuditChain`) — confirmado em todo log
de inicialização desta fase (subida inicial, depois do restart de
persistência, depois do restart pós-SIGTERM). Como há só um processo
Express neste staging, a trava por advisory lock do PostgreSQL
(`withScheduledTaskLock`, já validada nas Fases 53/55/56) não precisou
ser exercitada sob concorrência real — continua sendo a mesma proteção
já comprovada em fases anteriores, não uma novidade desta fase.

## J. Uploads — decisão explícita

**Opção A escolhida: volume Docker local (`uploads_data`), não object
storage.** Justificativa: a arquitetura zero-custo roda num único host,
sem múltiplas instâncias — a condição que tornaria object storage
necessário (`docs/PRODUCTION_READINESS.md`, gatilho de escala) não existe
aqui. Testado de verdade: escrita de um arquivo em
`storage/uploads/` dentro do container, confirmado presente no volume
Docker nomeado (inspecionado de fora do container, via um container
auxiliar montando o mesmo volume) e **confirmado persistente depois de um
ciclo completo `docker compose down` + `up`** (sem `-v`) — ver seção M.

> **Storage de uploads no primeiro ambiente = volume Docker local no
> host.** Migração para object storage fica documentada como gatilho
> futuro (múltiplas instâncias, ou necessidade de disponibilidade
> independente deste PC) — não implementada agora.

## K. Backup real

```bash
docker exec levora-solidaria-postgres-1 pg_dump -U postgres -Fc -Z 6 levora_staging -f /tmp/....dump
docker cp levora-solidaria-postgres-1:/tmp/....dump ./backups/fase61_staging_backup.dump
sha256sum backups/fase61_staging_backup.dump
```

Backup real gerado: **126.361 bytes**, salvo em `backups/` no host (fora
de qualquer volume do PostgreSQL, como exigido), com checksum SHA-256
registrado em `backups/fase61_staging_backup.dump.sha256`:

```
c96af3a01994060e9841678d9546bc91cf1abcdbee7cb024f4569935628e1ca5
```

Inclui um usuário real de teste (`fase61-teste@example.com`, senha de
teste, nunca uma credencial real) criado via `POST
/_api/v1/auth/register_with_password` através do túnel público de
verdade, para o backup/restore ter dado real para comparar, não um banco
vazio.

## L. Restore real

```bash
docker exec levora-solidaria-postgres-1 psql -U postgres -c "CREATE DATABASE levora_staging_restore_test;"
docker cp ./backups/fase61_staging_backup.dump levora-solidaria-postgres-1:/tmp/...
docker exec levora-solidaria-postgres-1 pg_restore -U postgres -d levora_staging_restore_test /tmp/...
```

Confirmado no banco restaurado (separado do original, nunca
sobrescrevendo-o — mesma disciplina da Fase 57):

- **26/26 tabelas, 13/13 migrations** (estrutura idêntica).
- `SELECT email FROM users` devolveu `fase61-teste@example.com` (dado
  real preservado).
- `verifyAuditLogChain()` (o verificador canônico, não uma
  reimplementação) rodado contra o banco restaurado:
  `{"totalEventos": 0, "eventosVerificados": 0, "integra": true,
  "divergencias": []}` — zero eventos porque registro de usuário não
  grava em `audit_log` (confirmado; esse log cobre ações de domínio como
  organizações/necessidades/oportunidades, não autenticação crua), mas o
  mecanismo roda sem erro contra o banco restaurado.
- Um container `app` temporário, apontado para o banco restaurado,
  subiu normalmente (54 endpoints, scheduler, health 200) e um `POST
  /auth/login_with_password` com o usuário restaurado devolveu `200` com
  os dados corretos do usuário — a aplicação real funciona contra o
  banco restaurado, não só a estrutura.

Banco de teste (`levora_staging_restore_test`) removido ao final da
verificação.

## M. Persistência

```bash
docker compose -f docker-compose.staging.yml down   # SEM -v
docker compose -f docker-compose.staging.yml up -d
```

Confirmado depois do ciclo completo: `schema_migrations` com 13 linhas
(banco intacto), `storage/uploads/teste-persistencia.txt` presente
(upload intacto), aplicação respondendo `200` em `/_api/__health` com 54
endpoints — nada foi perdido por derrubar e recriar os containers,
porque os dados vivem nos volumes nomeados (`postgres_data`,
`uploads_data`), não na camada efêmera dos containers.

## N. Shutdown gracioso

`docker stop` no container `app` (equivalente a `systemctl stop` —
mesmo sinal SIGTERM, mesma política de timeout do Docker antes de
SIGKILL):

```
SIGTERM recebido — encerrando graciosamente (até 10000ms para requisições em andamento)...
Encerrado graciosamente.
```

**~303ms**, saída limpa (código 0) — confirma de novo, num ambiente
diferente dos containers de teste da Fase 59, que `node
dist-server/server/index.js` direto (nunca `npm start`, achado real da
Fase 59) continua entregando desligamento gracioso correto.

## O. Restart

`docker compose up -d app` depois do `stop`: container voltou, 54
endpoints, 5 tarefas do scheduler, banco intacto, health 200 tanto pelo
nginx local (`localhost:8088`) quanto pelo túnel público real.

## P. Acesso externo real

Testado através do Claude Browser (executa num ambiente isolado,
genuinamente fora da rede local/residencial deste computador) acessando
a URL pública do Quick Tunnel — confirma que a cadeia
`Internet real → Cloudflare → túnel → nginx → aplicação` funciona de
ponta a ponta, não é só acesso `localhost`.

**Limitação honesta**: o IP visto como `CF-Connecting-IP` nas
requisições de teste pertence à mesma faixa pública IPv6 do próprio
host (confirmado comparando com o log de inicialização do
`cloudflared`, que reporta o IP de saída ICMP da própria máquina) — ou
seja, esse teste específico prova que o mecanismo do túnel funciona (TLS
real, borda da Cloudflare real, roteamento real), mas não prova de forma
definitiva o acesso a partir de uma rede fisicamente distinta (ex.: 4G de
um celular). Essa verificação adicional — recomendada, não bloqueante —
fica para o dono do projeto fazer com um dispositivo em outra rede,
apontando para a mesma URL enquanto o túnel estiver ativo.

> **Estado em 2026-10-02 (Fase 70):** essa verificação continua **não
> realizada**. A disponibilidade pública foi validada pela própria máquina
> hospedeira através da borda Cloudflare (Fases 61, 68 e 69), mas ainda não
> houve validação independente por celular/outra rede. Qualquer frase deste
> documento ou do plano que pareça dizer o contrário deve ser lida à luz
> desta ressalva.

## Q. Central Visual

Através da URL pública real (nunca `localhost`, nunca Vite dev server):
login (usuário de teste real), dashboard, fallback de SPA numa rota de
convite inválida (hard reload, não navegação client-side), mobile
(375×812) com sessão preservada. Sem erro de CSP, fonte ou asset no
console (um erro de CSP observado inicialmente veio de uma navegação
direta anterior, do próprio diagnóstico, a um endpoint JSON cru — não
reproduzido numa aba nova e limpa, headers confirmados corretos via
`curl -i` diretamente).

## R. Segurança

- `docker compose ps` confirma: `app` e `postgres` **sem nenhuma porta
  publicada no host** (só acessíveis pela rede Docker interna); `nginx`
  publicado só em `127.0.0.1:8088` (nunca `0.0.0.0`) — o único caminho de
  entrada de fora é o túnel.
- Cookie de sessão: `HttpOnly`, `Secure`, `SameSite=Lax` (já era assim
  desde a Fase 51, sem alteração) — funcionou corretamente porque a
  conexão do navegador até a Cloudflare é HTTPS real.
- `JWT_SECRET` gerado só para este staging (`openssl rand -base64 48`),
  nunca commitado — passado via variável de ambiente obrigatória
  (`${STAGING_JWT_SECRET:?...}`, o compose recusa subir sem ela).
- Senha do Postgres de staging (`staging_only_not_real`) é um valor
  literal no `docker-compose.staging.yml`, mas documentado explicitamente
  como não-real e sem acesso de fora da rede Docker — aceitável para um
  ambiente descartável sem exposição externa ao banco.
- `.env` real do projeto nunca foi tocado, lido ou referenciado por
  nenhum destes arquivos.

## S. Custos

**US$0,00 / R$0,00.** Nenhuma conta de provedor pago criada, nenhum
cartão usado, nenhum billing habilitado. Único custo real é o já
existente (eletricidade/internet residencial do computador que já
estava ligado) — não atribuível a esta fase.

## T. Limitações (registradas sem esconder)

- **Disponibilidade**: depende deste computador estar ligado e com o
  Docker rodando — se desligar, a aplicação sai do ar.
- **Internet**: depende da conexão residencial/local — sem redundância,
  sem SLA.
- **Banco**: hospedado no mesmo host, sem replicação, sem failover.
- **Backup**: local, sem armazenamento geograficamente independente
  (diferente da arquitetura paga da Fase 60, que usava um bucket à
  parte) — se o disco deste computador falhar, backup e banco podem
  falhar juntos. Mitigação recomendada, não implementada: copiar
  periodicamente os arquivos de `backups/` para outro dispositivo/nuvem
  pessoal gratuita.
- **Escala**: instância única, sem capacidade de crescer além de um
  processo Express.
- **Alertas**: nenhum alerta externo — um incidente só é percebido se
  alguém checar manualmente.
- **Isto não é produção empresarial** nem um ambiente de alta
  disponibilidade — é staging/demonstração gratuita, declarado como tal.

## U. Migração futura (quando houver investimento)

```
Docker local (este documento)
      ↓
VPS real + nginx real (deploy/nginx.conf, já existente)
      ↓
PostgreSQL gerenciado (docs/INFRASTRUCTURE_DECISION.md)
      ↓
object storage para uploads (gatilho: múltiplas instâncias)
      ↓
DNS/TLS reais (Cloudflare DNS + Let's Encrypt, já decidido na Fase 60)
      ↓
produção
```

O procedimento de backup/restore (`pg_dump`/`pg_restore`, Fase 57) é a
ponte entre os dois ambientes: o mesmo dump gerado aqui pode ser
restaurado, sem alteração, num PostgreSQL gerenciado real — já
comprovado nesta fase. `deploy/nginx.conf` e
`deploy/levora-api.service` continuam prontos e documentados para esse
momento, sem precisar de nenhum retrabalho.

## V. Estado ao final desta fase

O processo `cloudflared` foi encerrado deliberadamente ao final da
validação (a URL `https://fred-expiration-ensure-chocolate.trycloudflare.com`
não responde mais) e os containers foram parados com `docker compose
down` (sem `-v`) — **os volumes `postgres_data` e `uploads_data`
continuam existindo no Docker local**, com todos os dados desta fase
intactos. Para subir de novo:

```bash
export STAGING_JWT_SECRET="$(openssl rand -base64 48)"   # ou reaproveitar um já gerado, fora do Git
docker compose -f docker-compose.staging.yml up -d
cloudflared tunnel --url http://localhost:8088   # gera uma URL pública nova
```

Nenhum recurso pago foi deixado esquecido — não havia nenhum para
esquecer.

---

## Atualização (Fase 62) — operacionalização e um achado crítico

A Fase 62 transformou os comandos manuais acima em scripts reprodutíveis
(`scripts\staging-up.ps1`, `staging-status.ps1`, `staging-down.ps1`,
`staging-backup.ps1`, `staging-restore.ps1`, `staging-reset.ps1`,
`staging-destroy.ps1`) — procedimento completo em
[`docs/STAGING_OPERATIONS.md`](./STAGING_OPERATIONS.md), que passa a ser
a referência operacional do dia a dia (este documento continua sendo o
registro da validação original e da arquitetura).

**Achado real crítico, corrigido nesta fase**: depois de o staging ficar
no ar por mais tempo do que nas validações anteriores (todas de duração
curta), o pool de conexões do Postgres (`src/helpers/db.tsx`) sofreu um
deadlock total e permanente — o mecanismo de lock do scheduler
(`reserveDedicatedConnection`) disputava o MESMO pool pequeno (`max: 3`)
usado por toda query comum da aplicação, e uma sobreposição real entre
tarefas agendadas esgotou as 3 conexões, travando login e qualquer outra
rota que tocasse o banco indefinidamente. Corrigido com um pool separado
e dedicado só para o scheduler (`max: 5`, nunca compartilhado) — detalhe
completo, com reprodução e verificação, em `docs/STAGING_OPERATIONS.md`,
seção 17.

## Atualização (Fase 68) — dataset sintético de demonstração

O staging deixou de depender de dados cadastrados à mão: o comando
`.\scripts\staging-seed.ps1` (após `staging-reset`) cria uma organização
fictícia completa — usuários, organizações, estoque por movimentações,
necessidades em quatro estados, oportunidades em sete estados do lifecycle
(inclusive uma concluída por recebimento real e duas avaliadas pelo
Matching 1.4) e histórico de tarefas — usando os mesmos endpoints da
aplicação. Detalhes, credenciais temporárias e a guarda de ambiente em
`docs/STAGING_DEMO.md`. Custo adicional: zero (nenhum serviço novo).
