# WhatsApp

Master prompt, seção 142 (documentação obrigatória) e seções 20, 21, 52
(Outreach Agent, mensagens automáticas, WhatsApp Business API).

## Estado real: não implementado

Não existe nenhuma integração com WhatsApp neste projeto — nem real, nem
simulada. Nenhuma tabela, endpoint, adaptador ou variável de ambiente
relacionada a WhatsApp existe no código hoje. Isto é diferente do padrão já
usado para e-mail (`docs/CONVITE_DE_MEMBROS.md`) e storage
(`docs/UPLOAD_DE_ARQUIVOS.md`), onde existe um adaptador real com um modo
"não configurado" honesto — para WhatsApp, nem o adaptador existe ainda,
porque nenhum fluxo do sistema depende de WhatsApp hoje (não há Outreach
Agent, não há contato automático com doador — ver `docs/AI_AGENTS.md`).

Construir um adaptador de WhatsApp sem nenhum fluxo real que o use seria
infraestrutura especulativa — o oposto do que a regra do projeto contra
"não recrie uma aplicação paralela sem necessidade" pede.

## O que o master prompt exige quando esta integração for construída

Registrado aqui para quando o Outreach Agent (ou qualquer fluxo de contato
com doador) for implementado de verdade — a integração precisa nascer
seguindo isto desde o primeiro commit, não como um "v2" adicionado depois:

- **Só a infraestrutura oficial do WhatsApp Business API** (Cloud API da
  Meta ou BSP homologado) — nunca automação não-oficial (biblioteca que
  simula um cliente WhatsApp comum), que viola os termos de uso da
  plataforma e é o tipo de risco que a seção 16 do master prompt já proíbe
  explicitamente ("nunca burlar CAPTCHA, contornar mecanismos anti-bot").
- **Configuração no servidor, nunca no navegador**:
  `whatsapp_business_account_id`, `phone_number_id`, `webhook_secret`,
  `access_token_secret_ref` — token nunca exposto ao cliente.
- **Verificação de assinatura do webhook** antes de processar qualquer
  evento recebido da Meta.
- **`CommunicationPolicyEngine`** (seção 20 do master prompt) bloqueando
  automaticamente: mensagem sem opt-in quando exigido, fora da janela de
  atendimento, sem template aprovado para conversa iniciada pela
  organização, acima do limite de frequência.
- **Registro de consentimento e logs de mensagem** — toda mensagem enviada
  e recebida associada a um registro de consentimento verificável, nunca
  "enviamos porque achamos que podia".
- **A IA nunca decide sozinha o conteúdo final de uma mensagem para envio
  livre** — segue os mesmos limites do resto do sistema (nunca inventar
  número de famílias, urgência, aprovação de autoridade, valor de mercado
  — seção 21 do master prompt).

## Alternativa enquanto não existe

Contato com doadores hoje é manual, fora do sistema (telefone, e-mail
pessoal, WhatsApp usado diretamente pela pessoa responsável na
organização) — o sistema registra a oportunidade e o resultado do contato
(`opportunity_registry`), não o canal de comunicação em si.
