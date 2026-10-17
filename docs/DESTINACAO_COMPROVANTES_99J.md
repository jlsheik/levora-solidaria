# Fase 99J — comprovantes de destinação

Escopo (especificação de destinação, seções 12 e 13 e tabela de subfases): comprovantes com propósito próprio `comprovante_destinacao`, **privados**, com autorização de leitura por finalidade do arquivo + vínculo + função, alterações sempre auditadas e nada apagado. **Comprovante é opcional** (nenhuma regra o exige). Sem cadastro nominal de beneficiários. Fora do escopo: validação de ponta a ponta (99K), política de retenção (depende de avaliação jurídica, seção 21), análise antimalware (não existe no projeto).

## Reuso da infraestrutura existente (nada de segundo mecanismo)

- Upload: o mesmo `POST /files-upload` (permissão `arquivos.envie`, limite de 30 envios/hora por usuário, 8 MB, JPEG/PNG/WebP/PDF, tipo verificado pelos primeiros bytes — o MIME informado não é confiado —, base64 estrito, nome sem caracteres de controle, chave de armazenamento `uuid` gerada no servidor). Novo valor de `purpose`: `comprovante_destinacao`.
- Armazenamento: o `storageAdapter` existente (privado; a chave e o provedor nunca saem do servidor nem entram na auditoria). Falha no banco após o upload remove o objeto criado por aquela tentativa (compensação existente); se a remoção falhar, fica o registro `ARQUIVO_ORFAO` no log (procedimento de `docs/UPLOAD_DE_ARQUIVOS.md`).
- Tabela `files` e a chave composta `(id, organization_id)` da migration `0017`; a coluna `stock_destinations.proof_file_id` e a FK composta já existiam desde a 99D.

## Modelo (migration `0023_destination_proofs`)

O vínculo é um **evento imutável** em `stock_destinations`, sem tocar a destinação original, o estoque ou o atendimento:
- **anexar** = `correction` só com `proof_file_id` (e motivo ≥ 5 caracteres);
- **remover a referência** = `correction` com `proof_removed = true` apontando para o mesmo arquivo — o registro do anexo e o objeto armazenado **permanecem** (nada é excluído);
- **substituir** = remover + anexar outro; o comprovante **vigente** é o evento de comprovante mais recente, se não for uma remoção.
O banco garante: evento de comprovante só com o arquivo (CHECK), arquivo do propósito certo e da mesma organização (gatilho + FK composta), um arquivo vincula-se **no máximo uma vez** (índice único; um arquivo removido não volta — envia-se outro), só se remove o comprovante **vigente** (sob `FOR UPDATE` da destinação original), imutabilidade (gatilhos existentes de UPDATE/DELETE). Eventos de comprovante **não** contam como "correção documental" (situação `com_correcao`, relatório da 99H).

## Estados e autorização

Estados do arquivo: **pendente** (enviado, sem vínculo), **vigente**, **removido**.
- Enviar: `arquivos.envie` (proprietário, administrador, operador).
- Anexar (`POST /stock-destination-proof`, `inventario.lance`): quem registrou a destinação e enviou o arquivo, ou proprietário/administrador. Remover a referência: **só proprietário/administrador** (evidência é mais sensível). Sem permissão nova.
- Metadados: `GET /stock-destinations` (`inventario.lance`) inclui nome, tipo, tamanho, autor e data do comprovante vigente e `canAttachProof`; nunca a chave de armazenamento.
- **Download** (`GET /files-download`), para `comprovante_destinacao`: exige membro ativo **e** `inventario.lance` **e** vínculo vigente com destinação da organização; pendente ou removido só para quem enviou ou proprietário/administrador (conferência/auditoria); caso contrário 404 (voluntário: 403). Cada acesso é reautorizado no servidor e auditado (`arquivo.baixado`); resposta `private, no-store`, `nosniff`, sem URL assinada nem link permanente. Arquivos de outras finalidades mantêm a regra antiga (membro da organização).
- Isolamento: arquivo ou destinação de outra organização = 404; ator de outra organização = 403.

## Consistência, idempotência e auditoria

O upload (armazenamento externo) e o vínculo são dois passos: um arquivo enviado e não vinculado fica **pendente** (não é comprovante, só o autor/gerentes o abrem) e pode ser vinculado depois; a interface reutiliza o arquivo já enviado numa nova tentativa. O vínculo é uma transação única: evento + pedido idempotente (`destination_correction_requests`, mesma chave/hash das correções e reversões; chave reutilizada com outro conteúdo = 409) + auditoria (`destinacao.comprovante_anexado` / `destinacao.comprovante_removido`, com arquivo, tipo, tamanho, motivo, ator; sem dados de armazenamento). Falha em qualquer passo desfaz tudo; anexos simultâneos do mesmo arquivo se serializam (trava do arquivo) e só um vence.

## Interface

Em cada cartão de destinação (Inventário e aba Destinação): linha do comprovante vigente (nome, tamanho, autor, data) com "Abrir comprovante" (nova aba, autorizado a cada acesso) ou "Sem comprovante anexado (opcional)"; "Anexar comprovante" (só quando permitido) abre diálogo com `FileDropzone`, validação de tipo/tamanho, motivo obrigatório, aviso de que o comprovante não altera estoque nem atendimento e para não enviar documentos identificáveis, indicação honesta de etapa ("Enviando o arquivo…", "Confirmando o vínculo…" — o envio não tem barra de progresso percentual), "Tentar de novo" seguro e bloqueio de clique duplicado; "Remover comprovante" (proprietário/administrador) explica que o arquivo e o histórico permanecem. A linha do tempo mostra "Comprovante anexado" e "Referência ao comprovante removida". O relatório da 99H ganhou `destination.proofs` (contagem com × sem comprovante vigente; sem comprovante não é irregularidade).

## Privacidade (`docs/PRIVACY.md`)

Sem cadastro nominal; a interface orienta a não anexar documentos identificáveis, mas **não há detecção automática**. Comprovantes são privados e de acesso restrito; **não há política de retenção, exclusão ou anonimização do conteúdo** (a remoção desvincula e preserva o arquivo para auditoria) — depende de avaliação jurídica. Não há análise antimalware.

## Testes

`test/destinationProofs.test.ts` (16, PostgreSQL real, armazenamento local descartável): fluxo completo; evento fora da contagem de correções e do saldo; substituição e histórico; validação de conteúdo/MIME/nome/base64/propósito; permissões de anexar/remover; download por estado e perfil; isolamento entre organizações; arquivo de outra finalidade; idempotência; concorrência (anexo e remoção); reversão não afeta o comprovante; atomicidade (falha na auditoria e no banco pós-upload); garantias do banco; `canAttachProof`. Sensibilidade comprovada: sem a checagem de download, sem o filtro de organização do arquivo e sem a checagem de propósito, testes falham. `qa:visual`: 5 cenários novos (perfil `ci`: 70).

## Limitações

Sem barra de progresso percentual (fetch/base64); arquivos pendentes nunca vinculados não têm limpeza automática (ficam no armazenamento; procedimento manual); sem comprovante no momento do registro da saída (só depois, por esta fluxo); sem exclusão física; sem retenção; sem antimalware; o diálogo de anexar não permite 2 comprovantes vigentes (substituição exige remover antes).
