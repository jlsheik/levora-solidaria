// Cargas de teste de XSS INOFENSIVAS: nenhuma faz mais do que pedir uma imagem de 1 pixel ao coletor local da própria verificação
// (`new Image().src = http://127.0.0.1:<porta>/h?id=<id>`). O coletor registra o id; cada id identifica carga E campo, então um "acerto" prova
// que aquela carga, guardada naquele campo, foi EXECUTADA pelo navegador. Quase todas trazem `data-xss="<id>"`, de modo que um elemento criado
// a partir do texto (mesmo se um CSP impedisse a execução) também é detectável no DOM. Nada aqui é usado fora do banco/navegador descartáveis.

/** Código de aviso inofensivo (acusa a execução ao coletor local). */
export const hitCode = (collector, id) => `void((new Image).src='${collector}/h?id=${id}')`; // void: um javascript: não pode trocar o documento pelo valor da expressão

/** As cargas, uma por contexto de renderização. `ctx` descreve o contexto que a carga tenta quebrar. */
export function payloadSet(collector, field) {
  const id = (n) => `${n}@${field}`;
  return [
    { key: "P1", ctx: "HTML: elemento com manipulador de evento", id: id("P1"), text: `<img data-xss="${id("P1")}" src=x onerror="${hitCode(collector, id("P1"))}">` },
    { key: "P2", ctx: "HTML: elemento <script>", id: id("P2"), text: `<script data-xss="${id("P2")}">${hitCode(collector, id("P2"))}</script>` },
    { key: "P3", ctx: "atributo: fecha o valor e abre um elemento", id: id("P3"), text: `"><svg data-xss="${id("P3")}" onload="${hitCode(collector, id("P3"))}">` },
    { key: "P4", ctx: "string JavaScript entre apóstrofos", id: id("P4"), text: `'-${hitCode(collector, id("P4"))}-'` },
    { key: "P5", ctx: "textarea: fecha o elemento e injeta script", id: id("P5"), text: `</textarea><script data-xss="${id("P5")}">${hitCode(collector, id("P5"))}</script>` },
    { key: "P6", ctx: "URL: âncora com javascript:", id: id("P6"), text: `<a data-xss="${id("P6")}" href="javascript:${hitCode(collector, id("P6"))}">x</a>` },
    { key: "P7", ctx: "HTML: <details ontoggle>", id: id("P7"), text: `<details data-xss="${id("P7")}" open ontoggle="${hitCode(collector, id("P7"))}">` },
    { key: "P8", ctx: "template/expressão (Angular-like)", id: id("P8"), text: `{{constructor.constructor("${hitCode(collector, id("P8"))}")()}}` },
  ];
}

/** Valor para um campo de texto livre: todas as cargas juntas (o id de cada uma ainda identifica o campo). */
export const combined = (collector, field) => payloadSet(collector, field).map((p) => p.text).join(" ");

/** Carga de URL (campo que vira href): esquema `javascript:`. */
export const javascriptUrl = (collector, id) => `javascript:${hitCode(collector, id)}`;

/** Campos de texto do banco em que as cargas são guardadas (um id por campo). */
export const FIELDS = ["org-name", "org-city", "need-title", "need-description", "item-name", "source-name", "opp-title", "opp-description", "user-name", "tx-reason", "event-notes"];

/** "P1@need-title" → { payload: "P1", field: "need-title" }. */
export function parseHitId(id) {
  const [payload, ...rest] = String(id).split("@");
  return { payload, field: rest.join("@") };
}

/** Os 8 ids de cada campo; `expectedHitIds` é o universo que NUNCA deve aparecer no coletor numa aplicação correta. */
export const allIds = (collector) => FIELDS.flatMap((f) => payloadSet(collector, f).map((p) => p.id));
