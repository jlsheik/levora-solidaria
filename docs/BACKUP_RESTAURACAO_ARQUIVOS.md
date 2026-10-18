# Backup e restauração dos arquivos enviados

> **Status: PROCEDIMENTO PROPOSTO, NÃO ENSAIADO.** Este documento descreve o que o código e a documentação atuais permitem afirmar e propõe um procedimento coordenado de backup e restauração. **Nenhuma restauração de arquivos foi ensaiada**, nenhum bucket real foi validado e nenhuma das alternativas abaixo está aprovada ou pronta para produção. Não define provedor, conta, bucket, credenciais, frequência, prazo de retenção, RPO ou RTO: esses valores dependem de decisão humana (ver seção 9).
>
> Escrito a partir do estado da `master` em `3348e27`. Cada afirmação marcada **[código]** foi conferida no código, e **[doc]** em documentação existente. **[inferência]** é dedução, e **[proposta]** é procedimento a validar.

## 1. Por que este documento existe

O backup do PostgreSQL (`docs/DATABASE_RECOVERY.md`, Fase 57) **cobre só o banco**. A seção 19 daquele documento registra que os arquivos enviados não são cobertos e que, se forem críticos, precisam de estratégia própria; isso ficou como decisão pendente. Além disso, o restore da Fase 57 foi medido com um banco de ~139 KB e não representa o volume real. **O backup do banco não é backup completo da aplicação.**

## 2. Como os objetos são armazenados

| Item | Fato |
|---|---|
| Tabela `files` | colunas `id`, `organization_id`, `uploaded_by_user_id`, `storage_provider`, `storage_key`, `original_filename`, `content_type`, `size_bytes`, `purpose`, `created_at`, mais o estado de análise antimalware (`scan_*`) **[código: `db/schema.sql`]** |
| Provedores | `local` (disco) ou `s3`; cada linha registra o provedor em que foi gravada, e a leitura usa o provedor da linha, **não** a configuração atual **[código: `storageAdapter.tsx`, `files.storage_provider`]** |
| Chave | `<organizationId>/<uuid>` nos dois provedores; chaves fora desse formato são recusadas antes de qualquer acesso **[código]** |
| Disco local | diretório `STORAGE_LOCAL_DIR` (padrão `storage/uploads`, relativo ao diretório de trabalho do processo); em produção o systemd só permite escrita em `/opt/levora-solidaria/storage` **[código: `storageAdapter.tsx`; `deploy/levora-api.service`]**. O staging usa o volume nomeado `uploads_data` **[código: `docker-compose.staging.yml`]** |
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
| Restauração parcial, ou sobrescrita de diretório | perda de objetos novos ou substituição por versão antiga; **a chave é um uuid novo a cada upload**, então sobrescrever uma chave existente não ocorre pela aplicação, mas pode ocorrer por cópia manual |

**Ordem de gravação do upload [doc: `UPLOAD_DE_ARQUIVOS.md`]:** o objeto é gravado primeiro, depois a linha é inserida (com auditoria, na mesma transação). **[inferência]** Como o app nunca remove um objeto que tenha linha (seção 2), a ordem de backup **banco primeiro, objetos depois** garante que todo registro do banco restaurado tenha seu objeto na cópia (todo objeto referenciado já existia antes do dump); o que pode sobrar na cópia são órfãos de uploads feitos entre os dois passos. A ordem inversa (objetos antes do banco) pode gerar registros sem objeto. Esta inferência precisa ser **confirmada no ensaio** (seção 7).

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

**Limites declarados:** sem varredura periódica automática; sem correção; não compara conteúdo nem tamanho; o S3 testado foi um servidor local simulado, não um bucket real.

## 5. Cenário A: disco persistente com cópia externa independente

**Implementado:** adaptador de disco; diagnóstico `storage:audit`. **Documentado:** a Fase 56 definiu disco local + volume persistente para o lançamento em instância única. **Trabalho ainda necessário:** **tudo o que é cópia de segurança dos objetos** (não há script, rotina nem destino definidos no repositório).

**Requisitos propostos [proposta]:**
- cópia para destino **independente do host da aplicação** (outro host ou outra conta), nunca no mesmo volume;
- cópia **cifrada em repouso e em trânsito**; credenciais do destino separadas das da aplicação e com permissão mínima (somente escrita/listagem para o backup; leitura apenas para a restauração);
- destino com proteção contra exclusão e sobrescrita acidentais (por exemplo, retenção de versões ou modo somente-acréscimo, **conforme o que o destino escolhido oferecer**);
- a rotina de cópia **não pode apagar no destino** objetos removidos na origem sem uma política de retenção aprovada (hoje o app não remove objetos referenciados);
- registro de cada execução (início, fim, quantidade de objetos e bytes, código de saída), sem conteúdo nem nomes de arquivo.

