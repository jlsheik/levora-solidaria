# Versionamento de API

Master prompt, seção 86: "API versionada `/api/v1/...`". Antes desta
mudança, todos os 46 endpoints eram montados direto em `/_api/<rota>`, sem
nenhum segmento de versão — qualquer mudança incompatível em um contrato de
endpoint quebraria todo cliente existente sem aviso.

## Decisão: `/_api/v1/`, não `/api/v1/`

O prefixo de transporte desta API sempre foi `/_api` — convenção herdada do
Floot, mantida na migração porque é só o que o proxy do Vite
(`vite.config.ts`) encaminha para o servidor Express; não tem relação com
o cliente sendo servido nem com o contrato da API. Trocar `_api` por `api`
seria um rename cosmético sem valor funcional, que exigiria mexer no
`vite.config.ts` e não teria nada a ver com o que "versionar a API"
realmente significa. "v1" é a versão do **contrato**, adicionada como
segmento de rota logo depois do prefixo de transporte: `/_api/v1/<rota>`.

## O que mudou

- `server/index.ts`: `API_VERSION_PREFIX = "/_api/v1"`, usado para montar
  todas as rotas descobertas. `/_api/__health` fica **fora** do
  versionamento de propósito — é usado por infraestrutura de monitoramento
  (load balancer, orquestrador), que não deveria precisar acompanhar a
  versão do contrato só para saber se o processo está de pé.
- Todos os 46 arquivos `*_GET.schema.ts`/`*_POST.schema.ts` (as funções
  `postX`/`getX` que o cliente React chama) atualizados de
  `` `/_api/<rota>` `` para `` `/_api/v1/<rota>` ``.
- As duas URLs internas construídas no servidor e guardadas no banco
  (`logistics_events.proof_url` em `allocations-receive_POST.ts`, e
  `downloadUrl` na resposta de `files-upload_POST.ts`) também passaram a
  usar `/_api/v1/files-download`.
- Cutover limpo, sem alias de compatibilidade: como só este próprio
  frontend consome a API hoje (nenhum parceiro externo, nenhum app
  mobile separado), não havia cliente terceiro para quebrar mantendo as
  duas rotas em paralelo — a rota antiga sem versão simplesmente deixou de
  existir (`GET /_api/needs` agora retorna 404; `GET /_api/v1/needs`
  funciona).

## Como uma v2 conviveria com a v1

O esquema de descoberta de endpoints (`discoverEndpoints` em
`server/index.ts`) já percorre `src/endpoints/` recursivamente e deriva a
rota a partir do caminho relativo — é assim que `src/endpoints/auth/login_with_password_POST.ts`
vira `/auth/login_with_password` hoje. O caminho natural para uma v2
conviver com a v1 é o mesmo mecanismo: colocar os endpoints que mudaram de
forma incompatível em `src/endpoints/v2/`, e o servidor precisaria só
reconhecer essa subpasta como sua própria versão (montando-a em
`/_api/v2/<rota>`) em vez de prefixar tudo com `API_VERSION_PREFIX` fixo.
Isso não foi implementado agora — não existe hoje nenhuma mudança de
contrato pendente que precise de v2, e construir esse mecanismo sem um
caso de uso real seria complexidade especulativa. O que existe agora é
suficiente para o requisito do master prompt (um segmento de versão no
contrato) e não impede essa evolução quando for necessária.

## Testes

`test/helpers.ts#buildRequest` continua construindo URLs sem `/v1/` de
propósito — os testes chamam `handle()` do endpoint diretamente (nunca
passam pelo roteamento do Express), e nenhum endpoint lê o pathname da
URL, só `searchParams` e o corpo. O prefixo de versão é uma preocupação da
camada de roteamento HTTP real, não do comportamento de negócio testado.
Nenhum teste precisou mudar por causa do versionamento, exceto duas
asserções que verificavam a URL de download de arquivo literalmente
(`test/filesUpload.test.ts`, `test/allocationsReceiveProof.test.ts`).
