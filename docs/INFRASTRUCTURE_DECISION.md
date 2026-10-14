# Decisão de infraestrutura de produção — Levora Solidária

> Fase 60. Esta é a decisão consolidada de **qual infraestrutura concreta
> contratar** para o primeiro ambiente de produção/staging, construída
> sobre a arquitetura já decidida nas Fases 56/58
> (`docs/PRODUCTION_READINESS.md`, `docs/DEPLOYMENT_RUNBOOK.md`) e o
> procedimento de backup/restore já validado (Fase 57,
> `docs/DATABASE_RECOVERY.md`). Nenhuma contratação real foi feita nesta
> fase — é a decisão, não a execução.
>
> Pesquisa realizada em **01/10/2026**, diretamente nos sites/documentação
> oficiais de cada provedor (não de memória de treinamento, que pode estar
> desatualizada). Preços e condições devem ser reconferidos no momento da
> contratação real.

## 1. Requisitos extraídos da documentação existente

Nenhum requisito abaixo foi inventado — todos vêm de
`docs/PRODUCTION_READINESS.md`, `docs/DATABASE_RECOVERY.md` e
`docs/DEPLOYMENT_RUNBOOK.md`, já produzidos nas Fases 55–59.

| Requisito | Obrigatório? | Fonte |
|---|---:|---|
| Linux | sim | Fase 58, todo o runbook |
| Nginx same-origin + proxy `/_api/*` | sim | Fase 56 (arquitetura-alvo) |
| Node 22.x / Express compilado | sim | `package.json` engines, Fase 58 |
| HTTPS / TLS terminado no nginx | sim | Fase 50 (CSP), Fase 56, Fase 58 |
| PostgreSQL 16+ | sim | Fase 57 (testado em 16.15) |
| `sslmode=require` na conexão | sim | `docs/DATABASE_RECOVERY.md` §11 |
| Backup diário + restore testável | sim | Fase 57 |
| Retenção de backup ≥ 30 dias | sim | `docs/DATABASE_RECOVERY.md` §8 |
| RPO ≤ 24h | sim | `docs/DATABASE_RECOVERY.md` §9 |
| RTO ≤ 4h | sim | `docs/DATABASE_RECOVERY.md` §10 |
| Volume persistente para uploads | sim | Fase 58 (`STORAGE_LOCAL_DIR`) |
| IPv4 pública (ou equivalente) | sim | único jeito de expor o nginx |
| Domínio + DNS | sim | Fase 58 (`APP_PUBLIC_URL`) |
| Secrets fora do Git, via arquivo com permissão restrita | sim | Fase 58 (`EnvironmentFile`) |
| Rede privada entre app e Postgres, quando o provedor suportar | recomendado, não obrigatório | `.env.example` (`TRUST_PROXY`), Fase 56 |
| PostgreSQL não exposto diretamente à internet | sim | Fase 56, Fase 58 §5 |
| Single-instance (sem necessidade de cluster/orquestração) | sim (decisão já tomada) | Fase 56 — rate limiter em memória |
| CI compatível (GitHub Actions → build → deploy futuro) | sim, só compatibilidade | Fase 54 |

## 2. Componentes necessários

- **Componente A — servidor Linux**: nginx + Express compilado + scheduler + filesystem de uploads.
- **Componente B — PostgreSQL gerenciado**: SSL, backup, versão 16+.
- **Componente C — DNS/domínio**.
- **Componente D — TLS/certificado**.
- **Componente E — storage independente para backup** (fora do mesmo provedor/conta do Postgres, para não perder backup e banco juntos numa falha do provedor).

Como o `.env.example` já prevê um adaptador S3 opcional
(`src/helpers/storageAdapter.tsx`) e a Fase 57 já usa `pg_dump`/`pg_restore`
(não depende de nenhum recurso proprietário de um provedor específico),
os componentes B e E **não precisam ser do mesmo fornecedor** — e, por
segurança, é preferível que não sejam.

## B. VPS candidatos (Componente A)

