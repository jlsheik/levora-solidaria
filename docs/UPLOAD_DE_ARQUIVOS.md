# Upload real de arquivo

Antes desta funcionalidade, `proof_url` (comprovação de entrega) era só um
campo de texto — a pessoa colava o link de uma foto já hospedada em outro
lugar. Este documento descreve o upload real que substitui isso.

## Como funciona

1. `src/helpers/storageAdapter.tsx` — adaptador de armazenamento com dois
   backends reais (nunca um placeholder fingindo funcionar):
   - **Disco local** (padrão, sem configuração nenhuma necessária): grava em
     `STORAGE_LOCAL_DIR` (padrão `storage/uploads/`), um diretório **fora**
     de qualquer pasta servida como estática pelo Vite/Express — não existe
     URL pública direta para um arquivo, só o endpoint autenticado.
   - **S3-compatível** (AWS S3, Cloudflare R2, MinIO): ativa automaticamente
     quando `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` e
     `S3_SECRET_ACCESS_KEY` estão no `.env` (`S3_ENDPOINT` opcional, só para
     R2/MinIO). O SDK da AWS só é importado/instanciado quando essas
     variáveis existem.
2. `src/endpoints/files-upload_POST.ts` — recebe o arquivo como base64
   dentro do corpo JSON (mesma convenção de todos os outros endpoints do
   projeto — Web Fetch API, sem multipart), valida:
   - tipo de conteúdo (`image/jpeg`, `image/png`, `image/webp`,
     `application/pdf` — lista em `ALLOWED_CONTENT_TYPES`);
   - tamanho (até 8MB, `FILE_MAX_SIZE_BYTES`);
   - membership ativo na organização (proprietário/administrador/operador).
   
   Grava no storage, insere uma linha em `files`, registra auditoria
   (`arquivo.enviado`).
3. `src/endpoints/files-download_GET.ts` — **é o "signed URL" do sistema**:
   em vez de gerar um token de acesso separado que pode vazar e continuar
   válido por conta própria, a autorização é a própria sessão autenticada,
   checada a cada download (`requireOrganizationMembership`). Streama os
   bytes de volta com o `Content-Type` real do arquivo. Cada download
   também gera um evento de auditoria (`arquivo.baixado`).
4. `src/endpoints/allocations-receive_POST.ts` ganhou um campo opcional
   `proofFileId` — quando presente, confirma que o arquivo pertence à
   mesma organização e grava `logistics_events.proof_url` como
   `/_api/files-download?fileId=<id>` (o campo continua sendo TEXT, sem
   mudança de schema; ele só passou a poder conter uma URL interna além de
   um link externo colado manualmente — as duas formas continuam
   funcionando, coexistindo na mesma tela).
5. Interface (`organizacoes.$organizationId.atribuicoes.tsx`): o campo de
   comprovante agora é um `FileDropzone` de verdade. Envia o arquivo assim
   que selecionado (feedback imediato), e o link colado manualmente vira
   uma alternativa (desabilitada enquanto houver um arquivo enviado, para
   não mandar os dois ao mesmo tempo). Na linha do tempo de logística, o
   comprovante aparece como um link clicável ("ver comprovante") em vez de
   uma URL crua.

## Correção necessária no servidor para isto funcionar

`server/index.ts` convertia toda resposta de endpoint para texto
(`webResponse.text()`) antes de repassar ao Express — o que corromperia
qualquer corpo binário (como os bytes de uma imagem) ao decodificá-lo como
UTF-8 e resserializar como string. Trocado por `arrayBuffer()` +
`Buffer.from(...)`, que preserva texto (JSON) e binário igualmente. Também
paramos de repassar os cabeçalhos `content-length`/`transfer-encoding` do
`Response` original, deixando o Express recalculá-los a partir do buffer
que ele de fato envia.

## Injeção de cabeçalho HTTP via nome de arquivo (RESOLVIDO)