**Procedimento coordenado proposto [proposta, não ensaiado]:**
1. Registrar o instante de início. Gerar o dump do banco conforme `DATABASE_RECOVERY.md` (`pg_dump -Fc`) e registrar seu checksum.
2. **Depois** do dump, copiar o diretório de objetos para o destino externo, preservando a estrutura `<organizationId>/<uuid>`.
3. Registrar contagem de objetos e bytes copiados e a hora de término.
4. Guardar o relatório de `storage:audit` (disco) do momento do backup.

**Restauração coordenada proposta [proposta, não ensaiada]**, sempre num **ambiente separado**, nunca sobre a produção:
1. Restaurar o banco em um banco novo (`pg_restore` em banco separado, como em `DATABASE_RECOVERY.md`, seção 5).
2. Restaurar o diretório de objetos em um diretório novo.
3. Apontar `DATABASE_URL` e `STORAGE_LOCAL_DIR` (ou `--local-root`) para os restaurados e rodar `npm run storage:audit -- --provider local --out <relatorio>.json`.
4. Interpretar: saída 0 = consistente. **Registros sem objeto** exigem investigação (backup incompleto); **órfãos** são esperados para uploads feitos entre o dump e a cópia, e **não** devem ser apagados sem decisão de retenção.

## 6. Cenário B: armazenamento de objetos S3 privado

**Implementado:** adaptador S3 (assinatura SigV4, timeouts, chaves validadas, falhas viram erro e nunca conteúdo vazio). **Documentado:** o adaptador foi exercitado apenas contra um servidor HTTP local simulado (`test/fakeS3.ts`). **Trabalho ainda necessário:** toda a configuração e a validação contra um bucket real.

**Requisitos propostos [proposta]:**
- bucket **privado**, com bloqueio de acesso público e sem ACL pública; política restritiva;
- credencial da aplicação com permissão mínima (ler, gravar e listar **somente** nesse bucket; avaliar se a remoção é necessária, já que o app só remove o objeto de um upload que falhou);
- cifra em repouso;
- proteção contra exclusão acidental e recuperação de versões (versionamento ou recurso equivalente **do provedor escolhido**), definida junto com a política de retenção;
- estratégia de recuperação **comprovada**: a durabilidade do provedor não substitui um ensaio de restauração nem uma proteção contra exclusão por erro ou credencial comprometida;
- a decisão de migrar objetos entre `local` e `s3` precisa considerar que cada linha de `files` aponta para o provedor em que foi gravada.

**Restauração e verificação [proposta]:** restaurar o banco em ambiente separado, apontar para o bucket (ou uma versão/réplica) e rodar `npm run storage:audit -- --provider s3 --out <relatorio>.json`; o S3 é auditado só com `ListObjectsV2`, e a auditoria só é completa se todas as páginas forem lidas.

## 7. Ensaio recomendado (a executar somente com autorização)

Em ambiente descartável, com dados sanitizados e **sem tocar na produção**:
1. Fazer o backup coordenado da seção 5 (ou o equivalente da seção 6).
2. Restaurar em ambiente separado e rodar `storage:audit` (esperado: saída 0).
3. Repetir com o diretório de objetos **defasado** de propósito e confirmar que a auditoria sai com 1 e lista os registros sem objeto.
4. Repetir com o banco defasado e confirmar os órfãos.
5. Confirmar a inferência da seção 3 (ordem banco primeiro, objetos depois não gera registro sem objeto).
6. Medir tempos de backup e restauração com um volume realista.

**Evidências a guardar após cada ensaio:** data e hora; commit da aplicação; checksum do dump; contagens e bytes de objetos copiados e restaurados; relatórios JSON do `storage:audit`; códigos de saída de cada comando; tempos medidos; divergências observadas e como foram resolvidas. Nunca guardar conteúdo de arquivos, nomes originais, credenciais nem URLs com segredo.

## 8. O que este documento NÃO afirma

- Que qualquer alternativa esteja pronta para produção.
- Que exista rotina de backup de arquivos, destino de cópia, bucket, conta ou credencial.
- Que a restauração de arquivos tenha sido ensaiada.
- Qualquer valor de frequência, retenção, RPO, RTO, capacidade ou custo.

## 9. Decisões humanas pendentes

| Decisão | Responsável |
|---|---|
| Disco persistente com cópia externa **ou** S3 | infraestrutura / responsável pelo projeto |
| Destino, frequência e retenção das cópias | infraestrutura; retenção também depende da decisão jurídica (`docs/DECISAO_RETENCAO_COMPROVANTES.md`) |
| Metas de RPO e RTO para os arquivos | responsável pelo projeto |
| Quem opera, monitora e testa a restauração | responsável pelo projeto |

Enquanto essas decisões não existirem, a produção permanece bloqueada neste ponto.