| Critério | Hetzner Cloud (CPX22) | DigitalOcean (Basic Droplet 4GB) | Linode/Akamai (referência) |
|---|---|---|---|
| vCPU | 2 (AMD, compartilhado) | 2 | não cotado nesta fase — ver nota |
| RAM | 4 GB | 4 GB | — |
| SSD | 80 GB NVMe | 80 GB | — |
| Tráfego incluso | 20 TB/mês (região eu-central) | 4.000 GiB (~4 TB)/mês | — |
| Região relevante | Falkenstein/Nürnberg/Helsinki (UE) | Múltiplas, inclui NYC/SFO/FRA | — |
| IPv4 | incluído no preço | incluído | — |
| Firewall gerenciado | sim, sem custo extra | sim (Cloud Firewall), sem custo extra | — |
| Snapshot/backup de VPS | add-on separado (não cotado) | add-on separado (20%/mês do preço do droplet, padrão DO) | — |
| Preço/mês | **€19,99** (~US$21–23 dependendo do câmbio) | **US$24,00** | — |
| VPC/rede privada nativa com um Postgres do mesmo provedor | não aplicável (Hetzner não tem Postgres gerenciado, ver seção C) | **sim**, VPC gratuita, sem cobrança de banda interna | — |

Nota: Linode/Akamai não foi cotado em detalhe nesta fase — a pesquisa
concentrou esforço nos dois candidatos que, combinados com um PostgreSQL
gerenciado do próprio catálogo (seção C), fecham a decisão de rede
(Componente C/D). Se a decisão final preferir Linode, a mesma matriz pode
ser preenchida antes da contratação.

## C. PostgreSQL candidatos (Componente B)

| Critério | DigitalOcean Managed PostgreSQL (Standard, menor plano) | Neon (Launch, pay-as-you-go) | Supabase (Pro) |
|---|---|---|---|
| Versão PostgreSQL | gerenciada pelo provedor, atualizações automáticas (16+ disponível) | Postgres moderno (compatível 16+) | Postgres moderno (compatível 16+) |
| SSL | sim, obrigatório | sim, obrigatório | sim, obrigatório |
| Backup automático | **sim — point-in-time, diário, retenção de 7 dias** (confirmado na documentação oficial, "Last verified 17 Sep 2026") | snapshots (manuais inclusos; agendados a US$0,09/GB-mês); histórico de PITR até 7 dias no plano Launch | backups diários, **retenção de 7 dias no plano Pro** (14 dias só no plano Team, US$599/mês) |
| Retenção ≥ 30 dias (nosso requisito) | **não atende sozinho** — precisa da nossa própria rotina de `pg_dump` (Fase 57) por cima | **não atende sozinho**, mesmo motivo | **não atende sozinho**, e o único caminho nativo (Team) custa US$599/mês — inviável |
| Rede privada com VPS do mesmo provedor | **sim — VPC nativa, gratuita** | não aplicável entre provedores diferentes (seria sempre pela internet pública, mitigado por `sslmode=require`) | mesma limitação |
| Export/`pg_dump` | sim, Postgres padrão | sim, Postgres padrão | sim, Postgres padrão |
| Limites de conexão | conforme plano (menor plano é pequeno — adequado ao `max: 3` do pool atual) | connection pooling nativo incluído | pooler incluído (ver "Connections: Pooler" por plano) |
| Preço menor plano | **US$15,15/mês** (1 GB RAM / 1 vCPU) | **pay-as-you-go**: ~US$19/mês para manter 0,25 CU sempre ativo (sem scale-to-zero) + armazenamento (~US$0,35/GB-mês) — ou **US$0 em repouso** se aceitar scale-to-zero (cold start a cada despertar, incompatível com o scheduler de 10–15 min sem gerar custo contínuo) | **US$25/mês de assinatura Pro + US$10/mês de crédito de compute já incluído** (cobre a menor instância) = efetivamente ~US$25/mês mínimo |
| Observação real importante | a partir de 15/out/2026 (novas contas) e 30/nov/2026 (todas as contas), o Standard Edition deixa de oferecer planos acima de 4 GiB de RAM e nós standby/read-only — não afeta o plano mínimo cotado aqui, mas é relevante para crescimento futuro (ver seção K) | arquitetura serverless real (branching de banco é útil para staging, seção J) — "scale-to-zero" precisa ficar desligado no plano Launch para não interferir no scheduler | 7 dias de retenção de backup é a limitação mais concreta encontrada nesta pesquisa |

