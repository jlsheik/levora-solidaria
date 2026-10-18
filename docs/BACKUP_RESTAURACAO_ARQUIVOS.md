# Backup e restauração dos arquivos enviados

> **Status: PROCEDIMENTO PROPOSTO, NÃO ENSAIADO.** Este documento descreve o que o código e a documentação atuais permitem afirmar e propõe um procedimento coordenado de backup e **verificação de restauração**. **Nenhuma restauração de arquivos foi ensaiada**, nenhum bucket real foi validado e nenhuma das alternativas abaixo está aprovada ou pronta para produção. Não define provedor, conta, bucket, credenciais, frequência, prazo de retenção, RPO ou RTO: esses valores dependem de decisão humana (ver seção 11).
>
> **Escopo:** este documento **prepara e verifica** um procedimento de restauração. **Ele ainda não é um runbook completo de recuperação de desastre** (ver seção 8).
>
> Escrito a partir do estado da `master` em `3348e27`. **[código]** = conferido no código; **[doc]** = documentação existente; **[inferência]** = dedução; **[proposta]** = procedimento a validar; **[adicional]** = verificação que a ferramenta atual **não** faz e que precisa ser executada ou implementada no ensaio.

## 1. Por que este documento existe

O backup do PostgreSQL (`docs/DATABASE_RECOVERY.md`, Fase 57) **cobre só o banco**. A seção 19 daquele documento registra que os arquivos enviados não são cobertos e que, se forem críticos, precisam de estratégia própria; isso ficou como decisão pendente. Além disso, o restore da Fase 57 foi medido com um banco de ~139 KB e não representa o volume real. **O backup do banco não é backup completo da aplicação.**

## 2. Como os objetos são armazenados

| Item | Fato |
|---|---|
| Tabela `files` | colunas `id`, `organization_id`, `uploaded_by_user_id`, `storage_provider`, `storage_key`, `original_filename`, `content_type`, `size_bytes`, `purpose`, `created_at`, mais o estado de análise antimalware (`scan_*`) **[código: `db/schema.sql`]** |
| Provedores | `local` (disco) ou `s3`; cada linha registra o provedor em que foi gravada, e a leitura usa o provedor da linha, **não** a configuração atual **[código: `storageAdapter.tsx`, `files.storage_provider`]** |
| Chave | `<organizationId>/<uuid>` nos dois provedores; chaves fora desse formato são recusadas antes de qualquer acesso **[código]** |
| Disco local | diretório `STORAGE_LOCAL_DIR` (padrão `storage/uploads`, relativo ao diretório de trabalho do processo); em produção o systemd só permite escrita em `/opt/levora-solidaria/storage` **[código: `storageAdapter.tsx`; `deploy/levora-api.service`]**. O staging usa o volume nomeado `uploads_data` **[código: `docker-compose.staging.yml`]**. A gravação local usa `writeFile` direto, **não atômico** **[código]** |
| S3 | ativado quando `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` e `S3_SECRET_ACCESS_KEY` existem; `S3_ENDPOINT` só para R2/MinIO; **nunca foi testado contra um bucket real** **[código; doc: `UPLOAD_DE_ARQUIVOS.md`]**. O adaptador não define ACL: a privacidade depende da configuração do bucket **[não verificado]** |
| Vínculo com registros | `stock_destinations.proof_file_id` tem FK composta com `ON DELETE RESTRICT`. `logistics_events.proof_url` é `TEXT` **sem** chave estrangeira: o vínculo é só o `fileId` dentro de `/_api/v1/files-download?fileId=<id>` **[código: `db/schema.sql`]** |
| Remoção | o app **não** oferece rota de remoção de arquivo. A única chamada de `delete` no código remove o objeto criado por uma tentativa de upload cujo INSERT falhou **[código: `files-upload_POST.ts`]** |
| Exclusão de organização | `files.organization_id` é `ON DELETE CASCADE`: apagar uma organização apagaria as linhas, **não os objetos**, que ficariam órfãos **[código: `db/schema.sql`]**. Não identifiquei rota de exclusão de organização no código |