Achado numa auditoria de segurança: `fileName` era validado só por
tamanho (`z.string().min(1).max(255)`), sem restringir caracteres. O nome
gravado (`files.original_filename`) é usado literalmente no header
`Content-Disposition` do download (`files-download_GET.ts`). Um nome como
`"a\r\nSet-Cookie: adulterado=1"` injetaria cabeçalhos HTTP arbitrários na
resposta do download — só a aspa dupla era removida antes, não CR/LF.

Corrigido em duas camadas: (1) `files-upload_POST.schema.ts` agora rejeita
qualquer caractere de controle no nome do arquivo (400, nada é gravado);
(2) `files-download_GET.ts` também remove `"`/`\r`/`\n` defensivamente ao
montar o header, para que uma linha gravada antes desta validação existir
(ou por qualquer caminho futuro) nunca vire injeção. Testado em
`test/filesUpload.test.ts`.

## Conteúdo real, nomes e tipos antigos (Fase 94)

O `contentType` enviado pelo navegador é só uma declaração: o servidor confere os **primeiros bytes** (`src/helpers/fileSignature.ts`: JPEG `FF D8 FF`, PNG, WebP `RIFF…WEBP`,
PDF `%PDF-`) e recusa (400, antes de gravar) o que não bate — um SVG/HTML com script declarado como imagem não chega ao storage. O base64 é validado
estritamente. O download devolve `Content-Disposition` só em ASCII (`filename*` carrega o nome Unicode) e **nunca** serve como renderizável um tipo fora da lista
(linhas antigas viram `application/octet-stream` + `attachment`). Ver `docs/SECURITY.md` ("Upload e download") e `test/uploadSecurity.test.ts`.

## Adaptador S3: o que foi exercitado e o que não foi (Fase 94)

`test/storageS3.test.ts` roda o `S3StorageAdapter` **real**, com o SDK **real** (`@aws-sdk/client-s3`), por HTTP contra um servidor S3 local controlado pelo teste (`test/fakeS3.ts`,
127.0.0.1, porta do SO, em memória, encerrado no fim; credenciais sintéticas). Nenhum mock do SDK. Cobre: ida e volta com os 256 valores de byte e 5 MB sem truncar; chave
`<organizationId>/<uuid>` em path-style no bucket configurado; toda requisição assinada (SigV4) e o segredo nunca trafegando; `DELETE`; as rotas reais `files-upload`/`files-download`
(banco de teste, sessão, Express real) com bytes idênticos, `Content-Type` exato, `Content-Length`, `nosniff`, `no-store` e disposição só ASCII; nomes hostis/Unicode/longos nunca na
chave; autorização por sessão e organização (401/403/404/400, membro inativo, e **o S3 nem é consultado** antes da autorização); linhas antigas `text/html`/`image/svg+xml` no S3 saem como
`octet-stream` + `attachment`; falhas (objeto ausente, acesso negado, 500 com retentativas do SDK, sem resposta, corpo truncado, corpo travado) viram erro e, na rota, **500 JSON genérico** sem
bucket, endpoint, chaves, assinatura nem stack — nem no log.

**Defeitos reais encontrados e corrigidos (só no adaptador):** (1) uma chave adulterada no banco (`1/../2/<uuid>`, `//`, esquema) ia à rede e o SDK normaliza `..`, apontando para OUTRO

