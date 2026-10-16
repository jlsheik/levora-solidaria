# Riscos pré-produção após a 99K (auditoria de segurança dos comprovantes)

Classificação: **(1)** bloqueador técnico corrigido agora; **(2)** decisão jurídica/operacional; **(3)** melhoria de roadmap; **(4)** validação oficial/de ambiente. Cada item foi confirmado no código e nos testes, não só na documentação.

| # | Risco | Classe | Situação |
|---|---|---|---|
| 1 | Arquivo enviado era servido sem análise antimalware (só tipo pelos bytes) | 1 | **Corrigido no código:** estados de análise, bloqueio de download/vínculo (aplicação + gatilho), falha fechada, reanálise, conciliação (`docs/ANTIMALWARE_ARQUIVOS.md`). Scanner real **testado localmente com ClamAV 1.5.4/EICAR; provisionamento de produção continua pendente** → ver 12 |
| 2 | Rota alternativa: outro `purpose` ou o comprovante de recebimento poderia contornar a análise | 1 | **Corrigido:** a análise vale para todos os propósitos; `allocations-receive` exige arquivo liberado; o gatilho do banco cobre o vínculo de destinação |
| 3 | Arquivos anteriores à análise seriam servidos sem terem sido analisados em produção | 1 | **Corrigido:** `legado_nao_analisado` é bloqueado no modo obrigatório até reanálise |
| 4 | Timeout/erro do scanner interpretado como aprovação | 1 | **Coberto por teste** (quatro causas + produção sem scanner + resposta inválida) |
| 5 | Administradores/autor conseguiam baixar arquivo retido | 1 | **Corrigido:** 409 para todos quando não liberado |
| 6 | Sem política de retenção/exclusão/anonimização; não existe exclusão de conta nem de organização | 2 | **Pendente** (`docs/DECISAO_RETENCAO_COMPROVANTES.md`); nenhum prazo inventado |
| 7 | Dado pessoal de terceiros em comprovante (sem detecção automática) | 2 | Mitigado por orientação na interface e acesso restrito; tratamento depende da decisão 6 |
| 8 | Quem executa a decisão de eliminar arquivos retidos/infectados | 2 | Pendente (operacional) |
| 9 | Decisão sobre o provedor/região do armazenamento (S3 no exterior) | 2 | Pendente |
| 10 | Sem fila/reprocessamento automático da análise; sem métricas/alertas de backlog; sem idade das assinaturas | 3 | Roadmap; o backlog é visível na conciliação |
| 11 | Sem barra de progresso percentual; comprovante só após o registro da saída; exportação; visão por data de corte | 3 | Roadmap/sem atribuição |
| 12 | Scanner real (ClamAV) provisionado, atualizado e testado com EICAR; recursos/custo da implantação | 4 | **Parcial:** teste local real com ClamAV 1.5.4 detectou EICAR e aprovou arquivo limpo; scanner não provisionado na infraestrutura do produto; recursos/custos de produção ainda desconhecidos. **Retomada 16/10/2026:** arquivo `test/fileScan.test.ts` inteiro 18/18 com o ClamAV real (imagem `clamav/clamav:1.5.4-debian13-slim`, loopback); EICAR detectado (direto e dentro de PDF pelo `files-upload`), limpo aprovado, falha de conexão = `indisponivel`, recuperação por nova análise; o daemon usa a base **carregada** (28151 até o reload, 28155 depois), não a do disco — ver `docs/ANTIMALWARE_ARQUIVOS.md`. A causa da primeira execução completa com código 1 **não foi reproduzida** (hipótese: teste anterior removia `CLAMD_HOST`; corrigido). Continuam abertos: infraestrutura definitiva, monitoramento da idade das assinaturas, fila, S3, carga. |
| 13 | CI oficial do GitHub para a cadeia #12–#17 (base ≠ `master`) | 4 | Sem checks oficiais; só a 99F (#11) tem run |
| 14 | Concorrência de uploads/limites sob carga e comportamento do S3 real | 4 | Não testado (só disco local) |