## 3. Banco e arquivos: dois sistemas, dois backups

PostgreSQL e armazenamento de objetos são sistemas independentes. Um backup do banco restaura as linhas de `files`, mas **não** os objetos que elas referenciam. Restaurar apenas um dos dois produz inconsistência:

| Situação após restaurar | Consequência |
|---|---|
| Banco restaurado, objetos ausentes ou de outro momento | **registro sem objeto**: o download falha (o app responde erro, não conteúdo); a análise antimalware também falha ao ler o objeto e marca o arquivo como indisponível |
| Objetos restaurados, banco de outro momento | **objeto órfão** (sem linha em `files`): sem exposição pela aplicação, mas ocupa espaço e entra na decisão de retenção |
| Banco de um momento e objetos de outro | os dois efeitos acima, em arquivos diferentes |
| Restauração parcial, ou sobrescrita de diretório | perda de objetos novos ou substituição por versão antiga; a chave é um uuid novo a cada upload, então a aplicação não sobrescreve uma chave existente, mas uma cópia manual pode |

### 3.1 A ordem "banco primeiro, objetos depois" é uma hipótese com pré-condições

**Ordem de gravação do upload [doc: `UPLOAD_DE_ARQUIVOS.md`]:** o objeto é gravado primeiro, depois a linha é inserida (com auditoria, na mesma transação).

**[inferência]** Se o app nunca remove um objeto que tenha linha (seção 2) e se as pré-condições abaixo valerem, então fazer o dump do banco **primeiro** e copiar os objetos **depois** garante que todo registro do dump tenha seu objeto na cópia (todo objeto referenciado já existia antes do dump); o que pode sobrar na cópia são objetos de uploads feitos entre os dois passos. A ordem inversa pode gerar registros sem objeto.

**Isto não é uma regra universal.** Pré-condições e limitações que precisam valer ou ser tratadas:
- **Coerência temporal:** só vale se o dump for **consistente em um único instante** (instantâneo do `pg_dump`) e a cópia de objetos começar **depois** do fim desse dump. Um dump consistente e uma cópia de objetos feita em outro momento não se tornam coerentes por si.
- **Ferramenta de cópia:** não pode omitir arquivos (por exemplo, por filtros de data ou cópias incrementais mal configuradas) **nem propagar exclusões** para o destino. A rotina de cópia não deve apagar nada no destino sem política de retenção aprovada.
- **Objetos parciais:** a gravação local não é atômica; um objeto copiado enquanto ainda era gravado pode ficar truncado. Para registros que já estão no dump isso não ocorre (o objeto estava completo antes do `INSERT`), mas um objeto de upload posterior ao dump pode ser copiado parcialmente e virar órfão incompleto.
- **Regras de ciclo de vida:** regras do bucket (ou do destino de cópia) que expiram ou movem objetos podem eliminar objetos referenciados; devem ser **desativadas ou revistas** antes de depender desta hipótese.
- **Reconciliação obrigatória:** a hipótese não dispensa reconciliar **órfãos** e **registros sem objeto** (seção 4), e confirmar tamanhos e conteúdo (seção 6.3).
- **Confirmação por ensaio:** a hipótese **precisa ser confirmada no ensaio** (seção 9).

## 4. Verificação disponível: `npm run storage:audit`

**[código: `db/storage-audit.ts`, `storageIntegrity.ts`]** Diagnóstico **somente leitura** (o banco é lido em transação `READ ONLY`; não há opção de reparo ou exclusão).

```bash
npm run storage:audit                            # disco + S3 (se configurado)
npm run storage:audit -- --provider local        # local | s3 | all
npm run storage:audit -- --local-root <dir>      # raiz do disco a auditar
npm run storage:audit -- --out relatorio.json    # relatório completo em JSON
node dist-server/db/storage-audit.js ...         # em produção, após npm run build:server
```

