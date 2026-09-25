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
