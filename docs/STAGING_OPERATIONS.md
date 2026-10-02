# Operação do staging gratuito — Levora Solidária

> **AMBIENTE DE DEMONSTRAÇÃO / TESTE.** Não é produção. Não guarde dados
> reais de clientes, documentos reais, secrets reais ou informações
> pessoais reais aqui — nada neste ambiente tem backup geograficamente
> independente nem disponibilidade garantida (ver seção "Limitações").
>
> Este documento é autossuficiente: siga-o sem depender de nenhuma
> conversa anterior. Para a arquitetura e a validação original, ver
> [`docs/STAGING_ZERO_COST.md`](./STAGING_ZERO_COST.md) (Fase 61). Para a
> decisão de infraestrutura paga futura, ver
> [`docs/INFRASTRUCTURE_DECISION.md`](./INFRASTRUCTURE_DECISION.md).

## 1. Arquitetura

```
Internet → Cloudflare Quick Tunnel (gratuito, sem conta) → cloudflared (host)
  → nginx (Docker, só em 127.0.0.1:8088) → Express compilado (sem porta publicada)
  → PostgreSQL 16 (sem porta publicada, volume persistente)
```

Nenhum serviço pago. `app` e `postgres` não têm nenhuma porta publicada no
host — o único caminho de entrada de fora é o túnel.

## 2. Pré-requisitos