**Revisão independente do PR #1 — chave de outra organização (corrigido).** A guarda do S3 só conferia o *formato* da chave e a do disco só que o caminho ficava *dentro da raiz*: uma linha de `files` da organização A com `storage_key` = `<B>/<uuid>` (formato válido) ou `<A>/../<B>/<uuid>` (continua dentro da raiz do disco) servia o objeto da organização B a um membro de A (reproduzido em `test/storageKeyOrganization.test.ts` antes da correção). Agora `files-download` exige `keyBelongsToOrganization` (formato + prefixo `<organization_id>/` igual ao do registro) **antes** de tocar o armazenamento, e o adaptador de disco também exige o formato `<org>/<uuid>`. O endpoint nunca usou entrada do usuário como chave: o cenário exige escrita indevida no banco (defesa em profundidade).
objeto do bucket — o adaptador de disco tinha a guarda, o S3 não; agora `download`/`delete` exigem o formato `<org>/<uuid>` antes de qualquer chamada; (2) **sem timeout**: um S3 que não responde
(ou um corpo que trava no meio) deixava o download pendurado para sempre — o cliente agora usa `socketTimeout` (inatividade) de 30 s, configurável por `S3_REQUEST_TIMEOUT_MS` (o `requestTimeout`
do SDK só emite aviso, por isso não é usado).

**Limites, sem apresentar como coberto:** o servidor local **não valida a assinatura SigV4** nem implementa versionamento, ACL ou URLs pré-assinadas (o app não as usa: o download sempre passa pelo
servidor); **não prova compatibilidade com um bucket real** (AWS, R2, MinIO) — isso exige credenciais e infraestrutura fora do repositório; o download é carregado inteiro em memória (limite de 8 MB
no upload) e **não** é transmitido em streaming ao cliente; objeto ausente no S3 responde 500 (inconsistência do servidor), não 404. (A coluna `files.storageProvider` e a compensação do INSERT, antes lacunas, estão tratadas na seção seguinte.)

## Consistência: falha do INSERT, falha da limpeza e `files.storageProvider` (Fase 94)

**Fluxo do upload:** validações (sessão, permissão, base64 estrito, tamanho, bytes × tipo) → grava o objeto no provedor ATUAL → INSERT em `files` + linha de auditoria na MESMA transação → resposta.
Nada é gravado antes de a validação passar (testado: bytes ≠ tipo, base64 inválido, tipo proibido, sem sessão, outra organização e falha do próprio provedor não deixam objeto nem linha; o provedor nem é chamado).

**Compensação.** Se o INSERT ou a auditoria falhar (a transação inteira é desfeita), o upload remove **somente o objeto criado por aquela tentativa** (`stored.storageKey`, um uuid gerado naquele instante; não há como colidir com
objeto preexistente, de outra organização ou referenciado por outro registro) e devolve o erro genérico de sempre (500, "Não foi possível enviar o arquivo", sem detalhes do banco nem do armazenamento).
Testado nos dois provedores (`test/uploadConsistency.test.ts`) com falhas REAIS do Postgres (gatilhos criados só no teste): o objeto some do disco/bucket, nenhuma linha fica, objetos de outra organização e o objeto de outro registro
continuam intactos e acessíveis pelo download.

**Se a própria remoção falhar** (armazenamento indisponível): o `delete` dos adaptadores agora **lança** em falha real (antes engolia tudo; chave já inexistente continua sendo sucesso). O upload não esconde: grava no log do servidor uma linha
`ARQUIVO_ORFAO provider=<local|s3> key=<org>/<uuid> organizationId=<id>: …` (sem credenciais) e mesmo assim devolve o erro original do banco. **Garantia que NÃO existe:** limpeza automática com o armazenamento fora do ar — o objeto fica órfão (nenhuma
linha em `files` o referencia, então nenhuma tela o mostra) até alguém removê-lo. **Diagnóstico/recuperação:** procurar `ARQUIVO_ORFAO` nos logs; a chave registrada identifica o objeto; remover pelo console do provedor (S3: o objeto `<bucket>/<key>`; disco:
`STORAGE_LOCAL_DIR/<key>`) depois de conferir que nenhuma linha de `files` usa essa `storage_key`. Para encontrar os órfãos use o diagnóstico somente-leitura da seção seguinte. Continua **não havendo** varredura periódica nem exclusão/limpeza automática de órfãos (decisão pendente se for desejada).

