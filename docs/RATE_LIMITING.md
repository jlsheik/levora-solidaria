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
| `auth/account-delete` | 5 / 15 min | usuário autenticado | Fase 52 (SEC-07): comparava a senha (bcrypt) sem nenhum limite — achado real da varredura "qualquer endpoint com bcrypt". Por usuário, não por IP: quem ataca aqui já está autenticado como essa pessoa (sessão comprometida), o IP de origem não é o identificador relevante. |

## Como funciona

`src/helpers/rateLimit.tsx` — contador de janela fixa em memória
(`Map<string, {count, resetAt}>`), sem nenhuma infraestrutura externa. Cada
endpoint chama `checkRateLimit({bucket, identifier, limit, windowMs})` logo
no início do handler, antes de tocar no banco, e devolve 429 com
`Retry-After` quando excedido.

**Limitação conhecida, agora confirmada empiricamente (Fase 52)**: correto
só para um único processo. Rodados dois processos Node reais
(`tsx server/index.ts`) em portas diferentes e atacado o endpoint de
cadastro a partir da MESMA origem real contra os dois: o processo A
bloqueou (429) na 11ª tentativa, exatamente como esperado (limite 10/hora);
o processo B, apesar de ser a mesma origem real, aceitou sua própria
tentativa livremente — prova direta de que os dois processos têm
contadores totalmente independentes. Se este servidor rodar em múltiplas
instâncias atrás de um load balancer, o limite efetivo vira
`limite × número de instâncias`. Para limite compartilhado entre
instâncias, trocar o `Map` por um backend compartilhado (Redis, ou um
UPSERT atômico em Postgres) sem mudar a assinatura de `checkRateLimit`.

**Por que não foi trocado nesta fase**: o servidor real deste projeto hoje
é genuinamente um único processo Express (`node dist-server/server/index.js`,
ver `docs/DEPLOYMENT.md` — nenhuma topologia de múltiplas instâncias está
configurada ou decidida). Trocar para Postgres/Redis agora adicionaria uma
consulta extra em TODA requisição aos 6 endpoints protegidos (um hot path:
login, cadastro, convites, upload, exclusão de conta) sem nenhum ganho de
correção na topologia atual — e, ironicamente, um rate limiter mal feito
sobre o próprio banco pode virar um novo vetor de sobrecarga do Postgres
sob exatamente o tipo de tráfego que ele deveria conter. **Threshold para
revisitar**: no momento em que a infraestrutura de produção definir mais
de um processo/instância rodando simultaneamente, esta troca deixa de ser
opcional.

**Concorrência (Fase 52, confirmada empiricamente)**: `checkRateLimit` não
tem nenhum `await` dentro da seção crítica (leitura+incremento do contador)
— roda do início ao fim de forma síncrona, e o event loop de um único
processo Node nunca interrompe código síncrono no meio. 50 requisições de
cadastro disparadas ao mesmo tempo (`Promise.all`) contra o mesmo IP real,
via servidor Express de verdade: exatamente 10 permitidas, 40 bloqueadas —
nenhum excedente, sem nenhum lock explícito necessário (ver
`test/rateLimitHardening.test.ts`).

## IP do cliente

`server/index.ts` injeta `x-client-ip-verified` a partir de `req.ip` do
Express (nunca de um header que o próprio cliente mandou, que poderia ser
forjado) antes de montar o `Request` (Web Fetch API) que cada endpoint
recebe. Atrás de um proxy reverso/load balancer real, configure
`TRUST_PROXY` no `.env` para que `req.ip` leia o IP verdadeiro do cliente a
partir de `X-Forwarded-For` — sem isso, todo tráfego pareceria vir do IP do
proxy, e o rate limiting por IP na prática viraria um limite único
compartilhado por todo mundo.

**Resistência a spoofing testada de verdade (Fase 52)**, contra um
servidor Express real (não só o helper `checkRateLimit` isolado):

- **Sem `TRUST_PROXY` configurado (padrão)**: 11 requisições de cadastro,
  cada uma com um `X-Forwarded-For` FORJADO e diferente, continuam
  compartilhando o mesmo contador (o header é completamente ignorado) — a
  11ª é bloqueada (429), exatamente como se nenhum header tivesse sido
  enviado. Spoofing não funciona no padrão de fábrica.
- **Com `TRUST_PROXY=1` configurado**: as mesmas 11 requisições, cada uma
  com `X-Forwarded-For` diferente, recebem 11 contadores INDEPENDENTES —
  nenhuma bloqueada. Comportamento correto quando (e só quando) existe um
  proxy reverso real na frente que sobrescreve esse header com o IP
  verdadeiro do cliente antes de repassar a requisição — nunca habilitar
  isto sem essa garantia de infraestrutura.

Ver `test/rateLimitHardening.test.ts` para os dois cenários como testes de
regressão permanentes.

## Cadastro, bcrypt e o limite de IP (Fase 52)

Desde a Fase 51 (SEC-04), `register_with_password_POST` calcula o hash da
senha (bcrypt, custo 10) SEMPRE — tanto para e-mail novo quanto para
e-mail já existente — para que o tempo de resposta não vaze a mesma
informação que a mensagem pública já esconde. Isso significa que toda
tentativa de cadastro aceita pelo rate limit paga o custo cheio de bcrypt,
intencionalmente.

A pergunta da Fase 52 era se o limite de IP (10/hora) realmente contém
esse custo. Confirmado por teste real (`test/rateLimitHardening.test.ts`):
o limite de IP é checado **antes** de qualquer processamento (inclusive
antes do hash) — a 11ª tentativa nunca chega a pagar o custo de bcrypt,
seja o e-mail novo ou repetido. O limite de 10/hora/IP já contém o custo
computacional total em, no máximo, 10 hashes bcrypt por IP por hora —
não foi necessário reduzir esse limite nem adicionar uma camada extra.

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

## Risco residual: crescimento do Map em memória (Fase 52, avaliado e aceito)

Cada identificador novo (tipicamente um IP real, já que spoofing via
`X-Forwarded-For` não funciona sem `TRUST_PROXY` — ver acima) cria uma
entrada no `Map`, removida só por uma varredura probabilística (2% de
chance a cada chamada) que apaga entradas expiradas. Em teoria, alguém com
acesso a muitos IPs reais distintos poderia inflar o `Map`. Na prática,
cada entrada é dois números (poucos bytes) — inflar isso a ponto de
importar para a memória do processo exigiria uma quantidade de IPs reais
e distintos que já caracterizaria um ataque distribuído de grande escala,
cenário em que o rate limiting por IP deixaria de ser a defesa relevante
de qualquer forma. Avaliado e aceito como está nesta fase — não é um
vetor de exaustão de memória praticamente explorável por um atacante
isolado.
