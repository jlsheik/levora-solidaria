# Dataset sintético de demonstração (staging) — Levora Solidária

Fase 68. Este documento descreve o seed `seed:staging`: um dataset 100%
sintético, idempotente e criado **pelas mesmas regras do domínio** que um
usuário real usaria. Ele existe para que, depois de um `staging-reset`, seja
possível abrir a Levora e demonstrar uma organização fictícia completa em
poucos minutos, sem cadastrar nada à mão.

> **Exclusivo de staging/demonstração.** Nunca faz parte do processo de
> produção, nunca entra num runbook de produção como passo obrigatório e se
> recusa a rodar fora de um ambiente reconhecido como staging (seção 8).

> **Ressalva de validação (Fase 70).** A disponibilidade pública foi validada
> pela própria máquina hospedeira através da borda Cloudflare, mas ainda não
> houve validação independente por celular/outra rede. Isso **não é um defeito
> de código conhecido**: é um teste que ainda não foi feito (ver seção 7.1).

## 1. Dataset

Tudo é marcado como `(Demo)` / `[Demo]`, usa o domínio reservado
`staging.levora.local` e nenhum dado real (pessoas, empresas, contatos).

### Organizações

| Organização | Tipo | Estado | Papel na demo |
| --- | --- | --- | --- |
| Associação Esperança Viva (Demo) — Belo Horizonte/MG | organização social | **ativa** | organização principal da demonstração |
| Ponto de Distribuição Horizonte (Demo) — Contagem/MG | ponto de distribuição | **ativa** | segunda candidata ao matching |
| Igreja Nova Aurora (Demo) — Betim/MG | igreja | **em análise** | mostra a regra: organização em análise não opera nem entra no matching; o admin da plataforma pode aprová-la na tela de plataforma |

As duas organizações ativas têm capacidades por categoria, áreas de
atendimento e configuração de coleta (usadas pelo matching).

### Necessidades (Esperança Viva)

| Necessidade | Estado | Como chegou lá |
| --- | --- | --- |
| Cobertores para o inverno (30 un) | aberta, não atendida | criada; há uma atribuição aceita com coleta agendada (20 un) ainda não recebida |
| Arroz para cestas básicas (100 kg) | **parcialmente atendida** | recebimento real de 40 kg → `need_fulfillments`: recebido 40, faltam 60, excedente 0 |
| Leite em pó para lactentes (20 un) | **atendida** | `needs-status` → baixa de estoque próprio + `need_resolutions` |
| Kit escolar (15 un) | **cancelada** | `needs-status` → cancelada (histórico) |

A organização Horizonte tem uma necessidade aberta de fraldas (150 un) que
alimenta o matching real.

### Estoque (só por movimentações)

Nenhum saldo é gravado: o saldo é sempre a soma de `stock_transactions`.

| Item | Movimentações | Saldo |
| --- | --- | --- |
| Arroz branco 5kg | +20 inicial, +30 doação, −10 distribuição, **+40 recebimento da rede** | 80 kg |
| Leite em pó lata | +60 inicial, **−20 baixa da necessidade atendida** | 40 un |
| Cobertor casal | +5 inicial | 5 un |
| Fralda infantil M (Horizonte) | +100 inicial | 100 un |

### Oportunidades — registro central (visão da plataforma)

| Oportunidade | Estado | Origem do estado |
| --- | --- | --- |
| Roupas de inverno | descoberta | criada |
| Excedente de legumes | em verificação | curadoria |
| Cestas de higiene | validada | curadoria |
| Fraldas infantis | atribuída | **matching real** (Matching 1.4, score alto → atribuição automática ao Horizonte) |
| Brinquedos educativos | **aguardando destinação** | **matching real** sem candidata elegível (Curitiba/PR, fora de toda área de atendimento) |
| Arroz 40 kg | **concluída** | atribuição → aceita → coleta → transporte → **recebimento real** → conclusão automática |
| Cobertores 20 un | atribuída, coleta agendada | atribuição → aceita → coleta agendada |

### Oportunidades — por organização (tela da organização)

Duas oportunidades do modelo por organização: uma `registrada` e uma
`em_contato`. O estado `recebida` fica de fora de propósito: ele só existe
via recebimento real, que mexe em estoque.