| Categoria | Significado |
|---|---|
| órfão | objeto no provedor sem nenhuma linha em `files` |
| registro sem objeto | linha válida cujo objeto não está no provedor gravado |
| metadado inconsistente | `provedor-desconhecido`, `chave-fora-do-formato`, `prefixo-diferente-da-organizacao`, `chave-duplicada` |

Códigos de saída: **0** completo e sem inconsistências · **1** completo com inconsistências · **2** incompleto (alguma parte não pôde ser verificada: banco, diretório, listagem do provedor; falha de conexão **não** significa objeto ausente) · **3** uso ou configuração inválidos. O relatório JSON não contém conteúdo, nome original, bucket, endpoint, credenciais nem URLs.

### 4.1 O que a ferramenta verifica e o que NÃO verifica

| Verificação | Faz a ferramenta atual? |
|---|---|
| Presença do objeto para cada registro (registro sem objeto) | **Sim** |
| Objetos sem registro (órfãos) | **Sim** |
| Formato e prefixo das chaves, duplicidade | **Sim** |
| Tamanho do objeto igual a `files.size_bytes` | **Não** [adicional] |
| Integridade do conteúdo (checksum) | **Não** [adicional] |
| Tipo real do arquivo × `content_type` registrado | **Não** [adicional] |
| Permissões, privacidade do diretório ou do bucket | **Não** [adicional] |

**Uma saída 0 do `storage:audit` é necessária, mas NÃO suficiente, para aprovar uma restauração.** Um objeto restaurado truncado ou corrompido, com o mesmo nome, passa nessa auditoria. A ferramenta não calcula tamanhos nem checksums e **este documento não altera o `storage:audit`**; as verificações marcadas **[adicional]** têm de ser executadas à parte no ensaio (seção 6.3).

**Limites declarados:** sem varredura periódica automática; sem correção; o S3 testado foi um servidor local simulado, não um bucket real.

## 5. Antes de planejar ou executar um backup: inventário e isolamento

### 5.1 Inventário dos provedores presentes

Cada linha de `files` aponta para o provedor em que foi gravada; o ambiente pode ter, ao mesmo tempo, objetos em `local` e em `s3` (por exemplo, após uma troca de configuração). **A estratégia de backup tem de cobrir todos os provedores efetivamente presentes**, sem presumir que tudo está no disco local ou que tudo está no S3.

```sql
-- somente leitura; identidade do banco verificada conforme a seção 5.2
SELECT storage_provider, count(*), sum(size_bytes) AS bytes_registrados FROM files GROUP BY storage_provider ORDER BY 1;
```
Valores de `storage_provider` diferentes de `local` e `s3` são **metadado inconsistente** e devem ser investigados antes do backup. Use a mesma consulta (parte de `docs/CHECKLIST_MIGRATIONS_0023_0025.md`, seção 4.1) para registrar o inventário. Se houver objetos nos dois provedores, **os dois cenários (seções 6 e 7) se aplicam**, cada um ao seu conjunto de objetos.

### 5.2 Isolamento do ambiente (obrigatório antes de qualquer comando que se conecte ao banco ou ao armazenamento)

As ferramentas do projeto (`db/storage-audit.ts`, `db/preflight.ts`, `db/run-migrations.ts`) importam `dotenv/config` (carrega um `.env` do diretório de trabalho) e **não têm trava contra operar num banco que não seja descartável** **[código]**. Uma execução num checkout com `.env` de produção pode alcançar o banco ou o bucket **reais** (no caso do `storage:audit`, só leitura, mas ainda produção). Siga **integralmente** a seção 2.1 de `docs/CHECKLIST_MIGRATIONS_0023_0025.md` (checkout sem `.env`, conexão definida explicitamente, `FLOOT_DATABASE_URL` e variáveis `PG*` neutralizadas, verificação de `current_database()`, `inet_server_addr()` e `inet_server_port()` comparada com um alvo previamente registrado, interrupção em caso de divergência). Essa verificação **prova só que a conexão aponta para o alvo registrado**, não que o alvo registrado seja descartável.

