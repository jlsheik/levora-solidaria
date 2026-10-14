# Backup, restore e recuperação do PostgreSQL

Fase 57. Fecha o bloqueador identificado na Fase 55/56: "backup/restore
operacionalmente comprovado" ainda não existia. Este documento descreve o
procedimento real, testado nesta fase contra o banco de desenvolvimento
(nunca produção), e os requisitos que qualquer provedor de Postgres
escolhido para produção precisa cumprir.

**Nada aqui foi executado contra produção.** Todo o experimento usou o
container `levora-postgres` (dev), um banco de teste separado
(`levora_solidaria_restore_test`, criado e descartado nesta mesma fase) e
nenhuma credencial real foi impressa em nenhum momento.

## 1. Inventário do banco (ponto de partida)

| Item | Valor |
|---|---|
| Versão do servidor (dev) | PostgreSQL 16.15 |
| Versão mínima suportada | 16 (mesma usada em CI, Fase 54, e documentada como requisito desde a Fase 56) |
| Tabelas | 26 |
| Triggers | 22 |
| Índices | 71 |
| Constraints | 276 |
| Sequences | 23 |
| Extensões | 2 (`pgcrypto`, `plpgsql`) |
| Funções próprias da aplicação | 3 (`audit_log_block_mutation`, `need_fulfillments_validate_entry`, `set_updated_at` — as demais 36 "funções" listadas pelo `information_schema` são da própria extensão `pgcrypto`, não código deste projeto) |
| Migrations aplicadas | 13 (`0001`–`0013`) |

**Achado real desta fase, corrigido**: `schema_migrations` tinha só 12 das
13 migrations registradas — a migration `0013_users_email_case_insensitive.sql`
(Fase 48) foi aplicada na época via `psql -f` direto, fora de
`db:migrate:incremental`, e nunca ficou registrada na tabela de
rastreamento, apesar de seus efeitos (o índice `idx_users_email_lower`)
estarem corretamente presentes no schema. Isso não é um problema de
dados nem de schema — é só a tabela de bookkeeping desalinhada do estado
real. Corrigido nesta fase inserindo a linha que faltava (confirmado via
`SELECT id FROM schema_migrations`, agora 13/13). Sem essa correção, uma
futura execução de `db:migrate:incremental` contra este mesmo banco
tentaria reaplicar `0013` e falharia (`CREATE UNIQUE INDEX` sem
`IF NOT EXISTS` contra um índice que já existe) — exatamente o tipo de
inconsistência que esta fase pede para investigar antes de modificar
qualquer coisa, o que foi feito.

**Nada que não seja coberto por `pg_dump`/`pg_restore` padrão foi
encontrado** — sem tabelas particionadas, sem tipos customizados fora do
schema público, sem dados externos (`foreign data wrapper`), sem
sequences desacopladas de uma coluna `serial`/`generated`.

## 2. Formato de backup escolhido

| Critério | Custom format (`-Fc`) | Plain SQL (`-Fp`) |
|---|---|---|
| Velocidade de dump | Comparável | Comparável |
| Restauração seletiva (uma tabela só) | **Sim** (`pg_restore -t tabela`) | Não (precisaria editar o SQL manualmente) |
| Compressão nativa | **Sim** (`-Z`, gzip) | Não (precisaria `gzip` externo) |
| Paralelismo no restore | **Sim** (`pg_restore -j N`) | Não |
| Portabilidade entre versões | Boa (formato binário versionado do `pg_dump`) | Melhor (texto puro, qualquer ferramenta lê) |
| Inspeção antes de restaurar | `pg_restore --list` (tabela de conteúdo, sem tocar no banco) | Precisa abrir o arquivo inteiro |
| Facilidade de diff/leitura humana | Baixa (binário) | Alta (texto) |

**Escolhido: custom format (`-Fc`), com compressão (`-Z 6`)** — restauração
seletiva e inspeção prévia (`pg_restore --list`) sem tocar no banco são
vantagens operacionais reais para um procedimento de disaster recovery, e
a perda de "legibilidade humana direta" não importa aqui (o procedimento
nunca pede para ler o dump a olho nu, só restaurá-lo).