**Achado central desta etapa, não opinião**: nenhum dos três provedores
pesquisados cumpre sozinho o requisito de retenção ≥30 dias já definido
pelo próprio projeto na Fase 57. Isso não desqualifica nenhum deles — só
confirma que **o procedimento de backup com `pg_dump`/`pg_restore` já
validado na Fase 57 continua sendo a camada que garante os 30 dias de
retenção**, independente de qual desses provedores for escolhido para o
Postgres do dia a dia. O backup nativo do provedor (7 dias) serve só para
recuperação rápida de incidentes recentes — não substitui, só complementa.

## D. DNS/TLS

| Critério | Cloudflare (DNS grátis) | DNS do registrador (referência) |
|---|---|---|
| Custo | US$0 | geralmente incluído na compra do domínio, sem custo adicional |
| DDoS/CDN | DDoS "unmetered" incluso no plano grátis | não aplicável |
| Uso recomendado nesta arquitetura | **modo "somente DNS" (nuvem cinza)** — o nginx continua terminando TLS de verdade com Let's Encrypt; usar o proxy da Cloudflare (nuvem laranja) é opcional e não foi decidido nesta fase | alternativa equivalente para só apontar os registros A/AAAA |

TLS: **Let's Encrypt** (já é a referência usada em `deploy/nginx.conf`
desde a Fase 58) — gratuito, renovação automática via `certbot` ou
equivalente, sem amarração a nenhum provedor específico de VPS/DNS.
Nenhuma autoridade paga foi encontrada com vantagem concreta para o
estágio atual do projeto.

## E. Storage para backup independente (Componente E)

| Critério | Hetzner Storage Box (BX11) | DigitalOcean Spaces |
|---|---|---|
| Capacidade | 1 TB | 250 GiB |
| Preço/mês | **€3,20** (~US$3,50) | **US$5,00** |
| Protocolo | SFTP/SCP/rsync via SSH/FTPS/Samba/BorgBackup/Restic/WebDAV | S3-compatível (já existe adaptador no código, `storageAdapter.tsx`) |
| Transferência | ilimitada | 1 TiB incluso |
| Encaixe com o procedimento já validado (Fase 57) | direto — `pg_dump` + `rsync`/`scp` via SSH, sem SDK nenhum | precisaria do SDK S3 (já existe no projeto, mas não é usado para backup hoje) |

Ambos atendem. Hetzner Storage Box é mais barato e tem mais capacidade
para o mesmo propósito (guardar dumps comprimidos por 30+ dias); DO
Spaces tem a vantagem de reaproveitar o adaptador S3 que já existe no
código para uploads, caso o projeto decida futuramente usar o mesmo
bucket para ambas as coisas (não recomendado — manter backup de banco e
uploads de usuário em buckets/contas separados reduz o raio de um
incidente único).

## G. Networking

- VPS → PostgreSQL: **privado (VPC), quando VPS e Postgres são do mesmo
  provedor** (ex.: DigitalOcean + DigitalOcean) — recomendado sempre que
  possível, por ser gratuito e eliminar a exposição do Postgres à
  internet pública. Quando VPS e Postgres são de provedores diferentes
  (ex.: Hetzner + Neon), a conexão atravessa a internet pública,
  mitigada só por `sslmode=require` — funcional (é exatamente o modelo
  que `.env.example` já previa como alternativa), mas não atende o
  requisito "rede privada quando suportada" tão diretamente.
- Firewall: `ufw` ou firewall gerenciado do provedor (Hetzner Cloud
  Firewall e DigitalOcean Cloud Firewall são gratuitos) — liberar só
  80/443 (nginx) e a porta SSH (idealmente restrita por IP de
  administração); a porta do Express (3001) nunca exposta externamente
  (já garantido pelo `ExecStart`/nginx proxy, Fase 58).
- Acesso administrativo ao Postgres: sempre pela VPC/túnel, nunca com o
  Postgres aceitando conexão pública sem lista de IPs permitidos — ambos
  DigitalOcean e Neon oferecem essa restrição (IP allowlist) nos planos
  cotados.
- VPN: não necessária no estágio atual (instância única, sem equipe
  operacional grande) — reavaliar se o acesso administrativo crescer.