Para o `storage:audit` num ensaio local, além disso:
- selecione explicitamente o provedor e a raiz de teste, e neutralize as variáveis do S3:

  POSIX: `unset S3_BUCKET S3_REGION S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_ENDPOINT` e `npm run storage:audit -- --provider local --local-root "<raiz_de_ensaio>" --out "<relatorio>.json"`
  PowerShell: `Remove-Item Env:S3_BUCKET, Env:S3_REGION, Env:S3_ACCESS_KEY_ID, Env:S3_SECRET_ACCESS_KEY, Env:S3_ENDPOINT -ErrorAction SilentlyContinue` e `npm run storage:audit -- --provider local --local-root "<raiz_de_ensaio>" --out "<relatorio>.json"`
- a raiz usada deve ser o diretório **de teste**, nunca o armazenamento real dos usuários;
- só audite um bucket (`--provider s3`) num ensaio **do cenário B**, com credenciais e bucket **de teste** exportados explicitamente nesse terminal, nunca os de produção.

## 6. Cenário A: disco persistente com cópia externa independente

**Implementado:** adaptador de disco; diagnóstico `storage:audit`. **Documentado:** a Fase 56 definiu disco local + volume persistente para o lançamento em instância única. **Trabalho ainda necessário:** **tudo o que é cópia de segurança dos objetos** (não há script, rotina nem destino definidos no repositório).

### 6.1 Requisitos propostos [proposta]
- cópia para destino **independente do host da aplicação** (outro host ou outra conta), nunca no mesmo volume;
- cópia **cifrada em repouso e em trânsito**; credenciais do destino separadas das da aplicação e com permissão mínima (somente escrita/listagem para o backup; leitura apenas para a restauração);
- destino com proteção contra exclusão e sobrescrita acidentais (por exemplo, retenção de versões ou modo somente-acréscimo, **conforme o que o destino escolhido oferecer**);
- a rotina de cópia **não pode apagar no destino** objetos removidos na origem sem uma política de retenção aprovada (hoje o app não remove objetos referenciados);
- permissões restritivas no diretório de objetos e no destino da cópia (apenas a conta do serviço e a conta de backup);
- o diretório de objetos e o da cópia **não podem ser servidos publicamente** (fora de qualquer raiz estática do nginx);
- registro de cada execução (início, fim, quantidade de objetos e bytes, código de saída), sem conteúdo nem nomes de arquivo.

### 6.2 Procedimento coordenado de backup [proposta, não ensaiado]
1. Verificar o isolamento (seção 5.2) e registrar o inventário de provedores (seção 5.1).
2. Registrar o instante de início. Gerar o dump do banco conforme `DATABASE_RECOVERY.md` (`pg_dump -Fc`) e registrar seu checksum.
3. **Depois do fim do dump**, copiar o diretório de objetos para o destino externo, preservando a estrutura `<organizationId>/<uuid>` (pré-condições da seção 3.1).
4. **[adicional]** Gerar o **manifesto de checksums** dos objetos copiados e guardá-lo **separado do meio de backup** (conforme o raciocínio de `DATABASE_RECOVERY.md`, seção 4, de não manter o checksum ao lado do backup que ele protege):
   ```bash
   (cd "<raiz_dos_objetos>" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) > manifesto_objetos.sha256
   ```
   No PowerShell, `Get-ChildItem -Recurse -File | Get-FileHash -Algorithm SHA256` produz os mesmos dados em outro formato.
5. Registrar contagem de objetos e bytes copiados e a hora de término, e guardar o relatório de `storage:audit` do momento do backup.

### 6.3 Critério de aceitação da restauração [proposta]

A restauração é feita **num ambiente separado**, com banco e diretório **novos**, nunca sobre a produção, e com o isolamento da seção 5.2. **Só é considerada bem-sucedida se TODAS as verificações abaixo passarem:**