Comando real usado (idêntico ao que qualquer ambiente real executaria):

```bash
pg_dump -U <usuario> -d levora_solidaria -Fc -Z 6 -f levora_backup.dump
```

- Formato: `custom` (`-Fc`)
- Compressão: gzip nível 6 (`-Z 6`, equilíbrio padrão entre velocidade e
  tamanho)
- Cliente: `pg_dump` 16.15 (mesma versão do servidor — evita qualquer
  incompatibilidade de formato)
- Versão mínima de servidor compatível para restaurar: qualquer Postgres
  ≥ 16 (a mesma versão ou mais nova; `pg_restore` de versão igual ou
  posterior ao `pg_dump` que gerou o arquivo)
- Nomenclatura recomendada para produção:
  `levora_solidaria_<ambiente>_<AAAAMMDD-HHMMSS>.dump` (inclui data/hora
  para nunca depender só da data de modificação do arquivo para saber sua
  idade)

## 3. Backup realizado (evidência real)

Executado contra o banco de desenvolvimento real (39 eventos de
auditoria, 48 usuários, 23 sessões, entre outras tabelas — nenhum dado de
produção):

```
$ pg_dump -U postgres -d levora_solidaria -Fc -Z 6 -f levora_backup.dump
tempo: 279ms
```

Arquivo gerado: **142.386 bytes** (~139 KB) — tamanho consistente com o
volume de dados atual (pequeno, ambiente de desenvolvimento).

## 4. Integridade do backup

Não aceito como válido só porque `pg_dump` saiu com código 0. Verificado:

1. **Existência e tamanho**: arquivo presente, 142.386 bytes (não
   truncado/vazio).
2. **Checksum**: `sha256sum` calculado sobre o arquivo —
   `c1d425d751e2a2af5462f2a7640e1d5cc12e6212abb5461aeae4626309c79ed`.
   **Requisito de produção**: este checksum precisa ser registrado num
   local DIFERENTE de onde o backup fica armazenado (ex.: um log
   separado, um manifesto num bucket diferente, ou o próprio sistema de
   monitoramento) — nunca um arquivo `.sha256` ao lado do backup no mesmo
   bucket/diretório, porque uma alteração maliciosa ou corrupção que
   afete os dois arquivos juntos ficaria invisível. Nesta fase, o
   checksum foi registrado só no relatório/transcript desta sessão
   (efetivamente um local separado do arquivo em si), não implementado
   como mecanismo automatizado — isso é um requisito a cumprir pelo
   provedor/pipeline de produção.
3. **Leitura do archive sem restaurar** (`pg_restore --list`): confirmado
   um archive `CUSTOM` válido, 323 entradas de TOC (tabelas, triggers,
   funções, dados), gerado pelo `pg_dump 16.15`, comprimido com gzip —
   prova que o arquivo é estruturalmente íntegro e legível, sem
   precisar restaurar nada ainda.
4. **Restauração real** (próxima seção) — a prova definitiva de
   integridade.

## 5. Restore em banco separado

```
$ dropdb/createdb levora_solidaria_restore_test   (411ms)
$ pg_restore -U postgres -d levora_solidaria_restore_test \
    --no-owner --no-privileges levora_backup.dump  (599ms)
```

**Nunca restaurado sobre o banco de origem** — sempre um banco novo e
separado, descartado ao final do experimento.

## 6. Validação estrutural

Comparação exata, objeto por objeto, entre o banco original e o
restaurado:

| Item | Original | Restaurado |
|---|---|---|
| Tabelas | 26 | 26 |
| Triggers | 22 | 22 |
| Índices | 71 | 71 |
| Constraints | 276 | 276 |
| Sequences | 23 | 23 |
| Extensões | 2 | 2 |
| `schema_migrations` | 13 linhas | 13 linhas |
| `idx_users_email_lower` (Fase 48) | presente | presente |
| Triggers `audit_log_no_update`/`audit_log_no_delete` | presentes | presentes |
| Triggers `need_resolutions_no_update`/`_no_delete` | presentes | presentes |
| FK composta `need_fulfillments_stock_transaction_org_fkey` (Fase 33) | presente | presente |

