/**
 * Diagnóstico de integridade do armazenamento de arquivos — SOMENTE LEITURA.
 *
 * Compara o que existe fisicamente em cada provedor (disco local e S3) com os registros de `files` e classifica as diferenças em categorias que NÃO se
 * misturam:
 *   - `orphans`               objeto no provedor sem NENHUM registro em `files` (provedor + chave exata);
 *   - `recordsWithoutObject`  registro válido cujo objeto não está no provedor indicado por `files.storageProvider`;
 *   - `inconsistentMetadata`  registro que não dá para comparar com segurança (provedor desconhecido, chave fora do formato, prefixo diferente da organização, duplicata);
 *   - `unverified` / `failures`  parte que NÃO pôde ser verificada (banco, diretório, listagem, timeout, provedor sem configuração). Falha de diagnóstico NUNCA vira
 *     "objeto ausente": o resultado da auditoria passa a ser `incompleto` e nada daquele provedor é classificado.
 * Garantias de leitura: o banco é lido numa transação `READ ONLY` (o próprio Postgres recusa qualquer escrita), o disco só usa `readdir`/`lstat` (sem seguir links
 * simbólicos, sem sair da raiz administrada), o S3 só usa `ListObjectsV2`. Este módulo não importa nenhuma operação de gravação/remoção (test/storageIntegrity.test.ts
 * confere o código-fonte). Não existe correção automática: identificar os órfãos e decidir removê-los são passos separados e manuais (docs/UPLOAD_DE_ARQUIVOS.md).
 * O relatório contém só chaves, ids de arquivo/organização e contagens — nunca conteúdo, bucket, endpoint, região ou credenciais.
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { MANAGED_KEY_SHAPE } from "./storageAdapter.js";

export type ProviderName = "local" | "s3";
export const PROVIDERS: readonly ProviderName[] = ["local", "s3"];

export interface FileRecord { id: number; organizationId: number; storageProvider: string; storageKey: string }

/** Inventário de UM provedor: `keys` só existe se a enumeração terminou por completo. */
export type Inventory =
  | { provider: ProviderName; complete: true; keys: string[]; notes?: string[]; unrecognized?: string[] }
  | { provider: ProviderName; complete: false; failure: string };

export interface InconsistentMetadata { kind: "provedor-desconhecido" | "chave-fora-do-formato" | "prefixo-diferente-da-organizacao" | "chave-duplicada"; fileId: number; organizationId: number; provider: string; key: string; detail: string }

export type AuditStatus = "completo-sem-inconsistencias" | "completo-com-inconsistencias" | "incompleto";
export const EXIT_CODES = { OK: 0, INCONSISTENCIES: 1, INCOMPLETE: 2, USAGE: 3 } as const;

export interface AuditReport {
  generatedAt: string;
  status: AuditStatus;
  exitCode: number;
  database: { complete: boolean; recordsConsulted: number; failure?: string };
  providers: Array<{ provider: ProviderName; examined: boolean; complete: boolean; recordsConsulted: number; objectsEnumerated: number; failure?: string; notes?: string[] }>;
  orphans: Array<{ provider: ProviderName; key: string }>;
  recordsWithoutObject: Array<{ provider: ProviderName; key: string; fileId: number; organizationId: number }>;
  inconsistentMetadata: InconsistentMetadata[];
  /** Objetos presentes no provedor com formato que o app nunca cria (não entram na comparação de órfãos): só informativo. */
  unrecognizedObjects: Array<{ provider: ProviderName; key: string }>;
  unverified: string[];
  totals: { recordsConsulted: number; objectsEnumerated: number; orphans: number; recordsWithoutObject: number; inconsistentMetadata: number; unrecognizedObjects: number; unverified: number };
}

const isProvider = (p: string): p is ProviderName => p === "local" || p === "s3";

/**
 * Função PURA: classifica registros × inventários. `requested` = provedores que a execução se propôs a verificar. Um provedor solicitado sem inventário completo
 * entra em `unverified` e NENHUM registro/objeto dele é classificado como ausente/órfão.
 */
