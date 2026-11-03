// Remove o que pode carregar credencial antes de gravar qualquer diagnóstico (URL com query/fragmento, valores de campos sensíveis em texto livre).
const SENSITIVE = /\b(password|senha|token|secret|segredo|cookie|set-cookie|authorization|api[_-]?key|csrf)\b(["']?\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi;
const BEARER = /\bBearer\s+\S+/gi;

export const cleanUrl = (u) => String(u ?? "").replace(/[?#].*$/, "");
export const redact = (t) => String(t ?? "").replace(BEARER, "Bearer [redigido]").replace(SENSITIVE, "$1=[redigido]");