**Idêntico em todos os itens verificados.**

Contagem exata de dados (não a estimativa de `pg_stat_user_tables`, que
se mostrou desatualizada neste ambiente — `n_live_tup` reportava 2 linhas
em `audit_log` quando o valor real, confirmado por `COUNT(*)`, era 39;
achado registrado aqui porque validar um restore usando estatísticas
aproximadas em vez de contagem exata teria mascarado um problema real se
houvesse um):

| Tabela | Original | Restaurado |
|---|---|---|
| `users` | 48 | 48 |
| `audit_log` | 39 | 39 |
| `sessions` | 23 | 23 |

## 7. Validação funcional

Não bastou o Postgres aceitar o restore. Confirmado que **a aplicação
real funciona** contra o banco restaurado:

1. **Trigger append-only testado de verdade** (não só sua presença):
   `DELETE FROM audit_log` contra o banco restaurado foi rejeitado com o
   mesmo erro do banco original (`"Esta tabela é append-only..."`) —
   prova que a proteção funciona, não só que a definição do trigger foi
   copiada.
2. **`verifyAuditLogChain()` (o verificador canônico real, não uma
   reimplementação)** rodado contra o banco restaurado, via
   `DATABASE_URL` apontado temporariamente para ele (nunca editado no
   `.env`):

   ```json
   {
     "totalEventos": 39,
     "eventosVerificados": 26,
     "eventosPreExistentesSemHash": 13,
     "integra": true,
     "divergencias": []
   }
   ```

   Idêntico ao resultado contra o banco original.
3. **Aplicação real (servidor + cliente) apontada para o banco
   restaurado** (via variável de ambiente só para essa execução — nunca
   tocado o `.env` real) e testada via Central Visual:
   - Login com uma conta real já existente no banco restaurado — funcionou.
   - Dashboard carregou normalmente.
   - Rota de organização (`/organizacoes/15/necessidades`) carregou
     normalmente.
   - Painel `/plataforma` → "Tarefas de fundo" mostrou o histórico real
     de `background_task_runs` restaurado, incluindo a execução da
     verificação da audit chain da Fase 53.
   - Mobile (375×812): dashboard renderizado sem overflow.

**Nenhuma linha de código da aplicação foi alterada para "funcionar com o
banco restaurado"** — ele simplesmente funcionou, porque é o mesmo schema.

## 8. Tempo de recuperação (medido, não estimado)

| Etapa | Tempo medido |
|---|---|
| Criar banco vazio | 411ms |
| Restore (`pg_restore`) | 599ms |
| Validação estrutural (contagem de tabelas) | 183ms |
| **Subtotal: banco + restore + validação estrutural** | **1.250ms (~1,25s)** |
| Inicialização da aplicação (processo até `/_api/__health` responder 200) | 2.110ms |
| Validação funcional (login + navegação, manual nesta fase) | alguns segundos (não cronometrado — interação manual via Central Visual) |

**Tempo total técnico demonstrado (banco → restore → aplicação pronta):
≈ 3,4 segundos.**

**O que este número NÃO inclui** (honestidade sobre o escopo do
experimento): este teste restaurou para um Postgres **já em
execução** (o mesmo container de desenvolvimento). Um cenário real de
disaster recovery onde o servidor Postgres inteiro precisa ser
**provisionado do zero** (seção 14) adicionaria o tempo de
provisionamento do provedor escolhido — tipicamente minutos, não
segundos, e varia por provedor. O RTO final (seção 10) soma esse tempo
de provisionamento ao tempo técnico aqui medido.

**Volume de dados**: este teste usou ~139 KB de dados (ambiente de
desenvolvimento). O tempo de restore cresce com o volume real de
produção — este número precisa ser remedido periodicamente à medida que
o banco de produção crescer, não tratado como uma constante para sempre.