- Docker Desktop instalado e funcionando.
- `cloudflared` no PATH (instalação gratuita, sem conta:
  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
- PowerShell (os scripts são `.ps1` — ambiente de desenvolvimento atual é
  Windows; se o host mudar para Linux/macOS, os mesmos comandos `docker
  compose`/`cloudflared` usados dentro dos scripts funcionam direto no
  terminal, só a automação em PowerShell precisaria de uma versão
  `.sh` equivalente).
- `npm run build` (frontend) já rodado pelo menos uma vez, com `dist/`
  presente — os scripts de staging **não** rodam o build do frontend
  sozinhos (só `build:server`, dentro do Dockerfile).

## 3. Subir o staging

```powershell
.\scripts\staging-up.ps1
```

Faz, em ordem: verifica/inicia o Docker → carrega ou gera
`STAGING_JWT_SECRET` (uma vez só, fica em `.staging-runtime\secrets.env`,
nunca no Git) → builda e sobe os containers → aplica migrations pelo
mecanismo oficial (detecta sozinho se o banco é novo ou um volume
reaproveitado — nunca `psql -f` manual) → espera a aplicação responder →
sobe o Cloudflare Quick Tunnel → imprime a URL pública.

Para subir só localmente, sem expor à internet: `.\scripts\staging-up.ps1 -NoTunnel`.

## 4. Descobrir a URL

A URL pública é temporária e muda a cada subida do túnel. Ela aparece ao
final de `staging-up.ps1`, e pode ser consultada depois com:

```powershell
.\scripts\staging-status.ps1
```

Local (sempre o mesmo endereço, só acessível deste computador):
`http://127.0.0.1:8088`.

## 5. Status

```powershell
.\scripts\staging-status.ps1
```

Mostra: containers e seu estado, health (`/_api/__health`), últimas
linhas do log do scheduler, se o túnel está rodando e qual é a URL atual,
os volumes de dados e os últimos backups locais. Não sobe nem derruba
nada — só lê o estado atual.

## 6. Health check

Manual, se quiser conferir fora do `staging-status.ps1`:

```powershell
Invoke-WebRequest http://127.0.0.1:8088/_api/__health
```

Esperado: `{"status":"ok","endpoints":54,"apiVersion":"v1"}`. Containers
`running` não significa staging pronto — só o health respondendo 200 com
54 endpoints confirma isso de verdade.

## 7. Backup

```powershell
.\scripts\staging-backup.ps1
```

`pg_dump` (formato custom, comprimido) → `backups\levora_staging_<timestamp>.dump`
no host (fora de qualquer volume do Postgres) → checksum SHA-256 em
`backups\levora_staging_<timestamp>.dump.sha256`. Nunca sobrescreve um
backup anterior (nome com timestamp).

**Limitação que não deve ser escondida**: este backup fica só neste
computador. Se o disco falhar, backup e banco podem falhar juntos. Copie
periodicamente a pasta `backups\` para outro dispositivo ou uma nuvem
pessoal gratuita (não automatizado por esta fase, para não adicionar
nenhum serviço pago).

## 8. Restore

```powershell
.\scripts\staging-restore.ps1 -BackupFile backups\levora_staging_2026-10-01_205758.dump
```

Sempre cria um banco **separado** (`levora_staging_restore_<timestamp>`)
— nunca sobrescreve o banco de staging em uso. Confere o checksum SHA-256
antes de restaurar (se o arquivo `.sha256` existir), valida o schema
(contagem de tabelas/migrations) e sobe um container temporário do app
apontado para o banco restaurado, confirmando os 54 endpoints e rodando
`verifyAuditLogChain()` (o verificador canônico). O banco de teste **não**
é removido automaticamente — o próprio script imprime o comando exato
para remover quando terminar de inspecionar.

## 9. Desligar (preserva os dados)

```powershell
.\scripts\staging-down.ps1
```

Encerra o túnel (a URL pública para de responder) e para os containers.
**Nunca apaga volumes** — `postgres_data` e `uploads_data` continuam
intactos. Para retomar depois, `.\scripts\staging-up.ps1` de novo.

## 10. Reset (apaga só o banco de staging, perigoso)

```powershell
.\scripts\staging-reset.ps1            # mostra o que seria apagado, não apaga nada
.\scripts\staging-reset.ps1 -Confirm   # pede para digitar "APAGAR STAGING" antes de agir
```

Dropa e recria o banco `levora_staging` (nome fixo no script, nunca
parametrizável — não pode acertar outro banco por engano), reaplica as
migrations do zero. **Não apaga uploads** (use `staging-destroy.ps1` para
isso). Nunca toca em nenhum banco fora deste staging.

## 11. Destroy (apaga tudo de verdade)

```powershell
.\scripts\staging-destroy.ps1                 # mostra o que seria apagado, não apaga nada
.\scripts\staging-destroy.ps1 -Confirm        # pede "DESTRUIR STAGING", depois apaga containers + volumes + backups
.\scripts\staging-destroy.ps1 -Confirm -KeepBackups  # igual, mas preserva backups/
```

O único comando desta família que apaga dados de verdade e para sempre.
Nada disto afeta nenhum banco de produção — este staging nunca teve
nenhum dado de produção.

> **Nota sobre `-Confirm`**: tanto `staging-reset.ps1` quanto
> `staging-destroy.ps1` pedem a frase de confirmação via `Read-Host`, que
> só funciona num terminal PowerShell genuinamente interativo (a janela
> onde você digita). Rodar via automação não-interativa falha com segurança
> (erro, nada é apagado) em vez de prosseguir sem confirmação — comportamento
> testado e confirmado nesta fase.

## 12. Troubleshooting

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `staging-up.ps1` trava em "Verificando Docker" | Docker Desktop não estava aberto | O script tenta abrir sozinho e espera até 90s; se não bastar, abra manualmente e rode de novo |
| `error ... STAGING_JWT_SECRET is missing a value` rodando um comando `docker compose` manual | Faltou carregar o segredo nesta sessão do terminal | Rode via um dos scripts `staging-*.ps1` (todos carregam o segredo automaticamente), não `docker compose` direto |
| Login (ou qualquer rota que toque o banco) trava indefinidamente, nunca responde | **Achado real desta fase, já corrigido**: o pool de conexões do scheduler podia esgotar o pool da aplicação inteira (`src/helpers/db.tsx`) quando tarefas agendadas se sobrepunham. Corrigido com um pool separado só para o scheduler. Se isso voltar a acontecer, é um bug novo, não o mesmo — investigar `pg_stat_activity` no Postgres de staging | `docker exec levora-solidaria-postgres-1 psql -U postgres -d levora_staging -c "SELECT pid,state,query FROM pg_stat_activity WHERE datname='levora_staging';"` |
| `staging-up.ps1` roda `db:migrate` num volume que já tem dados | Não deveria acontecer — o script checa `schema_migrations` antes de decidir | Se acontecer, é um bug: abra uma investigação, não ignore |
| URL pública para de responder sozinha | Quick Tunnel é efêmero por natureza — pode cair se a conexão de internet oscilar | `.\scripts\staging-status.ps1` para ver se o `cloudflared` ainda está rodando; se não, `.\scripts\staging-up.ps1` de novo gera uma URL nova |
| `nginx` sobe mas a página carrega em branco | `dist/` desatualizado ou ausente | Rode `npm run build` no host antes de `staging-up.ps1` — o nginx monta `dist/` direto do host, não rebuilda sozinho |

## 13. Demonstração (para investidores ou terceiros)

1. `.\scripts\staging-up.ps1`.
2. Esperar a seção "STAGING NO AR" e copiar a URL.
3. Abrir a URL, fazer login com uma conta de demonstração (nunca dados
   reais).
4. Mostrar o fluxo desejado (dashboard, organização, necessidades etc.).
5. Ao terminar, `.\scripts\staging-down.ps1`.

Não há landing page nem UI nova criada para isso — a própria aplicação já
é a demonstração.

## 14. Dados de demonstração (estado atual)

Não existem fixtures/seeds automáticos: `package.json` referencia um
script `db:seed` (`tsx db/seed.ts`), mas o arquivo `db/seed.ts` **não
existe** no repositório — inconsistência pré-existente, não introduzida
nesta fase, registrada aqui em vez de escondida. No momento em que este
documento foi escrito, o volume de staging tinha **1 usuário de teste**
(criado durante a validação da Fase 61/62, `fase61-teste@example.com`,
senha de teste) e **0 organizações** — nenhum dado real. Se for necessário
popular o staging com dados de demonstração mais ricos no futuro, isso é
trabalho novo (criar `db/seed.ts` ou cadastrar manualmente pela própria
aplicação) — não construído nesta fase por não ser necessário agora.

## 15. Segurança

- `app` e `postgres` sem nenhuma porta publicada no host; só `nginx` em
  `127.0.0.1:8088` (nunca `0.0.0.0`) — confirmar com
  `docker compose -f docker-compose.staging.yml ps`.
- `STAGING_JWT_SECRET` gerado uma vez por ambiente, guardado só em
  `.staging-runtime\secrets.env` (gitignored, nunca commitado).
- Senha do Postgres de staging (`staging_only_not_real`, hardcoded em
  `docker-compose.staging.yml`) é aceitável porque o banco nunca é
  acessível de fora da rede Docker interna — não reaproveitar esse valor
  em nenhum outro lugar.
- `.env` real do projeto (desenvolvimento) nunca é lido nem referenciado
  por nenhum script de staging.
- Cookies de sessão continuam `HttpOnly`/`Secure`/`SameSite=Lax` (sem
  alteração desde a Fase 51) — funcionam porque o Cloudflare Tunnel
  entrega HTTPS real ao navegador.

## 16. Caminho de migração futura

```
Docker local + Cloudflare Tunnel (este documento)
      ↓ (quando houver investimento)
VPS real + nginx real (deploy/nginx.conf, deploy/levora-api.service,
docs/DEPLOYMENT_RUNBOOK.md — preservados sem alteração desde a Fase 58)
      ↓
PostgreSQL gerenciado (docs/INFRASTRUCTURE_DECISION.md)
      ↓
object storage para uploads (gatilho: múltiplas instâncias)
      ↓
produção
```

O procedimento de backup/restore (`pg_dump`/`pg_restore`) é a mesma ponte
entre staging e produção, já comprovada cruzando os dois lados nas Fases
57 e 61.

## 17. Achado real desta fase — deadlock de pool de conexões (corrigido)

Durante a validação operacional, o login (e qualquer outra rota que
tocasse o banco) começou a travar indefinidamente depois de algumas
horas de staging rodando. Investigação real via
`pg_stat_activity`: 3 conexões "idle", cuja última query era
`pg_try_advisory_lock` — exatamente o mecanismo de
`src/helpers/scheduledTaskLock.tsx` (usado pelo scheduler para evitar
duas execuções simultâneas da mesma tarefa agendada).

**Causa raiz**: `reserveDedicatedConnection()` tirava a conexão
reservada do MESMO pool (`max: 3`) usado por toda query comum da
aplicação via Kysely. Como cada uma das 5 tarefas agendadas usa um
`objId` de advisory lock diferente, todas podem reservar uma conexão ao
mesmo tempo sem conflito entre si — e se isso acontecer (confirmado
reproduzindo de propósito: 5 tarefas disparadas em paralelo), o pool
inteiro de 3 conexões fica reservado, e qualquer query comum da
aplicação (incluindo o corpo das próprias tarefas agendadas, que também
usa esse pool) fica esperando uma conexão que nunca é liberada —
deadlock total e permanente, só resolvido reiniciando o processo.

**Correção** (`src/helpers/db.tsx`): pool separado e dedicado só para
`reserveDedicatedConnection()`, com `max: 5` (cobre as 5 tarefas
nomeadas mesmo no pior caso de todas reservarem ao mesmo tempo), nunca
compartilhado com o pool principal da aplicação. Reproduzido de novo
depois da correção, disparando as 5 tarefas simultaneamente de propósito:
login respondeu em 0,35s, sem nenhum deadlock.

Esse é exatamente o tipo de bug que só aparece com tempo de execução real
— nenhuma das Fases 58–61 (todas de duração curta) tinha rodado tempo
suficiente para as janelas de reserva de tarefas agendadas se sobreporem.
A Fase 62, ao operacionalizar o staging para ficar no ar por mais tempo,
expôs e corrigiu um defeito que, sem correção, teria eventualmente
travado qualquer deploy real de longa duração desta arquitetura —
staging ou produção.

## 18. Limitações (sem esconder)

- Disponibilidade depende deste computador e desta conexão de internet
  estarem ligados.
- Backup local, sem independência geográfica.
- Instância única, sem redundância nem failover.
- Sem alertas externos — um incidente só é percebido checando
  manualmente (`staging-status.ps1`).
- URL pública temporária (Quick Tunnel) — muda a cada reinício do túnel.
- Isto não é produção empresarial nem ambiente de alta disponibilidade.

## 19. Auditoria de lifecycle e capacidade dos pools Postgres (Fase 63)

Depois da correção de pool separado da Fase 62, esta fase auditou em
profundidade se a correção estava completa — não só "parou de travar",
mas o lifecycle inteiro (criação, concorrência, exaustão, shutdown,
restart, falha de banco, transações, locks).

### Matriz de pools (única fonte: `src/helpers/db.tsx`)

| Recurso | Pool | Max | Quem cria | Quem usa | Quem fecha |
|---|---|--:|---|---|---|
| API/Kysely (`db`) | `pgClient` | 3 | `src/helpers/db.tsx`, no import do módulo (singleton Node, eager) | todo endpoint via Kysely, todas as `db.transaction()` do projeto | `closeDbPool()` no SIGTERM/SIGINT |
| Scheduler (`reserveDedicatedConnection`) | `scheduledTaskLockClient` | 5 | idem, mesmo arquivo | só `src/helpers/scheduledTaskLock.tsx` (`withScheduledTaskLock`), usada pelas 5 tarefas agendadas | `closeDbPool()` no SIGTERM/SIGINT |
| Migrations (`db/migrate.ts`, `db/run-migrations.ts`) | conexão própria, `max: 1` | 1 | o próprio script CLI, só durante `npm run db:migrate`/`db:migrate:incremental` | só o script | `sql.end()` ao final do script, nunca fica aberta |

Nenhum outro ponto do projeto cria pool, chama `.reserve()` ou conecta
diretamente ao Postgres fora destes três (confirmado por busca textual
em todo `src/` e `db/`).

### Lifecycle confirmado (não presumido)

- **Startup**: os dois pools da aplicação são criados uma única vez, de
  forma eager, no momento em que `src/helpers/db.tsx` é importado pela
  primeira vez — o cache de módulos do Node garante isso mesmo que
  dezenas de arquivos diferentes importem `db.js` (import estático ou
  dinâmico, não importa: é a mesma instância de módulo).
- **Runtime**: singleton real — nenhuma forma de criar uma segunda
  instância de nenhum dos dois pools dentro do mesmo processo.
- **Shutdown**: `closeDbPool()` fecha os dois pools em paralelo
  (`Promise.all`). Confirmado de verdade enviando SIGTERM com reservas
  do scheduler ativas no momento exato do sinal — processo terminou
  graciosamente, zero conexões residuais no Postgres depois.
- **Restart**: confirmado via `docker stop`/`up` real — volta exatamente
  uma instância de cada pool, scheduler re-registra as 5 tarefas, login
  volta a funcionar, nenhuma conexão antiga sobra.

### Capacidade total real

```
pool da API (max 3) + pool do scheduler (max 5) = 8 conexões aplicacionais
+ 1 conexão de migration (script CLI, curta duração, só durante deploy)
= 9 no pior caso de sobreposição total
```
`max_connections` do Postgres de staging: 100 — folga ampla mesmo
contando conexões administrativas/ferramentas locais (`psql` manual,
testes). Nenhum valor tornado configurável por variável de ambiente:
não existe necessidade operacional concreta hoje (dev/staging usam os
mesmos valores sem atrito) — adicionar essa complexidade agora seria
prematuro.

### Testes reais de concorrência e exaustão (não mockados)

Executados contra o Postgres de staging real, containers reais:

- **Pressão controlada**: 5 tarefas agendadas reais (`TASK_HANDLERS`,
  corpo real, não mock) disparadas simultaneamente + login real pela
  URL pública ao mesmo tempo → login respondeu em 0,64s, as 5 tarefas
  completaram em 76ms totais. Repetido também contra `needs`,
  `inventory-items` e `opportunities` autenticados (403 esperado — a
  conta de teste não é membro de organização — mas respondendo em
  ~0,25s cada, nunca travando).
- **Exaustão deliberada do pool da API** (4 queries de 3s concorrentes
  contra um pool `max: 3`): as 3 primeiras terminam juntas (~3,03s), a
  4ª fica na fila e termina depois (~6,03s) — fila graciosa, nunca erro
  nem trava permanente. App voltou a responder normalmente logo depois.
- **Exaustão deliberada do pool do scheduler** (6 reservas de 3s
  concorrentes contra `max: 5`): mesmo padrão — 5 completam juntas, a 6ª
  fica na fila e termina depois. Recuperação completa confirmada.
- **Isolamento cruzado, nas duas direções**: pool do scheduler saturado
  (7 reservas de 4s) enquanto 5 logins reais respondem em ~0,3s cada
  (pool da API intocado); e pool da API saturado (5 queries de 4s)
  enquanto uma reserva do scheduler completa em 21ms (pool do scheduler
  intocado). Prova direta de que os dois pools realmente não competem
  entre si.
- **Erro dentro de uma tarefa agendada**: uma tarefa forçada a lançar
  exceção ainda libera o advisory lock corretamente — a tentativa
  seguinte da mesma tarefa teve sucesso imediato, sem precisar de
  nenhuma intervenção manual.
- **Falha real de PostgreSQL**: container do Postgres parado enquanto o
  app continuava rodando — `/_api/__health` (liveness pura, não toca o
  banco) continuou respondendo 200 normalmente; login retornou 400 em
  ~3,5s (nem travou, nem caiu o processo). Depois de reiniciar o
  Postgres, login voltou a funcionar em 0,36s sem reiniciar o app —
  reconexão automática do driver, sem nenhum pool ou timer duplicado.

### Achado real não corrigido nesta fase (fora do escopo "não tocar autenticação")

`src/endpoints/auth/login_with_password_POST.ts` tem um `catch`
abrangente no nível mais externo que devolve sempre
`{"message": "Falha na autenticação"}` com status 400 — inclusive
quando o erro real é uma falha de conexão com o banco (confirmado
durante o teste de Postgres indisponível acima), e sem nenhum
`console.error` registrando o que de fato aconteceu. Isso mascara
problemas de infraestrutura como "senha errada" tanto para quem usa
quanto para quem for investigar um incidente depois. Autenticação está
na lista de "não tocar" desta fase — registrado aqui como achado para
uma fase futura, não corrigido.

Outro achado, mesmo motivo (fora do escopo desta fase, "Matching 1.4"
está na lista de não tocar): `src/helpers/opportunityMatching.tsx`
chama a IA (Anthropic, via `aiCategoryScores`) **dentro** de
`db.transaction()` (linha ~290, dentro do callback que começa na linha
124) — uma chamada de rede externa, sem timeout configurado em
`aiClient.tsx`, feita enquanto uma conexão do pool da API fica presa
para aquela transação inteira. Não é o mesmo tipo de deadlock permanente
da Fase 62 (a conexão eventualmente libera quando a chamada de IA
retornar ou falhar), mas é uma fonte real de latência/pressão no pool
sob volume, e um risco teórico de held-connection prolongado se a API da
Anthropic ficar lenta ou travar sem timeout.

### Teste automatizado adicionado

`test/dbPoolIsolation.test.ts` (2 testes, roda contra o Postgres real de
desenvolvimento, mesmo padrão dos outros testes de integração do
projeto) — satura cada pool deliberadamente e confirma que o outro
continua respondendo rápido. Fica no CI como proteção permanente contra
a reintrodução do bug da Fase 62.

### Requisito mínimo para o PostgreSQL gerenciado futuro

Sem escolher fornecedor nem plano: a infraestrutura futura
(`docs/INFRASTRUCTURE_DECISION.md`) precisa suportar, no mínimo, **8
conexões aplicacionais simultâneas** (3 da API + 5 do scheduler) mais a
conexão transitória de migration durante deploys — **9 no pico**. Uma
margem operacional adicional (ferramentas de administração, monitoramento,
conexões de health-check de infraestrutura) deve ser somada no momento
da contratação, mas o tamanho dessa margem depende de quais ferramentas
operacionais forem efetivamente usadas então — não presumido aqui por
não haver dado concreto ainda.