1. **Presença:** todos os objetos esperados estão presentes (nenhum **registro sem objeto**).
2. **Órfãos e metadados:** `storage:audit` com saída **0**, ou todas as inconsistências explicadas e registradas. Órfãos de uploads feitos entre o dump e a cópia são esperados (seção 3.1) e **não devem ser apagados** sem decisão de retenção.
3. **Tamanho [adicional]:** o tamanho de **cada** objeto restaurado é igual a `files.size_bytes`:
   ```bash
   psql "$DATABASE_URL" -X -A -t -F ' ' -c "SELECT storage_key, size_bytes FROM files WHERE storage_provider = 'local'" | LC_ALL=C sort > esperado_local.txt
   (cd "<raiz_restaurada>" && find . -type f -printf '%P %s\n' | LC_ALL=C sort) > encontrado_local.txt
   diff esperado_local.txt encontrado_local.txt
   ```
   (`find -printf` é do GNU find, presente no Git Bash do Windows e em Linux.) Uma chave presente nos dois arquivos com tamanhos diferentes é um objeto truncado ou substituído; uma chave só em `esperado` é registro sem objeto; só em `encontrado`, órfão. No PowerShell, `Get-ChildItem -Recurse -File` fornece `FullName` e `Length`.
4. **Checksum [adicional], quando tecnicamente viável:** `(cd "<raiz_restaurada>" && sha256sum --quiet -c "<manifesto_objetos.sha256>")` sem nenhuma falha (a opção `--quiet` imprime só as falhas; arquivo ausente também falha).
5. **Amostra lida no ambiente isolado [adicional]:** ler uma amostra de objetos (por organização e finalidade) e conferir que o tipo detectado (por exemplo, com `file --mime-type`) corresponde ao `content_type` registrado. O download pela aplicação restaurada exige subir a aplicação contra o banco restaurado, o que **requer autorização específica**.
6. **Preservar** os resultados, contagens, tempos e erros do ensaio (seção 9). Qualquer erro não explicado **reprova** o ensaio.

## 7. Cenário B: armazenamento de objetos S3 privado

**Implementado:** adaptador S3 (assinatura SigV4, timeouts, chaves validadas, falhas viram erro e nunca conteúdo vazio). **Documentado:** o adaptador foi exercitado apenas contra um servidor HTTP local simulado (`test/fakeS3.ts`). **Trabalho ainda necessário:** toda a configuração e a validação contra um bucket real.

### 7.1 Requisitos propostos [proposta]
- bucket **privado**, com bloqueio de acesso público e sem ACL pública; política restritiva;
- credencial da aplicação com permissão mínima (ler, gravar e listar **somente** nesse bucket; avaliar se a remoção é necessária, já que o app só remove o objeto de um upload que falhou);
- cifra em repouso;
- proteção contra exclusão acidental e recuperação de versões (versionamento ou recurso equivalente **do provedor escolhido**), definida junto com a política de retenção;
- **regras de ciclo de vida** que não expirem nem movam objetos referenciados sem decisão de retenção (seção 3.1);
- estratégia de recuperação **comprovada**: a durabilidade do provedor não substitui um ensaio de restauração nem uma proteção contra exclusão por erro ou credencial comprometida;
- a decisão de migrar objetos entre `local` e `s3` precisa considerar que cada linha de `files` aponta para o provedor em que foi gravada (seção 5.1).

### 7.2 Restauração e verificação [proposta]
Restaurar o banco em ambiente separado, apontar para o bucket (ou uma versão/réplica) **de teste** e rodar `npm run storage:audit -- --provider s3 --out <relatorio>.json` com o isolamento da seção 5.2. O S3 é auditado só com `ListObjectsV2` em todas as páginas; a auditoria só é completa se todas forem lidas. A listagem do S3 informa tamanhos, mas **a ferramenta atual não os compara** com `files.size_bytes`: a verificação de tamanho e de checksum do cenário B é **[adicional]** e precisa ser definida no ensaio.