## 9. RPO (Recovery Point Objective)

Meta definida: **≤ 24h**.

Com backup diário automático, o **pior caso teórico** de perda de dados é
de quase 24h (um evento de perda de dados ocorrendo segundos antes do
próximo backup agendado perderia tudo desde o backup anterior). Isso
cumpre a meta de "≤ 24h" no pior caso, mas não é um RPO "exato" —
é um limite superior. Se o provedor escolhido oferecer **point-in-time
recovery** (PITR, seção 13), o RPO real passa a ser de minutos, não
horas — avaliado como melhoria futura, não requisito do lançamento
inicial.

## 10. RTO (Recovery Time Objective)

Meta definida: **≤ 4h**.

Decomposição honesta:

```
tempo de provisionar um novo Postgres (varia por provedor, tipicamente minutos a ~1h)
+ configurar SSL/rede                                        (minutos)
+ restore (medido nesta fase, ~0,6s para ~139KB —
  escala com o volume real de produção)
+ validação estrutural/funcional                              (minutos, se manual)
+ aplicar configuração/secrets na API                         (minutos)
+ subir a API + health check                                  (medido: ~2,1s)
+ liberar tráfego
= tipicamente dentro de 4h para um provisionamento manual,
  bem dentro de 4h se o provedor oferecer restore automatizado
```

**A meta de 4h é alcançável com folga confortável** para o volume e a
complexidade atuais do sistema, mas **não foi testada contra um
provisionamento real de infraestrutura do zero** nesta fase (regra
explícita: não contratar serviço). O número "≤ 4h" permanece uma meta
informada pela medição técnica real (seção 8), não uma medição completa
de ponta a ponta incluindo provisionamento de infraestrutura nova.

## 11. Retenção

Política-alvo: **30 dias**, com:

- Pelo menos 1 backup por dia dentro da janela de retenção (mínimo 30
  backups diários encadeados, mais quaisquer backups semanais/mensais
  adicionais que o provedor ofereça).
- Rotação automática: backups com mais de 30 dias descartados
  automaticamente pelo provedor (nunca um script caseiro de limpeza
  rodando contra o storage de backup).
- Nomenclatura com timestamp (seção 2) para que a idade de cada backup
  seja verificável sem depender de metadado de filesystem.
- Proteção contra apagamento acidental: a conta/credencial usada pela
  aplicação para operação normal **nunca** deve ter permissão de deletar
  backups — essa permissão deve ficar isolada numa credencial
  administrativa separada.

## 12. Criptografia

- **Em trânsito**: `DATABASE_URL` em produção deve usar `sslmode=require`
  (já documentado como requisito desde a Fase 56) — a conexão entre a
  API e o Postgres é criptografada.
- **Em repouso**: requisito para o provedor — o storage do banco E dos
  backups deve suportar criptografia em repouso (praticamente padrão em
  qualquer provedor de Postgres gerenciado real — RDS, Neon, Supabase,
  etc., todos oferecem isso).
- **Nenhuma criptografia caseira** foi criada nesta fase — correto,
  reinventar isso seria pior que usar o suporte nativo do provedor.

## 13. Point-in-time recovery (PITR) — avaliado, não adotado agora

| Critério | Backup diário (adotado) | PITR |
|---|---|---|
| RPO | Até ~24h (pior caso) | Minutos |
| Complexidade | Baixa — `pg_dump` padrão | Maior — requer WAL archiving configurado continuamente |
| Custo | Baixo (só o storage dos dumps) | Maior (storage contínuo do WAL + processamento) |
| Adequação ao volume atual | Suficiente — o sistema ainda não tem volume/criticidade que justifique RPO em minutos | Over-engineering para o estágio atual |

**Decisão: backup diário cumpre os requisitos definidos (RPO ≤ 24h) para
o lançamento inicial.** PITR fica registrado como melhoria futura
avaliável se o volume/criticidade do sistema crescer — não adotado agora
por não haver necessidade comprovada, consistente com a regra desta fase
de não adicionar por prestígio técnico.

