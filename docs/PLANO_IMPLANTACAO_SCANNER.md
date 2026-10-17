# Plano de implantação do scanner antimalware (ClamAV) — SOMENTE PLANO

**Nada deste documento foi provisionado ou executado.** Não altera `docker-compose.staging.yml`, `deploy/` nem qualquer ambiente. Cada passo abaixo precisa de decisão de arquitetura, autorização e (quando houver custo) aprovação de quem responde pela infraestrutura. Contexto técnico: `docs/ANTIMALWARE_ARQUIVOS.md`; riscos: `docs/RISCOS_PRE_PRODUCAO_POS_99K.md`.

## 1. Estado real da infraestrutura (inspeção)

- `docker-compose.staging.yml`: `postgres:16`, `app` (Express compilado, `STORAGE_LOCAL_DIR` em volume), `nginx` publicado só em `127.0.0.1:8088`; rede `levora_staging_net`; sem scanner. Staging "zero custo" (Quick Tunnel), explicitamente **não é produção**.
- `deploy/levora-api.service` (systemd, processo único) + `deploy/nginx.conf`: referência de produção sem scanner, sem host definido. O rate limiter é em memória por processo (um só processo).
- Health check existente da aplicação: `GET /_api/__health`. Não há métricas Prometheus nem fila de tarefas além do scheduler interno.
- **Não existe** serviço ClamAV, host de produção, orçamento nem dado de utilização real. Portanto **não há base para estimar custo**; dados necessários: provedor/host, tamanho da máquina disponível, volume de uploads/mês, tamanho médio, picos.

## 2. Arquitetura-alvo proposta (a aprovar)

- Um serviço `clamd` por ambiente, **na mesma rede privada da aplicação** (rede interna do compose, ou interface privada/VPC/loopback do host). **Nenhuma porta publicada** em interface pública; o `clamd` **não autentica** nem cifra o TCP, então a proteção é a rede (regra de firewall permitindo só o host da aplicação; sem `ports:` no compose do scanner, apenas `expose`/rede interna).
- A aplicação já lê `CLAMD_HOST`, `CLAMD_PORT`, `CLAMD_TIMEOUT_MS`, `CLAMD_MAX_BYTES`; em produção a análise é obrigatória e sem `CLAMD_HOST` nada é liberado. Mantém-se `StreamMaxLength` do `clamd` ≥ `CLAMD_MAX_BYTES` (e ≥ 8 MB, limite de upload).
- Imagem **fixada por versão e digest** (a validada localmente: `clamav/clamav:1.5.4-debian13-slim`, `sha256:9a96980b265cb2b51a20bdcca921dc80aa55ed0e56cdfb076198ee27a9171927`); nunca `latest`. Atualização de versão do motor = mudança planejada, com repetição do teste real (EICAR + limpo + indisponibilidade).

## 3. Assinaturas (ponto crítico descoberto na validação)

- Na imagem, o `freshclam` baixa o `daily` mais novo **antes** de o `clamd` abrir o socket ("Clamd was NOT notified"), então o daemon sobe com a base embutida (observado: 28151) enquanto o disco tem a nova (28155). **O daemon analisa com a base que carregou.** Procedimento: após o primeiro `freshclam`, executar `clamdscan --reload` (levou cerca de um minuto) e conferir por protocolo (`VERSION`) que a versão do daemon bate com a do disco.
- Operação contínua: `freshclam` periódico (a imagem oficial já o executa); volume persistente para `/var/lib/clamav` para não rebaixar a base a cada reinício; checagem de **idade da base** (alerta se a data retornada por `VERSION` tiver mais de N dias — N a definir pela operação; **não há valor aprovado**).
- A atualização automática consome rede de saída para os espelhos oficiais; avaliar a política de egress do ambiente.

## 4. Recursos (distinguir teste de produção)

- Teste local: limite arbitrário de 5 GiB/4 CPUs num host de 16 GiB/16 CPUs; o consumo real **não foi medido** nesta validação (sem coleta de `docker stats`). A base de ~3,6 milhões de assinaturas fica na RAM e o reload pode duplicar o uso por instantes.
- Produção: **dimensionamento desconhecido**. Medir antes de decidir: RAM residente após carga e durante reload, latência por arquivo (até 8 MB), vazão com N uploads simultâneos e o comportamento do `MaxThreads` do `clamd`. Reservar margem para o reload.

## 5. Health checks, timeouts e indisponibilidade

- Health do scanner: `clamdscan --ping` / comando `PING` (resposta `PONG`) como health check do contêiner/serviço; verificar também `VERSION` (idade da base). A imagem oficial já expõe `healthy` no Docker.
- Aplicação: `CLAMD_TIMEOUT_MS` (padrão 15 s). Indisponibilidade ⇒ arquivo `indisponivel`, **retido e não liberado** (falha fechada); o usuário vê mensagem genérica e pode "Analisar novamente". Não há fila nem reprocessamento automático (melhoria: tarefa agendada que reanalisa `indisponivel`/`pendente` com limite de tentativas e backoff, idempotente — a reanálise atual já é idempotente).
- Reprocessar legados: `legado_nao_analisado` fica bloqueado em produção até `POST /files-rescan` (por arquivo); um script em lote, somente leitura de seleção e idempotente, é melhoria futura.

## 6. Observabilidade (sem conteúdo)

Já existe: auditoria `arquivo.analise_aprovada` / `arquivo.bloqueado_por_analise` / `arquivo.analise_indisponivel` (motor, assinatura, motivo; **nunca** conteúdo, nome de objeto de armazenamento ou URL privada) e log `ANALISE_FALHOU fileId=… organizationId=…`. A conciliação (`GET /destination-proofs-reconciliation`) lista `retidosPorAnalise`. **A criar (não existe):** métricas/alertas de (a) backlog de `pendente`/`indisponivel` por idade, (b) taxa de `indisponivel`, (c) idade da base de assinaturas, (d) reinícios/falha do health do `clamd`, (e) divergência da conciliação. Logs do `clamd` não devem ser enviados a terceiros sem revisão (podem conter nomes de assinaturas, não conteúdo).

## 7. Testes antes de habilitar no ambiente definitivo

1. Subir o serviço em rede privada de **staging** (não em produção) e provar que a porta não responde fora da rede permitida (varredura a partir de fora e de um host não autorizado).
2. Repetir o teste real (`CLAMD_HOST` apontando ao serviço): `test/fileScan.test.ts` completo, EICAR (direto e em PDF), arquivo limpo, indisponibilidade (derrubar o serviço **só do staging**).
3. Conferir `VERSION` do daemon × disco após o primeiro `freshclam` e o `--reload`.
4. Carga: uploads simultâneos de 8 MB; medir latência, memória e comportamento do reload sob carga.
5. Reiniciar o serviço e provar a falha fechada e a recuperação por reanálise.
6. Confirmar que os logs/auditoria não contêm conteúdo nem segredos.
7. Validação oficial do GitHub da cadeia de PRs após a integração sequencial (hoje as PRs encadeadas não têm checks).
8. Checklist de decisão jurídica de retenção (`docs/DECISAO_RETENCAO_COMPROVANTES.md`) concluído antes de tratar o conteúdo dos comprovantes como liberado para produção.

## 8. Fora do escopo deste plano (decisões externas)

Escolha do provedor/host, orçamento, contas, segredos, política de egress, política de retenção e prazo de assinaturas desatualizadas. Nenhum recurso, conta ou serviço pago foi criado.