**`files.storageProvider`.** Evidência: coluna `TEXT NOT NULL` sem default nem CHECK, criada na migração `0002_files.sql` junto com o adaptador, **gravada em cada upload com o provedor que de fato guardou o arquivo** (`stored.storageProvider`): é o provedor POR ARQUIVO, não uma
configuração global. Antes, a rota de download ignorava a coluna e lia sempre pelo provedor configurado agora (arquivos do outro provedor viravam erro 500 ao trocar a configuração). Agora `files-download` usa `adapterForProvider(file.storageProvider)`, **depois** da autorização:
`local` → disco; `s3` → S3 (exige as quatro variáveis `S3_*`); qualquer outro valor, ou `s3` sem configuração, lança `StorageProviderError` → 500 genérico, **sem fallback** e sem tocar em armazenamento. A chave de um provedor nunca é lida no outro (os formatos de chave continuam validados
por adaptador). Não houve migração (o modelo já suportava); não existe rota de exclusão de arquivo. Testado: arquivo local servido do disco com o S3 configurado (e o inverso), sem consultar o provedor errado, valores inválidos (`gcs`, `LOCAL`, vazio, ` s3`, `s3;local`, `../local`), autorização antes da escolha do provedor.
**Limites:** mudar o provedor padrão só afeta NOVOS uploads; migrar arquivos entre provedores continua manual; um CHECK no banco para a coluna não foi criado (a validação é no código).

## Diagnóstico de integridade do armazenamento (`npm run storage:audit`)

Compara o que existe de fato nos provedores com as linhas de `files` e produz um relatório para **investigação e recuperação manual**. **Somente leitura**: não existe opção de reparo, exclusão ou correção, e o comando nunca remove, grava ou altera arquivos, objetos ou registros.

```bash
npm run storage:audit                          # disco + S3 (se configurado); resumo no terminal
npm run storage:audit -- --provider local      # local | s3 | all (padrão: all)
npm run storage:audit -- --out relatorio.json  # relatório completo (chaves exatas dos órfãos)
node dist-server/db/storage-audit.js ...       # em produção, depois de npm run build:server
```

**Categorias (que não se misturam):** **órfão** = objeto no provedor sem NENHUM registro em `files` (provedor + chave exata); **registro sem objeto** = registro válido cujo objeto não está no provedor gravado em `files.storageProvider` (o provedor vale POR REGISTRO,
não a configuração atual); **metadado inconsistente** = registro que não dá para comparar com segurança (`provedor-desconhecido`, `chave-fora-do-formato`, `prefixo-diferente-da-organizacao`, `chave-duplicada`); **não verificado** = banco, diretório, listagem ou provedor sem configuração que
não puderam ser lidos por completo — vira auditoria **incompleta** e nada daquele provedor é classificado (falha de conexão NÃO significa "objeto ausente"). Há ainda a lista informativa de **objetos não reconhecidos** (formato que o app nunca cria, p.ex. `.keep`, subpastas, links simbólicos): não
entram na comparação de órfãos nem alteram o resultado.

**Resultado e códigos de saída:** `0` completo sem inconsistências · `1` completo com inconsistências · `2` **incompleto** (qualquer parte não verificada: banco, raiz do disco inexistente com registros locais, listagem S3 que falhou, deu timeout ou veio truncada, S3 não configurado quando solicitado) · `3` uso ou
configuração inválida (opção desconhecida, `--provider` inválido, sem `DATABASE_URL`). O relatório JSON traz data/hora, registros consultados, objetos enumerados por provedor, totais por categoria, as listas (chaves exatas dos órfãos; `fileId` e `organizationId` dos registros) e as partes não verificadas.
Nunca inclui conteúdo de arquivo, nome original, bucket, endpoint, região, credenciais nem URLs.