export function analyze(input: { records: FileRecord[] | null; databaseFailure?: string; inventories: Inventory[]; requested: ProviderName[]; now?: Date }): AuditReport {
  const records = input.records ?? [];
  const inconsistentMetadata: InconsistentMetadata[] = [];
  const unverified: string[] = [];
  const orphans: AuditReport["orphans"] = []; const recordsWithoutObject: AuditReport["recordsWithoutObject"] = []; const unrecognizedObjects: AuditReport["unrecognizedObjects"] = [];

  if (!input.records) unverified.push(`banco: ${input.databaseFailure ?? "não foi possível ler os registros"} (nenhuma comparação foi feita)`);

  // 1) metadados: só registros SEM problema entram na comparação
  const valid: FileRecord[] = [];
  const seen = new Map<string, FileRecord[]>();
  for (const r of records) {
    const bad = (kind: InconsistentMetadata["kind"], detail: string) => inconsistentMetadata.push({ kind, fileId: r.id, organizationId: r.organizationId, provider: r.storageProvider, key: r.storageKey, detail });
    if (!isProvider(r.storageProvider)) { bad("provedor-desconhecido", "files.storage_provider não é 'local' nem 's3'"); continue; }
    if (!MANAGED_KEY_SHAPE.test(r.storageKey)) { bad("chave-fora-do-formato", "a chave não tem o formato <organizationId>/<uuid> que o app gera"); continue; }
    if (r.storageKey.split("/")[0] !== String(r.organizationId)) { bad("prefixo-diferente-da-organizacao", "o prefixo da chave não é o organization_id do registro"); continue; }
    const k = `${r.storageProvider}|${r.storageKey}`; const list = seen.get(k) ?? []; list.push(r); seen.set(k, list);
    valid.push(r);
  }
  for (const [, list] of seen) if (list.length > 1) for (const r of list) inconsistentMetadata.push({ kind: "chave-duplicada", fileId: r.id, organizationId: r.organizationId, provider: r.storageProvider, key: r.storageKey, detail: `a mesma chave aparece em ${list.length} registros (ids ${list.map((x) => x.id).join(", ")})` });

  // 2) comparação, provedor a provedor, só com inventário COMPLETO
  const providerReports: AuditReport["providers"] = [];
  for (const provider of PROVIDERS) {
    const requested = input.requested.includes(provider);
    const recs = records.filter((r) => r.storageProvider === provider);
    const inv = input.inventories.find((i) => i.provider === provider);
    if (!requested) { providerReports.push({ provider, examined: false, complete: false, recordsConsulted: recs.length, objectsEnumerated: 0, notes: ["provedor não solicitado nesta execução"] }); continue; }
    if (!inv || !inv.complete) {
      const failure = inv && !inv.complete ? inv.failure : "inventário ausente";
      unverified.push(`${provider}: ${failure}`);
      providerReports.push({ provider, examined: true, complete: false, recordsConsulted: recs.length, objectsEnumerated: 0, failure });
      continue;
    }
    providerReports.push({ provider, examined: true, complete: true, recordsConsulted: recs.length, objectsEnumerated: inv.keys.length, ...(inv.notes?.length ? { notes: inv.notes } : {}) });
    if (!input.records) continue; // sem banco não há como comparar
    const referenced = new Set(recs.map((r) => r.storageKey)); // QUALQUER registro do provedor referencia a chave, mesmo com metadado ruim
    const present = new Set(inv.keys);
    for (const key of inv.keys) {
      if (!MANAGED_KEY_SHAPE.test(key)) { unrecognizedObjects.push({ provider, key }); continue; }
      if (!referenced.has(key)) orphans.push({ provider, key });
    }
    for (const u of inv.unrecognized ?? []) unrecognizedObjects.push({ provider, key: u });
    for (const r of valid) if (r.storageProvider === provider && !present.has(r.storageKey)) recordsWithoutObject.push({ provider, key: r.storageKey, fileId: r.id, organizationId: r.organizationId });
  }

  orphans.sort((a, b) => (a.provider + a.key).localeCompare(b.provider + b.key));
  recordsWithoutObject.sort((a, b) => a.fileId - b.fileId);
  const incomplete = unverified.length > 0;
  const hasIssues = orphans.length + recordsWithoutObject.length + inconsistentMetadata.length > 0;
  const status: AuditStatus = incomplete ? "incompleto" : hasIssues ? "completo-com-inconsistencias" : "completo-sem-inconsistencias";
  const exitCode = status === "incompleto" ? EXIT_CODES.INCOMPLETE : status === "completo-com-inconsistencias" ? EXIT_CODES.INCONSISTENCIES : EXIT_CODES.OK;
  return {
    generatedAt: (input.now ?? new Date()).toISOString(), status, exitCode,
    database: { complete: Boolean(input.records), recordsConsulted: records.length, ...(input.records ? {} : { failure: input.databaseFailure ?? "falha ao ler os registros" }) },
    providers: providerReports, orphans, recordsWithoutObject, inconsistentMetadata, unrecognizedObjects, unverified,
    totals: { recordsConsulted: records.length, objectsEnumerated: providerReports.reduce((n, p) => n + p.objectsEnumerated, 0), orphans: orphans.length, recordsWithoutObject: recordsWithoutObject.length, inconsistentMetadata: inconsistentMetadata.length, unrecognizedObjects: unrecognizedObjects.length, unverified: unverified.length },
  };
}