## H. Security baseline (definição, não execução)

- SSH: usuário não-root dedicado (`levora`, já definido no unit systemd
  da Fase 58) para a aplicação; acesso SSH de administração por um
  usuário sudo separado, chave pública apenas (sem senha).
- Firewall: só 22 (SSH, idealmente restrito por IP), 80 e 443 abertos.
- Nginx: config de referência já existe (`deploy/nginx.conf`,
  Fases 58/59).
- TLS: Let's Encrypt, renovação automática.
- Atualizações do sistema: `unattended-upgrades` (Debian/Ubuntu) para
  patches de segurança — definição de baseline, não configurado nesta
  fase.

Nenhum hardening agressivo adicional foi definido — fora do escopo desta
fase.

## I. Custo mensal (duas topologias concretas)

### Topologia 1 — recomendada: mesmo provedor para VPS e Postgres (rede privada)

| Item | Custo/mês |
|---|---:|
| DigitalOcean Basic Droplet (4 GB / 2 vCPU / 80 GB / 4 TB) | US$24,00 |
| DigitalOcean Managed PostgreSQL Standard (1 GB / 1 vCPU) | US$15,15 |
| DigitalOcean Spaces (backup independente, 250 GB) | US$5,00 |
| Cloudflare DNS | US$0,00 |
| Let's Encrypt TLS | US$0,00 |
| **Total mensal recorrente** | **≈ US$44,15** |

Custo inicial: só o domínio (não cotado nesta fase — compra não
autorizada aqui). Custo de crescimento: trocar o Droplet/cluster de
Postgres por um plano maior, sem mudar de provedor nem de topologia.

### Topologia 2 — alternativa: VPS mais barata, Postgres cross-provider (sem rede privada)

| Item | Custo/mês |
|---|---:|
| Hetzner Cloud CPX22 (4 GB / 2 vCPU / 80 GB / 20 TB) | ≈ US$21,70 (€19,99) |
| Neon Launch (0,25 CU sempre ativo, sem scale-to-zero) + storage | ≈ US$19,00–22,00 (estimado por uso, pay-as-you-go — não é um valor fixo contratável) |
| Hetzner Storage Box BX11 (backup independente, 1 TB) | ≈ US$3,50 (€3,20) |
| Cloudflare DNS | US$0,00 |
| Let's Encrypt TLS | US$0,00 |
| **Total mensal recorrente (estimado)** | **≈ US$44,20–47,20** |

As duas topologias ficam no mesmo patamar de custo. A Topologia 2 dá mais
tráfego incluso e um pouco mais de poder de CPU/SSD por dólar na VPS, mas
perde a rede privada entre app e banco (Hetzner não tem Postgres
gerenciado) e o custo do Neon é variável, não fixo (mais difícil de
prever para uma organização sem fins lucrativos orçando mensalmente).