**Garantias de leitura (verificadas por `test/storageIntegrity.test.ts`):** o banco é lido numa transação `READ ONLY` (o Postgres recusaria qualquer escrita), só as colunas `id`, `organization_id`, `storage_provider` e `storage_key`; o disco usa só `readdir`/`lstat` na raiz administrada (`STORAGE_LOCAL_DIR`), **sem seguir links
simbólicos** e sem abrir nada fora dela; o S3 usa só `ListObjectsV2` (todas as páginas; token ausente ou repetido = erro). Instantâneos antes/depois do disco (inclusive fora da raiz), da tabela `files` e dos objetos do S3 local ficam idênticos; só há requisições GET no S3; o código-fonte não contém nenhuma operação de escrita ou remoção.

**Procedimento manual sugerido para um órfão:** (1) confirme o provedor e a chave exata no relatório; (2) procure a chave em `files.storage_key` (e nos logs `ARQUIVO_ORFAO`) e verifique a data do objeto — um upload em andamento pode aparecer por instantes antes do INSERT; (3) repita o diagnóstico e só então decida; (4) a remoção é manual, pelo console do provedor ou do sistema de arquivos,
**sempre depois** de conferir que nenhuma linha usa a chave. Para um **registro sem objeto**: investigue backup/restauração e o provedor correto antes de qualquer ação sobre o registro; o app não tem rota de exclusão de arquivos.

**Limites:** sem varredura periódica, sem correção automática, sem comparação de conteúdo ou tamanho; o S3 testado é o servidor local (não valida assinaturas e não é um bucket real); em bucket compartilhado com outros sistemas os objetos de formato diferente aparecem só como "não reconhecidos"; a auditoria é um retrato de um instante (uploads concorrentes podem gerar falsos positivos transitórios).

## Resíduos nos testes (`storage/uploads-test`)

Origem: `test/allocationsReceiveProof.test.ts` enviava arquivos reais pelo `files-upload` e **não removia** o que criava (2 arquivos por execução), numa raiz fixa do repositório que também podia ser compartilhada por duas execuções simultâneas. Correção: cada execução da suíte usa um diretório **exclusivo** em `os.tmpdir()`
(`levora-test-storage-*`, criado no `globalSetup` e exportado em `STORAGE_LOCAL_DIR` antes dos workers), removido no fim mesmo se a suíte falhar, e o teste que vazava agora remove exatamente os objetos que criou (a falha de limpeza aparece, não é engolida). O `globalSetup` avisa se algum arquivo sobrar no diretório temporário. `test/storageIsolation.test.ts`
prova: raiz fora do repositório, upload real sem tocar `storage/uploads-test`, diretórios distintos por execução e recusa de apagar qualquer diretório que não tenha sido criado pelo helper. Limite: um processo morto à força pode deixar um `levora-test-storage-*` no diretório temporário do sistema (fora do repositório).

## Configuração (opcional)

Sem nenhuma variável de storage configurada, tudo funciona via disco local
— não há "modo não configurado" aqui como no e-mail, porque disco local é
uma implementação real e completa, não um placeholder. Ver `.env.example`
para as variáveis de S3 quando um bucket externo for necessário (ex.:
múltiplas instâncias do servidor sem disco compartilhado).

## O que ainda não existe (fora do escopo desta entrega)

- Miniaturas/preview de imagem antes do upload terminar.
- Limite de quantos arquivos uma organização pode armazenar no total
  (sem abuso conhecido a mitigar ainda).
- Exclusão de arquivo pelo usuário (hoje só existe upload/download; um
  arquivo órfão de uma atribuição cancelada continua no storage — não é
  um vazamento de dado sensível porque continua exigindo autenticação
  para baixar, mas ocupa espaço).
- `file_access_logs` como tabela dedicada (seção 84 do master prompt) —
  hoje o acesso é registrado via `audit_log` genérico (`arquivo.enviado`,
  `arquivo.baixado`), que já cobre "quem e quando", mas sem os campos
  extras (IP, user agent) que uma tabela dedicada teria.