## 14. Backup fora do servidor do banco

Requisito explícito: o backup **não pode depender só do mesmo
disco/host do Postgres**. Fluxo exigido:

```
Postgres (produção)
    │ pg_dump
    ▼
arquivo de backup
    │
    ▼
storage INDEPENDENTE (bucket/serviço gerenciado separado,
nunca o mesmo filesystem local da aplicação nem o mesmo disco do banco)
```

A maioria dos provedores de Postgres gerenciado já cumpre isso por
padrão (backup automático armazenado em infraestrutura própria do
provedor, fisicamente separada do disco do banco). Se um `pg_dump`
manual for usado em vez de backup gerenciado, o destino do arquivo
**precisa** ser um storage diferente do host do Postgres.

## 15. Disaster recovery — fluxo completo

```
PostgreSQL indisponível
        ↓
provisionar novo PostgreSQL (provedor escolhido, versão 16+)
        ↓
configurar SSL (sslmode=require)
        ↓
restaurar o backup mais recente (pg_restore -Fc)
        ↓
validar: contagem de tabelas/triggers/constraints,
         verifyAuditLogChain(), smoke test funcional
        ↓
aplicar configuração/secrets (DATABASE_URL novo, mesmos outros secrets)
        ↓
subir a API (graceful startup, Fase 56)
        ↓
GET /_api/__health (confirma processo de pé)
        ↓
smoke test final via Central Visual
        ↓
frontend/API retomam tráfego
```

Testado nesta fase **até o passo "validar"** (etapas de banco e
aplicação), em ambiente controlado — nunca em produção, consistente com
a regra desta fase. O provisionamento de um Postgres novo do zero
(primeiro passo) não foi exercido (exigiria contratar/usar infraestrutura
real).

## 16. Migrations após restore

`schema_migrations` é parte do dump/restore normal (é só mais uma
tabela) — confirmado nesta fase que o banco restaurado preserva
corretamente seu conteúdo (13/13 migrations rastreadas, após a correção
da seção 1). Isso significa que `npm run db:migrate:incremental` rodado
contra um banco recém-restaurado **não tentaria reaplicar nenhuma
migration já presente no backup** — ele leria `schema_migrations` do
banco restaurado e só aplicaria o que vier depois dela, exatamente o
comportamento correto e já testado (idempotência confirmada desde a
criação de `run-migrations.ts`).

## 17. Backup não é a mesma coisa que a audit hash-chain

Dois mecanismos diferentes e complementares, não confundir:

- **Audit hash-chain** (`audit_log`, Fases 33/53): prova matematicamente
  se a *sequência histórica de eventos registrados* foi adulterada
  retroativamente. Não ajuda a recuperar um banco perdido/corrompido —
  ela PRESSUPÕE que o banco existe e está acessível.
- **Backup/restore** (esta fase): permite reconstruir o banco inteiro
  (dados + schema + a própria tabela `audit_log`, hash-chain incluída)
  após uma perda real de dados. Não prova integridade histórica sozinho
  — só devolve o estado gravado no momento do dump.

Juntos: um backup restaurado inclui a cadeia de hash intacta (confirmado
na seção 7), que por sua vez pode ser verificada depois da restauração
para confirmar que o próprio backup não foi adulterado entre o dump e o
restore — as duas camadas se reforçam, mas resolvem problemas diferentes.

## 18. Failure modes

