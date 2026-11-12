/**
 * M32 — apresentação dos indicadores da análise antimalware para a administração da plataforma (lógica PURA, sem React e sem acesso a servidor).
 * Os indicadores vêm de `GET /file-scan-operations` (somente leitura; só contagens, idades e estados). Regras de leitura:
 *  - o nível de um alerta nunca depende só de cor: cada nível tem um texto (“Atenção”, “Em ordem”, “Limiar não definido”);
 *  - `nao_definido` NUNCA vira “em ordem” (limiar sem decisão operacional não é sinal verde);
 *  - o resumo geral é “atenção” se houver qualquer alerta, “limiares pendentes” se não houver alerta mas houver limiar não definido, e “em ordem” só quando tudo foi avaliado.
 */
import type { OutputType as FileScanOperations } from "../endpoints/file-scan-operations_GET.schema";

export type AlertLevel = FileScanOperations["alerts"][number]["level"];
export type AlertCode = FileScanOperations["alerts"][number]["code"];
export type Tone = "ok" | "attention" | "undefined";

export const ALERT_COPY: Record<AlertCode, { title: string; help: string }> = {
  scanner_sem_resposta: { title: "Serviço de análise (clamd)", help: "O serviço que examina os arquivos precisa responder; sem resposta, os envios ficam retidos." },
  assinaturas_antigas: { title: "Idade das assinaturas de vírus", help: "A base de assinaturas carregada está mais antiga que o limite configurado." },
  assinaturas_desconhecidas: { title: "Versão da base de assinaturas", help: "Sem a data da base carregada não é possível provar que ela está atualizada." },
  backlog_envelhecido: { title: "Arquivos esperando análise há muito tempo", help: "O arquivo mais antigo pendente ou indisponível passou do limite operacional." },
  tarefas_abandonadas: { title: "Análises abandonadas", help: "Análises iniciadas cuja reserva venceu sem terminar; o worker as retoma." },
  tentativas_esgotadas: { title: "Tentativas esgotadas", help: "Arquivos que esgotaram as tentativas automáticas e aguardam reanálise manual." },
  worker_sem_executar: { title: "Reprocessamento automático", help: "O worker de reanálise não executou dentro do limite operacional." },
  falhas_recentes: { title: "Falhas nas últimas 24 h", help: "Execuções do worker de reanálise que terminaram com falha." },
};

export const LEVEL_COPY: Record<AlertLevel, { label: string; tone: Tone }> = {
  ok: { label: "Em ordem", tone: "ok" },
  alerta: { label: "Atenção", tone: "attention" },
  nao_definido: { label: "Limiar não definido", tone: "undefined" },
};

export interface Summary {
  tone: Tone;
  headline: string;
  attention: number;
  undefinedCount: number;
  ok: number;
}

export function summarize(ops: Pick<FileScanOperations, "alerts">): Summary {
  const attention = ops.alerts.filter((a) => a.level === "alerta").length;
  const undefinedCount = ops.alerts.filter((a) => a.level === "nao_definido").length;
  const ok = ops.alerts.filter((a) => a.level === "ok").length;
  if (attention > 0) return { tone: "attention", headline: attention === 1 ? "1 sinal de atenção" : `${attention} sinais de atenção`, attention, undefinedCount, ok };
  if (undefinedCount > 0) return { tone: "undefined", headline: undefinedCount === 1 ? "Sem alertas; 1 limiar operacional ainda não definido" : `Sem alertas; ${undefinedCount} limiares operacionais ainda não definidos`, attention, undefinedCount, ok };
  return { tone: "ok", headline: "Tudo em ordem", attention, undefinedCount, ok };
}

/** Minutos → texto curto. `null`/inválido → “—” (nunca “0”): ausência de dado não é zero. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes < 0) return "—";
  const m = Math.round(minutes);
  if (m < 1) return "menos de 1 min";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} s`;
}

export function formatInstant(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

export const modeLabel = (mode: FileScanOperations["mode"]): string => (mode === "required" ? "Obrigatória (arquivos só são liberados após aprovação)" : "Desativada neste ambiente");

export interface ScannerLine { state: string; tone: Tone; detail: string }
/** Estado do serviço de análise em linguagem direta; “não configurado” só é atenção quando a análise é obrigatória. */
export function scannerLine(ops: Pick<FileScanOperations, "scanner" | "mode">): ScannerLine {
  const s = ops.scanner;
  if (!s.configured) return { state: "Não configurado", tone: ops.mode === "required" ? "attention" : "undefined", detail: ops.mode === "required" ? "A análise é obrigatória, mas nenhum serviço está configurado: envios ficam retidos." : "Sem serviço de análise neste ambiente." };
  if (!s.reachable) return { state: "Sem resposta", tone: "attention", detail: s.error ? `Motivo registrado: ${s.error.replace(/_/g, " ")}.` : "O serviço não respondeu ao teste de vida." };
  const freshness = s.freshness === "atual" ? "assinaturas dentro do limite" : s.freshness === "antigo" ? "assinaturas ANTIGAS" : "idade das assinaturas desconhecida";
  const parts = [s.engine ?? null, s.signatureVersion !== null ? `base ${s.signatureVersion}` : null, s.signatureAgeHours !== null ? `${s.signatureAgeHours} h de idade` : null, freshness].filter(Boolean);
  return { state: "Respondendo", tone: s.freshness === "antigo" ? "attention" : s.freshness === "atual" ? "ok" : "undefined", detail: parts.join(" · ") };
}

export interface MetricView { key: string; label: string; value: string; hint?: string; tone: Tone }
/** Contadores do backlog na ordem de leitura do operador. Contadores > 0 de itens que exigem ação ficam em atenção. */
export function backlogMetrics(b: FileScanOperations["backlog"]): MetricView[] {
  const n = (v: number) => v.toLocaleString("pt-BR");
  return [
    { key: "pendente", label: "Pendentes", value: n(b.pendente), hint: "Aguardando a primeira análise", tone: "ok" },
    { key: "indisponivel", label: "Indisponíveis", value: n(b.indisponivel), hint: "A análise não pôde ser feita; serão retomadas", tone: b.indisponivel > 0 ? "undefined" : "ok" },
    { key: "aguardando", label: "Aguardando nova tentativa", value: n(b.aguardandoNovaTentativa), hint: "Com próxima tentativa agendada", tone: "ok" },
    { key: "abandonadas", label: "Abandonadas", value: n(b.abandonadas), hint: "Reserva vencida sem terminar", tone: b.abandonadas > 0 ? "attention" : "ok" },
    { key: "esgotadas", label: "Tentativas esgotadas", value: n(b.esgotadas), hint: "Exigem reanálise manual", tone: b.esgotadas > 0 ? "attention" : "ok" },
    { key: "infectado", label: "Infectados (bloqueados)", value: n(b.infectado), hint: "Nunca são liberados", tone: "ok" },
    { key: "legado", label: "Legado sem análise", value: n(b.legadoNaoAnalisado), hint: "Bloqueados em produção até a reanálise", tone: b.legadoNaoAnalisado > 0 ? "undefined" : "ok" },
    { key: "pendente-antigo", label: "Pendente mais antigo", value: formatMinutes(b.pendenteMaisAntigoMinutos), tone: "ok" },
    { key: "indisponivel-antigo", label: "Indisponível mais antigo", value: formatMinutes(b.indisponivelMaisAntigoMinutos), tone: "ok" },
  ];
}