### Tarefas de fundo

As tarefas de manutenção (`expireReservations`, `expireOpportunities`,
`expireApprovalRequests`, `verifyAuditChain`) são executadas uma vez pelos
mesmos handlers que o scheduler usa, para que a tela de tarefas já mostre
execuções reais. `runMatchingSweep` fica de fora (poderia reavaliar o
matching); o scheduler o executa normalmente a cada 15 minutos.

## 2. Usuários

| Papel | E-mail | Observação |
| --- | --- | --- |
| **Conta demo** — proprietário da Esperança Viva | `demo@staging.levora.local` | usar este para abrir a aplicação |
| Operador da Esperança Viva | `operador@staging.levora.local` | registra logística e recebimentos |
| Proprietário de Horizonte e Aurora | `parceiro@staging.levora.local` | mostra o isolamento entre organizações |
| Administrador da plataforma | `admin@staging.levora.local` | tela `/plataforma`: fontes, organizações, registro central, tarefas |

O domínio `.local` é aceito pela validação de e-mail do cadastro (validado em
teste). Nenhum desses endereços existe de verdade.

## 3. Credenciais temporárias

**Não há senha fixa no Git, no código, no `.env` nem neste documento.**

- A senha de cada usuário é gerada aleatoriamente (96 bits) na hora em que o
  usuário é criado, passa pelo hash oficial da aplicação e é **exibida uma
  única vez, no terminal** que rodou o seed.
- Num segundo run os usuários já existem e a senha **não é re-exibida**
  (`já existia — inalterada`). Para obter senhas novas:
  `.\scripts\staging-seed.ps1 -ResetPasswords`.
- Se não anotou a senha, o caminho é `-ResetPasswords` ou um novo
  `staging-reset` + seed.

## 4. Como rodar o seed

Com o staging no ar (`.\scripts\staging-up.ps1`):

```powershell
.\scripts\staging-seed.ps1
```

O script executa `node dist-server/db/seed-staging.js` **dentro do container
`app`** (o Postgres do staging não publica porta no host) com
`LEVORA_ENVIRONMENT=staging`. Equivalente manual:

```powershell
docker compose -f docker-compose.staging.yml exec -T -e LEVORA_ENVIRONMENT=staging app npm run seed:staging
```

O que ele faz, nesta ordem: valida o ambiente → abre a conexão → cria o que
falta → valida o resultado → imprime contagens e credenciais.

> O aviso em vermelho `SMTP não configurado` no meio da saída é esperado: o
> convite do operador tenta enviar e-mail, e o staging não tem SMTP. Quem
> aceita o convite é o próprio seed.

## 4.1 Como o dataset é criado (e o que NÃO é)

O seed chama o `handle()` de cada endpoint real com uma sessão autenticada —
RBAC, trilha de auditoria encadeada, triggers append-only e máquinas de
estado do servidor valem normalmente. Nenhum trigger é desativado e nenhuma
FK é relaxada.

Únicas escritas SQL diretas, sem endpoint equivalente (todas restritas aos
e-mails sintéticos deste seed):

1. conceder a `admin@staging.levora.local` um `platform_access` ativo de nível `owner` (Fase 89: `users.role = 'admin'`
   foi aposentado e o banco recusa esse valor; não existe endpoint de promoção; é o bootstrap do papel de plataforma);
2. redefinir senhas (`-ResetPasswords`);
3. criar e apagar as linhas de `sessions` usadas nas chamadas internas (o
   seed não deixa nenhuma sessão para trás).

## 5. Reset

```powershell
.\scripts\staging-reset.ps1 -Confirm     # pede a frase APAGAR STAGING
.\scripts\staging-seed.ps1
```

Isso devolve um ambiente demo limpo e completo, sem depender de nenhum dado
cadastrado manualmente antes. Opcional: `.\scripts\staging-backup.ps1` antes
do reset.

## 6. Procedimento de demonstração

### 6.1 Preparação (antes de chamar a pessoa)

```powershell
.\scripts\staging-up.ps1          # ~40-90 s; só devolve o controle quando o túnel está pronto
```

