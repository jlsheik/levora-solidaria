MASTER PROMPT V2.1 — LEVORA SOLIDÁRIA
Plataforma autônoma de captação, validação, logística, distribuição e prestação de contas de doações.

OBJETIVO: construir a plataforma completa, segura, multi-instituição e altamente automatizada, sem reduzir o escopo para um simples CRM, chatbot, cadastro de doações ou painel administrativo.

IDIOMA OBRIGATÓRIO DA APLICAÇÃO: português brasileiro (pt-BR) em toda a experiência visível ao usuário.

PRINCÍPIO CENTRAL: a plataforma existe para conectar automaticamente recursos disponíveis a necessidades reais de pessoas em situação de vulnerabilidade, com rastreabilidade de ponta a ponta, privacidade, segurança, transparência e controles antifraude.

VISÃO DO PRODUTO: A Levora Solidária será uma infraestrutura inteligente de solidariedade. O sistema deve procurar oportunidades de doação, verificar sua compatibilidade e segurança, iniciar contatos pelos canais permitidos, negociar as condições da doação, registrar a oportunidade, encontrar a instituição/destino adequado, organizar coleta e transporte, receber e conferir os itens, relacioná-los às necessidades cadastradas, distribuir e gerar prestação de contas.

O sistema deve ser predominantemente autônomo para tarefas de baixo risco, mas a arquitetura deve separar: ações de baixo risco totalmente automáticas; ações condicionadas a regras; ações de alto risco que exigem autorização humana ou dupla autorização. Essa separação é uma exigência de segurança.

O sistema deve suportar desde o início: múltiplas instituições beneficiárias (multi-tenant, isolamento rigoroso entre organizações); múltiplas cidades; múltiplos operadores e voluntários com papéis (roles); múltiplos doadores; oportunidades de doação; inventário; coletas e entregas; agentes de IA especializados; canais de comunicação diferentes; automações de rotina; trilhas de auditoria imutáveis (append-only, não editável por administrador comum); prestação de contas/relatórios de impacto; integração futura com WhatsApp Business, pagamentos (sem dar à IA poder irrestrito de movimentar dinheiro) e fontes de oportunidades.

PRINCÍPIOS ÉTICOS OBRIGATÓRIOS: nenhuma comissão por doação; nenhuma manipulação emocional enganosa; nenhum uso comercial indevido de dados de doadores/beneficiários; nenhum compartilhamento desnecessário de dados de beneficiários; nenhuma alteração silenciosa de histórico; nenhum registro de auditoria apagável por administrador comum; nenhuma pessoa isolada controla sozinha descoberta+recebimento+destinação de recursos de alto valor; a IA nunca inventa disponibilidade, valor, necessidade, pagamento, aprovação, entrega ou recebimento — sempre diferenciar informação confirmada de inferência da IA, e toda previsão deve ser identificada como previsão.

REGRA CONTRA FAKE FEATURES: proibido botão que só mostra alert(); tabela com dados fictícios em produção; integração simulada sem indicar que é simulação; "estoque atualizado" sem transação registrada; "entrega concluída" sem prova; "doação recebida" sem confirmação. Quando uma credencial externa não estiver disponível, criar o adaptador real, configuração por ambiente, interface da integração e modo de teste claramente identificado — nunca fingir que uma integração existe.

Prioridades quando houver conflito: segurança/integridade vence facilidade; controle de risco vence automação total; minimização de dados vence menos dados; isolamento entre organizações vence velocidade de desenvolvimento.

Construir a fundação de produção (organizações multi-tenant com isolamento rigoroso, autenticação, papéis/permissões, trilha de auditoria imutável) primeiro, depois evoluir por domínio: oportunidades de doação, inventário, logística (coleta/entrega), distribuição e prestação de contas, agentes de IA, integrações externas — cada uma com testes reais antes de avançar.
