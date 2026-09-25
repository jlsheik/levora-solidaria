# Rate limiting

O master prompt (seção 108) exige rate limiting em login, ativação, reset de
senha, API pública, webhook e mensagens. Este projeto ainda não tem reset de
senha, API pública para parceiros nem webhooks (nenhum desses fluxos existe
ainda — não há o que limitar). O que existe e é a superfície real de abuso
hoje ganhou limite:

| Endpoint | Limite | Chave | Por quê |
|---|---|---|---|
| `auth/login_with_password` | 20 / 15 min | IP | Já existia bloqueio por e-mail (5 tentativas/15min) — isso protege uma conta específica sendo atacada. O limite por IP protege o servidor de alguém varrendo muitos e-mails diferentes a partir do mesmo IP. |
| `auth/register_with_password` | 10 / hora | IP | Criação de contas em massa (bots/spam). |
| `organization-invites` (criar) | 20 / hora | usuário autenticado | Uma conta legítima poderia bombardear caixas de entrada alheias com convites (e-mail bombing). |
| `organization-invites-lookup` | 30 / hora | IP | Endpoint público sem sessão — maior superfície de força bruta de token deste sistema (32 bytes aleatórios, mas defesa em profundidade). |
| `files-upload` | 30 / hora | usuário autenticado | Abuso de armazenamento (custo, não segurança — upload já exige sessão + membership). |

## Como funciona

`src/helpers/rateLimit.tsx` — contador de janela fixa em memória
(`Map<string, {count, resetAt}>`), sem nenhuma infraestrutura externa. Cada
endpoint chama `checkRateLimit({bucket, identifier, limit, windowMs})` logo
no início do handler, antes de tocar no banco, e devolve 429 com
`Retry-After` quando excedido.

**Limitação conhecida**: correto só para um único processo. Se este
servidor rodar em múltiplas instâncias atrás de um load balancer, cada
instância tem seu próprio contador independente — na prática, o limite
efetivo vira `limite × número de instâncias`. Para limite compartilhado
entre instâncias, trocar o `Map` por um backend compartilhado (Redis é a
escolha padrão da indústria) sem mudar a assinatura de `checkRateLimit`. O
servidor real deste projeto hoje é um único processo Express, então isso
não é uma lacuna imediata — é o próximo passo natural quando/se o
deployment for horizontal.

## IP do cliente

`server/index.ts` injeta `x-client-ip-verified` a partir de `req.ip` do
Express (nunca de um header que o próprio cliente mandou, que poderia ser
forjado) antes de montar o `Request` (Web Fetch API) que cada endpoint
recebe. Atrás de um proxy reverso/load balancer real, configure
`TRUST_PROXY` no `.env` para que `req.ip` leia o IP verdadeiro do cliente a
partir de `X-Forwarded-For` — sem isso, todo tráfego pareceria vir do IP do
proxy, e o rate limiting por IP na prática viraria um limite único
compartilhado por todo mundo.

## O que ainda não existe

- Rate limiting em nível de Express/global (ex.: `express-rate-limit`
  aplicado a `/_api/*` inteiro) como camada adicional de defesa contra
  volume bruto de requisições — hoje a proteção é só nos endpoints
  específicos listados acima. Não implementado porque os endpoints mais
  sensíveis já estão cobertos e um limite genérico teria que ser generoso o
  bastante para não atrapalhar uso legítimo do resto da API (várias
  chamadas de leitura por carregamento de página).
- Reset de senha, API pública para parceiros e webhooks não existem ainda
  neste projeto — quando forem construídos, precisam de rate limiting
  próprio desde o início (seguindo o mesmo `checkRateLimit`).