O script termina imprimindo `STAGING URL:` e a linha **"Verificada pela borda
da Cloudflare … pode abrir"**. Se aparecer em vermelho que não conseguiu
confirmar a URL, espere ~1 minuto e rode `.\scripts\staging-status.ps1`.

Se o ambiente nunca foi populado, ou se quiser voltar ao estado de fábrica:

```powershell
.\scripts\staging-reset.ps1 -Confirm      # frase APAGAR STAGING
.\scripts\staging-seed.ps1                # imprime as senhas temporárias, uma vez
```

Se os dados já estão lá (o `down`/`up` preserva o volume), **não é preciso
rodar o seed de novo.**

### 6.2 Onde está a URL

- Impressa ao final do `staging-up.ps1`.
- Depois, a qualquer momento: `.\scripts\staging-status.ps1` (seção
  "Cloudflare Tunnel").
- **Ela muda toda vez que o túnel é reiniciado** (`down` → `up`); uma URL
  entregue antes de um `down` deixa de funcionar.

### 6.3 Conta

`demo@staging.levora.local`. A senha não está escrita em nenhum arquivo: é a
que o seed imprimiu no terminal quando criou o usuário. Se ela se perdeu ou
foi exposta em algum lugar compartilhável:

```powershell
.\scripts\staging-seed.ps1 -ResetPasswords   # gera senhas novas e as imprime uma vez
```

Para a parte administrativa, `admin@staging.levora.local` (mesmo mecanismo).

### 6.4 Roteiro (10 a 15 minutos)

1. **Login:** abrir a URL e entrar como `demo@…`.
2. **Painel:** a Associação Esperança Viva, ativa, papel Proprietário, 2
   membros.
3. **Organização:** equipe (demo e operador) e a trilha de auditoria com os
   eventos reais da carga (criação, atribuição, logística, recebimento).
4. **Inventário:** saldos derivados (arroz 80 kg, leite 40 un, cobertor 5 un);
   "Últimas movimentações" mostra o recebimento da rede e a baixa automática
   de leite pela necessidade atendida.
5. **Necessidades:** quatro estados (aberta, parcialmente atendida, atendida,
   cancelada); no arroz, "Recebido pela rede 40 / Faltam 60 / Excedente 0".