Nenhum custo de IA (Anthropic) ou SMTP foi estimado — ambos são
opcionais, de uso variável, e `.env.example` já documenta que o sistema
funciona corretamente sem eles (degradação graciosa, nunca "fake
feature").

## J. Staging

Viável nas duas topologias, sem usar dados de produção:

- Mesmo Droplet/VPS (um `systemd` service adicional, ex.
  `levora-api-staging`, em outra porta, atrás do mesmo nginx num
  subdomínio como `staging.app.exemplo.org.br`) — evita o custo de uma
  segunda VPS.
- PostgreSQL de staging **separado** do de produção: ou um segundo
  cluster mínimo no mesmo provedor (mais US$15,15/mês na Topologia 1), ou
  — só se o provedor escolhido for o Neon — um **branch** do banco de
  produção com dados reais poderia ser tentador, mas a regra do projeto
  (Fase 57/esta fase: "não usar dados de produção" em staging) significa
  que mesmo a feature de branching do Neon precisaria ser usada a partir
  de um branch "vazio" (schema aplicado via `npm run db:migrate`, nunca
  copiado de produção) para não violar essa regra.
- Secrets de staging: arquivo `EnvironmentFile` próprio
  (`/etc/levora-solidaria/levora-staging.env`), nunca compartilhado com
  o de produção.
- Uploads de staging: diretório separado (`storage/uploads-staging` ou
  volume próprio).

## K. Escalabilidade

**Hoje**: 1 VPS, 1 processo Express (systemd, `Restart=on-failure`),
rate limiter em memória — adequado ao volume atual (nenhuma das fases
anteriores encontrou tráfego real que justifique mais).

**Próximo estágio** (gatilhos já documentados nas fases anteriores, não
reabertos aqui):

- Mais de uma instância do Express → rate limiter precisa migrar para
  um backend compartilhado (Redis ou Postgres) antes disso, não depois.
- Uploads em volume local → object storage (S3-compatible, adaptador já
  existe) no momento em que houver mais de uma instância.
- PostgreSQL Standard (DigitalOcean) com mais de 4 GiB de RAM → migrar
  para Advanced Edition a partir de 15/out/2026 (mudança já anunciada
  pelo provedor, não hipotética).

Nada disso é implementado nesta fase — só documentado como gatilho
futuro, exatamente como já estava em `docs/PRODUCTION_READINESS.md`.
Nenhum Kubernetes, Redis ou CDN obrigatório foi adicionado.

## L/M/N. Arquiteturas comparadas, selecionada e justificativa factual

```text
TOPOLOGIA 1 (selecionada)
Internet
   ↓
Cloudflare DNS (grátis)
   ↓
DigitalOcean Droplet (Nginx + TLS Let's Encrypt + Express + uploads)
   ↓ VPC privada, gratuita, sem exposição pública
DigitalOcean Managed PostgreSQL (SSL, backup de 7 dias nativo)
   ↓ (fora da VPC, canal próprio)
DigitalOcean Spaces (backup pg_dump de 30+ dias, conta/bucket separado)
```

```text
TOPOLOGIA 2 (alternativa, não selecionada)
Internet
   ↓
Cloudflare DNS (grátis)
   ↓
Hetzner CPX22 (Nginx + TLS Let's Encrypt + Express + uploads)
   ↓ internet pública, sslmode=require (sem VPC entre provedores)
Neon PostgreSQL (SSL, PITR de 7 dias nativo)
   ↓
Hetzner Storage Box (backup pg_dump de 30+ dias)
```

**Seleção: Topologia 1 (DigitalOcean Droplet + DigitalOcean Managed
PostgreSQL + DigitalOcean Spaces).**

**Justificativa factual** (não opinião): a arquitetura-alvo já decidida
nas Fases 56/58 exige explicitamente que "o PostgreSQL não deve ficar
aberto à internet desnecessariamente" e recomenda rede privada quando o
provedor suportar. Das duas topologias concretas levantadas nesta fase,
só a Topologia 1 atende essa exigência de forma direta (VPC nativa,
gratuita, sem tráfego passando pela internet pública entre o Express e o
Postgres) — a Topologia 2 depende inteiramente de `sslmode=require`
porque Hetzner não oferece PostgreSQL gerenciado e exigiria um provedor
externo de banco, cruzando a internet pública entre VPS e banco em
qualquer configuração. O custo mensal das duas é equivalente (diferença
de poucos dólares, dentro da margem de incerteza do custo variável do
Neon), então o critério de rede privada — um requisito já documentado,
não uma preferência nova desta fase — decide a favor da Topologia 1.

Em ambas as topologias, o requisito de retenção de backup ≥30 dias só é
cumprido reaproveitando o procedimento `pg_dump`/`pg_restore` já
validado na Fase 57 contra o storage independente (Spaces ou Storage
Box) — nenhum provedor pesquisado cumpre isso nativamente no plano de
entrada.

## O. Infraestrutura necessária antes do deploy

1. Conta DigitalOcean (ou equivalente, se a decisão for revista antes da
   contratação).
2. Criação do Droplet (4 GB/2 vCPU/80 GB), região a definir pela
   localização real dos usuários/organizações da plataforma (não
   definida nesta fase — depende de informação que o projeto ainda não
   forneceu).
3. Criação do cluster PostgreSQL Managed (Standard, 1 GB/1 vCPU), mesma
   região, mesma VPC do Droplet.
4. Criação do bucket Spaces para backup independente.
5. Domínio real registrado (fora do escopo desta fase — "não registrar
   domínio").
6. DNS apontado no Cloudflare (ou registrador) para o IP do Droplet —
   só na fase de deploy real, não nesta.
7. Certificado TLS via Let's Encrypt, emitido só depois do DNS
   apontado de verdade.

## P. Riscos e limitações

- Nenhum dos preços cotados é um contrato — todos podem mudar antes da
  contratação real; a pesquisa tem data (01/10/2026) e deve ser
  reconferida.
- A mudança de planos do DigitalOcean PostgreSQL Standard Edition
  (anunciada para 15/out e 30/nov/2026) não afeta o plano mínimo cotado
  aqui, mas limita o teto de crescimento dentro do Standard Edition —
  relevante só se o volume crescer muito antes de uma futura reavaliação.
- A região do Droplet/Postgres não foi decidida — depende de onde estão
  as organizações reais da plataforma, informação que não existe nos
  documentos consultados.
- O custo do Neon na Topologia 2 é uma estimativa de uso, não um valor
  fixo contratável — por isso a Topologia 1 (custo fixo e previsível) é
  também operacionalmente mais simples de orçar para uma organização sem
  fins lucrativos.
- Esta fase não executa nenhuma prova de conectividade real (Décima
  Sétima Etapa do pedido) contra as contas reais dos provedores — isso
  exigiria criar contas/recursos reais, o que a regra "não fazer deploy
  real" desta fase impede. A prova de conectividade real deve ser o
  primeiro passo da fase seguinte, com um ambiente de teste barato e
  descartável (ex.: menor Droplet + menor cluster Postgres, destruídos
  ao final do teste).

## Q. Documentação

`docs/PRODUCTION_READINESS.md` atualizado com um resumo desta decisão.
Este arquivo (`docs/INFRASTRUCTURE_DECISION.md`) é a decisão consolidada
e a fonte de detalhe.

## R. Atualização da Fase 61 — decisão pausada, prova de conceito zero-custo validada

Antes de provisionar a Topologia 1 (DigitalOcean) de verdade, o projeto
decidiu **pausar qualquer custo de hospedagem até haver investimento**.
A prova de conectividade real prevista na seção P acima foi substituída
por uma prova equivalente, **zero-custo**: Docker local (nginx + Express
compilado + PostgreSQL) exposto à internet real via Cloudflare Tunnel
gratuito (sem conta). Detalhe completo, com evidência real de cada item,
em [`docs/STAGING_ZERO_COST.md`](./STAGING_ZERO_COST.md).

Esta decisão (Topologia 1, DigitalOcean) **continua sendo a escolhida
para quando houver investimento** — nada na pesquisa de mercado desta
fase foi invalidado. O que mudou é só o momento da contratação: a
arquitetura foi provada tecnicamente (build, migrations, scheduler,
backup/restore, rede, TRUST_PROXY, rate limiting, Central Visual) num
ambiente real e público, sem gastar nada, adiando a decisão de qual
provedor pago contratar para quando o projeto tiver capital.

A investigação de rede desta fase trouxe um achado reaproveitável para a
decisão paga futura: a cadeia de confiança de IP precisa ser investigada
e comprovada de verdade a cada topologia nova (nunca assumida) — no caso
do Cloudflare Tunnel, `CF-Connecting-IP` provou ser tão confiável quanto
o `X-Forwarded-For` que um nginx-único-hop já fornecia na Topologia 1
original.

## S. Atualização da Fase 62 — operacionalização

O staging zero-custo (seção R) ganhou scripts operacionais
reprodutíveis e um runbook completo
([`docs/STAGING_OPERATIONS.md`](./STAGING_OPERATIONS.md)). Nenhuma
mudança na decisão de infraestrutura paga em si — a Topologia 1
(DigitalOcean) continua sendo a escolha para quando houver investimento.

Um achado real e crítico surgiu só porque o staging ficou no ar por mais
tempo do que nas fases anteriores: o pool de conexões do Postgres podia
sofrer deadlock total sob sobreposição real de tarefas agendadas,
corrigido isolando o pool do scheduler do pool principal da aplicação
(`src/helpers/db.tsx`). Esse defeito teria afetado igualmente a
infraestrutura paga futura (o bug está na aplicação, não no ambiente) —
ou seja, esta fase de operacionalização "gratuita" acabou endurecendo
também a futura produção real, antes de qualquer gasto.