| Modo de falha | Como detectar |
|---|---|
| Backup interrompido no meio | `pg_dump` sai com código de erro ≠ 0; arquivo final fica truncado/ausente — checagem de código de saída + tamanho do arquivo (seção 4) detecta isso. |
| Arquivo corrompido | `pg_restore --list` falha ao ler o TOC do archive (formato custom tem checagem estrutural própria) — detectável sem precisar restaurar. Checksum (seção 4) detecta corrupção em trânsito/armazenamento. |
| Restore incompleto | Comparar contagens estruturais pós-restore contra um valor de referência conhecido (seção 6) — uma tabela/trigger/constraint faltando aparece imediatamente numa comparação de contagem. |
| Banco incompatível (versão) | `pg_restore` recusa formatos de versão muito diferentes com um erro explícito na primeira tentativa — nunca falha silenciosamente faltando dados. |
| Backup antigo demais | Nomenclatura com timestamp (seção 2) — a idade fica explícita no nome do arquivo, nunca dependente de metadado de filesystem que pode ser alterado por uma cópia/sync. |
| Falha do storage do backup | Fora do escopo desta fase implementar monitoramento automatizado — requisito registrado: o provedor de storage de backup escolhido precisa ter seu próprio SLA/monitoramento, e o procedimento desta seção (restore de teste periódico) é a forma de detectar isso proativamente em vez de só na hora de um desastre real. |

## 19. Storage de uploads — nota explícita

A Fase 56 definiu disco local + volume persistente para o lançamento
single-instance. **Isto não é coberto pelo backup do banco de dados** —
são dois sistemas de armazenamento completamente diferentes (Postgres
vs. filesystem de uploads). Se os arquivos enviados pelos usuários
(comprovantes de entrega, ver `docs/UPLOAD_DE_ARQUIVOS.md`) forem
considerados dados críticos, eles **precisam de sua própria estratégia de
backup** — um snapshot do volume persistente, sincronização para um
storage separado, ou a migração para S3 (adapter já existe, Fase 55/56)
é o que resolveria isso de forma mais robusta (S3/R2/MinIO já vêm com
durabilidade/replicação do próprio provedor). **Não implementado nesta
fase** — registrado como decisão pendente, não um bloqueador (os
registros de negócio em si — need_fulfillments, stock_transactions,
audit_log — estão todos no Postgres e já cobertos pelo backup desta
fase; só o arquivo binário do comprovante em si ficaria vulnerável a uma
perda de volume).

## 20. Requisitos para o provedor (agnóstico de fornecedor)

| Requisito | Obrigatório? |
|---|---:|
| PostgreSQL 16+ | Sim |
| SSL/TLS | Sim |
| Backup automático | Sim |
| Retenção ≥ 30 dias | Sim |
| Restore testável (procedimento desta fase repetível contra o provedor real) | Sim |
| Storage de backup independente do host do banco | Sim |
| Criptografia em repouso | Sim |
| Rede privada ou equivalente | Preferível |
| Point-in-time recovery | Avaliar (não obrigatório no lançamento — seção 13) |
| Export manual sob demanda (`pg_dump` contra o banco gerenciado) | Preferível |

Este documento pode ser usado para comparar provedores concretos
(RDS, Neon, Supabase, Railway Postgres, etc.) quando essa decisão for
tomada — nenhum provedor foi escolhido nesta fase.

## 21. Checklist de recuperação (procedimento repetível)

```
[ ] 1. Criar banco vazio (ou provisionar novo Postgres, se for o caso)
[ ] 2. Restaurar o backup mais recente (pg_restore -Fc, --no-owner --no-privileges)
[ ] 3. Validar schema: contagem de tabelas/triggers/índices/constraints/sequences
[ ] 4. Validar schema_migrations (todas as migrations esperadas presentes)
[ ] 5. Validar integridade: verifyAuditLogChain() retorna integra=true
[ ] 6. Apontar a aplicação (DATABASE_URL) para o banco restaurado
[ ] 7. Smoke test: login, dashboard, uma organização, uma rota autenticada
[ ] 8. Registrar o tempo total decorrido (RTO real deste exercício)
[ ] 9. Descartar o banco de teste (nunca deixar banco de teste acessível
       permanentemente)
```

Executado nesta fase (etapas 1-8, em ambiente de desenvolvimento); etapa
9 cumprida (banco de teste descartado ao final).

**Recomendação operacional**: repetir este checklist completo pelo menos
uma vez antes do primeiro deploy de produção real (contra o provedor
escolhido), e trimestralmente depois disso — consistente com
`docs/PRODUCTION_READINESS.md`.
