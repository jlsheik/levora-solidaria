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
objeto do bucket — o adaptador de disco tinha a guarda, o S3 não; agora `download`/`delete` exigem o formato `<org>/<uuid>` antes de qualquer chamada; (2) **sem timeout**: um S3 que não responde
(ou um corpo que trava no meio) deixava o download pendurado para sempre — o cliente agora usa `socketTimeout` (inatividade) de 30 s, configurável por `S3_REQUEST_TIMEOUT_MS` (o `requestTimeout`
do SDK só emite aviso, por isso não é usado).

**Limites, sem apresentar como coberto:** o servidor local **não valida a assinatura SigV4** nem implementa versionamento, ACL ou URLs pré-assinadas (o app não as usa: o download sempre passa pelo
servidor); **não prova compatibilidade com um bucket real** (AWS, R2, MinIO) — isso exige credenciais e infraestrutura fora do repositório; o download é carregado inteiro em memória (limite de 8 MB
no upload) e **não** é transmitido em streaming ao cliente; a rota ignora a coluna `files.storageProvider` (se o armazenamento configurado mudar, arquivos antigos do outro provedor viram erro 500
genérico, sem migração); a limpeza do blob quando o INSERT no banco falha (`delete` no `catch` do upload) não tem teste dedicado para S3; objeto ausente no S3 responde 500 (inconsistência do
servidor), não 404.

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