## 8. O que ainda falta para um runbook completo de recuperação de desastre

Este documento **não** contém uma sequência operacional validada de recuperação. Antes de poder chamá-lo de runbook, é preciso **definir e ensaiar**:
- **interrupção controlada das escritas** e tratamento da aplicação durante a recuperação (modo de manutenção, drenagem de uploads em andamento, ordem de parada e de religamento);
- **proteção contra sobrescrita de objetos válidos** no armazenamento ativo (restaurar sempre em área nova e conciliar antes de qualquer troca);
- **permissões corretas** do armazenamento e do destino da cópia, e do usuário que executa a restauração;
- garantia de que **diretórios restaurados não são servidos publicamente**;
- **tratamento e controle de acesso aos dados pessoais presentes nas cópias** (o banco restaurado contém usuários, e-mails, hashes de senha e sessões; ensaios devem usar dados sanitizados e o ambiente restaurado deve ser isolado);
- critérios de decisão de quando promover a restauração para produção, e de reversão.

Nenhum desses itens foi ensaiado. **Não invento sequência operacional validada.**

## 9. Ensaio recomendado (a executar somente com autorização)

Em ambiente descartável, com dados sanitizados e **sem tocar na produção**, com o isolamento da seção 5.2 repetido antes de cada comando:
1. Registrar o inventário de provedores (seção 5.1) e fazer o backup coordenado da seção 6.2 (ou o equivalente da seção 7).
2. Restaurar em ambiente separado e aplicar **todo** o critério da seção 6.3 (não apenas o `storage:audit`).
3. Repetir com o diretório de objetos **defasado** de propósito e confirmar que a auditoria sai com 1 e lista os registros sem objeto, e que a verificação de tamanho e de checksum aponta objetos truncados criados de propósito.
4. Repetir com o banco defasado e confirmar os órfãos.
5. Confirmar (ou refutar) a hipótese da seção 3.1, incluindo o efeito de uploads feitos durante a cópia.
6. Medir tempos de backup e restauração com um volume realista.

**Evidências a guardar após cada ensaio:** data e hora; commit da aplicação; alvo esperado e saída da verificação de identidade do banco (sem credenciais); checksum do dump; inventário de provedores; contagens e bytes de objetos copiados e restaurados; manifesto de checksums e seu resultado de conferência; resultado da comparação de tamanhos; relatórios JSON do `storage:audit`; códigos de saída de cada comando; tempos medidos; divergências observadas e como foram resolvidas. Revisar os registros antes de arquivar. Nunca guardar conteúdo de arquivos, nomes originais, credenciais nem URLs com segredo.

## 10. O que este documento NÃO afirma

- Que qualquer alternativa esteja pronta para produção.
- Que exista rotina de backup de arquivos, destino de cópia, bucket, conta ou credencial.
- Que a restauração de arquivos tenha sido ensaiada.
- Que o `storage:audit` valide tamanho ou conteúdo (ele não valida).
- Que seja um runbook completo de recuperação de desastre.
- Qualquer valor de frequência, retenção, RPO, RTO, capacidade ou custo.

## 11. Decisões humanas pendentes

| Decisão | Responsável |
|---|---|
| Disco persistente com cópia externa **ou** S3 (ou os dois, conforme o inventário de provedores) | infraestrutura / responsável pelo projeto |
| Destino, frequência e retenção das cópias | infraestrutura; retenção também depende da decisão jurídica (`docs/DECISAO_RETENCAO_COMPROVANTES.md`) |
| Metas de RPO e RTO para os arquivos | responsável pelo projeto |
| Quem opera, monitora e testa a restauração | responsável pelo projeto |
| Autorização do ambiente descartável e do alvo esperado para os ensaios | responsável pelo projeto |

Enquanto essas decisões não existirem, a produção permanece bloqueada neste ponto.