// ------------------------------------------------------------------------------------------------ coleta: disco
/**
 * Enumera a raiz administrada do disco: SÓ `readdir`/`lstat`; links simbólicos NUNCA são seguidos (viram "não reconhecidos"), nada fora da raiz é aberto, e qualquer
 * falha de leitura torna o inventário incompleto. Raiz inexistente: com registros locais é falha (provável STORAGE_LOCAL_DIR errado); sem registros é inventário vazio.
 */
export async function enumerateLocal(root: string, opts: { hasLocalRecords: boolean }): Promise<Inventory> {
  const absRoot = path.resolve(root);
  try {
    const st = await lstat(absRoot);
    if (st.isSymbolicLink() || !st.isDirectory()) return { provider: "local", complete: false, failure: "a raiz do armazenamento local não é um diretório (ou é um link simbólico)" };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return opts.hasLocalRecords
        ? { provider: "local", complete: false, failure: "a raiz do armazenamento local não existe, mas há registros locais (STORAGE_LOCAL_DIR correto?)" }
        : { provider: "local", complete: true, keys: [], notes: ["raiz do armazenamento local inexistente (nenhum registro local)"] };
    }
    return { provider: "local", complete: false, failure: `não foi possível ler a raiz do armazenamento local (${(e as NodeJS.ErrnoException).code ?? "erro"})` };
  }
  const keys: string[] = []; const unrecognized: string[] = [];
  const walk = async (dir: string, rel: string): Promise<string | null> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { return `não foi possível listar ${rel || "."} (${(e as NodeJS.ErrnoException).code ?? "erro"})`; }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name; const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) { unrecognized.push(`${relPath} (link simbólico, não seguido)`); continue; }
      if (entry.isDirectory()) { const err = await walk(full, relPath); if (err) return err; continue; }
      if (entry.isFile()) keys.push(relPath); else unrecognized.push(`${relPath} (não é arquivo regular)`);
    }
    return null;
  };
  const err = await walk(absRoot, "");
  if (err) return { provider: "local", complete: false, failure: err };
  return { provider: "local", complete: true, keys: keys.sort(), ...(unrecognized.length ? { unrecognized } : {}) };
}

// ------------------------------------------------------------------------------------------------ coleta: S3
/** Enumera o bucket pelo adaptador S3 (`listKeys` = só ListObjectsV2, todas as páginas). Qualquer erro vira inventário incompleto (mensagem sem bucket/endpoint). */
export async function enumerateS3(adapter: { listKeys(): Promise<string[]> } | null): Promise<Inventory> {
  if (!adapter) return { provider: "s3", complete: false, failure: "provedor s3 não configurado neste ambiente (variáveis S3_*)" };
  try { return { provider: "s3", complete: true, keys: await adapter.listKeys() }; }
  catch (e) { return { provider: "s3", complete: false, failure: `a listagem do S3 falhou (${e instanceof Error ? e.name : "erro"}); o inventário está incompleto` }; }
}