6. **Oportunidades:** a tela da organização (2 oportunidades: uma registrada,
   uma em contato) e **Rede Levora** (atribuições): o arroz já recebido e os
   cobertores com coleta agendada ("Marcar coleta concluída" / "Iniciar
   transporte").
7. **Matching:** em "Configurações de Matching", as capacidades e áreas de
   atendimento que alimentam o motor; na plataforma (passo 9), as avaliações
   reais.
8. **Prestação de contas:** calculada ao vivo do histórico real de estoque e
   auditoria.
9. **Plataforma** (sair e entrar como `admin@…`, abrir `/plataforma`): registro
   central com sete oportunidades em estados diferentes; "Ver avaliações de
   matching" na de fraldas (score, algoritmo v1.4 e os critérios); "Rodar
   matching agora" na que aguarda destinação; a organização em análise com o
   botão "Aprovar"; e as tarefas de fundo executadas.

### 6.5 Encerrar

```powershell
.\scripts\staging-down.ps1      # encerra o túnel e os containers; os dados ficam
```

A URL pública para de responder na hora. Para repetir a demonstração depois:
`staging-up.ps1` (os dados continuam; só a URL é nova).

## 7. Limitações

**Operacionais (este NÃO é um ambiente de produção):**

- O computador precisa estar **ligado e com Docker rodando** durante toda a
  demonstração; se ele dormir, a conexão cai.
- Roda numa **conexão de internet residencial**: sem IP fixo, sem garantia
  de banda ou disponibilidade.
- A URL é de um **Quick Tunnel gratuito, temporário e sem conta**: muda a
  cada reinício do túnel e não há SLA da Cloudflare para ele.
- **Sem redundância:** instância única de app e de banco; qualquer falha
  derruba o ambiente.
- **Sem backup geograficamente independente:** os backups
  (`staging-backup.ps1`) ficam no mesmo computador; copie para outro lugar se
  os dados importarem.
- **Sem alertas externos:** ninguém é avisado se cair; o monitoramento é
  `staging-status.ps1`, rodado à mão.
- Logo após o `up`, o nome do túnel leva alguns segundos para existir no DNS;
  o `staging-up.ps1` espera por isso, mas uma URL copiada de um `up` antigo
  não vale mais.

### 7.1 Validação por segunda rede/aparelho — PENDENTE

A disponibilidade pública foi validada pela própria máquina hospedeira
através da borda Cloudflare (a requisição sai desta máquina, vai à Cloudflare
e volta pelo túnel), mas ainda não houve validação independente por
celular/outra rede. Requisições da mesma máquina, outra aba ou outro navegador
**não** são equivalentes a uma segunda origem e não foram contadas como tal.

Para fechar a pendência (a executar pelo dono do projeto, não automatizável):

1. `.\scripts\staging-up.ps1` e copiar a URL impressa (só vale para esta subida);
2. abrir a URL num celular **em dados móveis** (Wi-Fi desligado) ou noutra
   conexão;
3. entrar como `demo@staging.levora.local` e percorrer o roteiro (6.4);
4. `.\scripts\staging-down.ps1` ao terminar.

**Do dataset e do produto:**

- A tela de prestação de contas lista as quantidades iniciais dos itens
  como "doações recebidas no período" — é o comportamento atual da
  aplicação, não do seed.
- O texto da tela de tarefas ainda cita "plano pago ativo" (texto
  herdado da plataforma original) — fora do escopo desta fase.
- As descrições das necessidades trazem "(cenário N)" para guiar a demo;
  são texto de demonstração, não de produto.
- Não há SMTP: e-mails (convites) não são enviados de verdade.
- IA não configurada no staging: o matching usa o fallback determinístico
  (por palavras-chave); as avaliações mostram `ai_model_used` vazio.
- Idempotência cobre os dados do seed. Dados criados à mão por cima
  (outras organizações, por exemplo) não são tocados nem removidos.
- O seed não verifica se o banco contém dados reais: a proteção é o
  reconhecimento do ambiente (seção 8), não uma inspeção do conteúdo.
- Idempotente não significa imutável: o scheduler real continua rodando e
  acrescentando execuções de tarefas e eventos de auditoria ao longo do
  tempo, como em qualquer ambiente.

## 8. Segurança

Guarda de ambiente (`db/seedStagingGuard.ts`), executada **antes de qualquer
conexão** (o módulo é puro; o seed só é importado depois que ela passa).
`NODE_ENV` sozinho não distingue staging de produção (o container de staging
roda o mesmo artefato de produção e o compose nem define `NODE_ENV`), então a
guarda exige três evidências independentes e recusa em qualquer dúvida:

1. `LEVORA_ENVIRONMENT=staging`, declarado explicitamente, e nenhuma outra
   variável de ambiente (`APP_ENV`, `ENVIRONMENT`, `DEPLOY_ENV`,
   `VERCEL_ENV`, `RAILWAY_ENVIRONMENT`) declarando produção;
2. nome do banco reservado, terminando em `_staging` ou `_demo`;
3. host do banco numa lista fechada: `postgres` (serviço do compose de
   staging) ou loopback. Banco remoto/gerenciado nunca passa.

`DATABASE_URL` e `FLOOT_DATABASE_URL` divergentes também recusam (ambíguo).
O CLI não carrega `.env`, para que um `.env` de desenvolvimento não "promova"
o script por acidente. Exceção única: os testes automatizados, que usam
`NODE_ENV=test` + banco `*_test`.

Recusa = exit code 2, mensagem listando os motivos e "Nenhuma conexão com o
banco foi aberta". Provado por testes automatizados que executam o CLI
real com ambiente de produção e um host inalcançável.

Outros pontos: nenhum segredo no código; credenciais só no terminal; e-mails
`.local`; nenhum dado real.

## 9. Produção

`seed:staging` **não deve ser usado em produção** e não faz parte de nenhum
procedimento de implantação de produção. Os documentos de produção
(`DEPLOYMENT.md`, `DEPLOYMENT_RUNBOOK.md`, `PRODUCTION_READINESS.md`) não o
referenciam. O script antigo `db:seed` (apontava para o `db/seed.ts`, que
nunca existiu) foi removido do `package.json`.