// ------------------------------------------------------------------------------------------------ coleta: banco
/** Lê `files` numa transação READ ONLY: o Postgres recusa qualquer escrita nela. Só as colunas necessárias (sem nome de arquivo, tipo ou usuário). */
export async function readFileRecords(db: { transaction(): { execute<T>(fn: (trx: any) => Promise<T>): Promise<T> } }): Promise<FileRecord[]> {
  return db.transaction().execute(async (trx) => {
    await sql`SET TRANSACTION READ ONLY`.execute(trx);
    const rows = await trx.selectFrom("files").select(["id", "organizationId", "storageProvider", "storageKey"]).orderBy("id").execute();
    return rows.map((r: { id: number; organizationId: number; storageProvider: string; storageKey: string }) => ({ id: Number(r.id), organizationId: Number(r.organizationId), storageProvider: r.storageProvider, storageKey: r.storageKey }));
  });
}

export interface RunAuditOptions {
  db: Parameters<typeof readFileRecords>[0];
  providers: ProviderName[];
  localRoot: string;
  s3Adapter: { listKeys(): Promise<string[]> } | null;
  now?: Date;
}

/** Executa a auditoria completa. Nunca lança por falha de coleta: ela vira `incompleto` no relatório. */
export async function runAudit(opts: RunAuditOptions): Promise<AuditReport> {
  let records: FileRecord[] | null = null; let databaseFailure: string | undefined;
  try { records = await readFileRecords(opts.db); } catch (e) { databaseFailure = `leitura do banco falhou (${e instanceof Error ? e.name : "erro"})`; }
  const inventories: Inventory[] = [];
  if (opts.providers.includes("local")) inventories.push(await enumerateLocal(opts.localRoot, { hasLocalRecords: (records ?? []).some((r) => r.storageProvider === "local") || records === null }));
  if (opts.providers.includes("s3")) inventories.push(await enumerateS3(opts.s3Adapter));
  return analyze({ records, databaseFailure, inventories, requested: opts.providers, now: opts.now });
}

/** Texto curto para o terminal (as chaves exatas vêm no JSON). */
export function formatSummary(r: AuditReport): string {
  const lines = [`Auditoria de armazenamento — ${r.generatedAt}`, `Resultado: ${r.status.toUpperCase()} (código de saída ${r.exitCode})`, `Banco: ${r.database.complete ? `${r.database.recordsConsulted} registro(s) lido(s)` : `FALHOU — ${r.database.failure}`}`];
  for (const p of r.providers) lines.push(`Provedor ${p.provider}: ${!p.examined ? "não solicitado" : p.complete ? `${p.objectsEnumerated} objeto(s) enumerado(s), ${p.recordsConsulted} registro(s)` : `NÃO VERIFICADO — ${p.failure}`}`);
  lines.push(`Órfãos (objeto sem registro): ${r.totals.orphans} · Registros sem objeto: ${r.totals.recordsWithoutObject} · Metadados inconsistentes: ${r.totals.inconsistentMetadata} · Objetos não reconhecidos (informativo): ${r.totals.unrecognizedObjects} · Partes não verificadas: ${r.totals.unverified}`);
  for (const o of r.orphans.slice(0, 20)) lines.push(`  ÓRFÃO ${o.provider} ${o.key}`);
  for (const o of r.recordsWithoutObject.slice(0, 20)) lines.push(`  SEM OBJETO ${o.provider} ${o.key} (arquivo ${o.fileId}, organização ${o.organizationId})`);
  for (const o of r.inconsistentMetadata.slice(0, 20)) lines.push(`  METADADO ${o.kind} arquivo ${o.fileId}: ${o.detail}`);
  if (r.status === "incompleto") lines.push("ATENÇÃO: auditoria INCOMPLETA — nada do que não foi verificado pode ser tratado como ausente/limpo.");
  return lines.join("\n");
}
