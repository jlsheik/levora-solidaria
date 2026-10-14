/**
 * Diretório de armazenamento EXCLUSIVO de cada execução da suíte (não é um teste). Antes, todos os testes de upload usavam `storage/uploads-test` do repositório: um
 * deles (`allocationsReceiveProof.test.ts`) enviava arquivos reais e não limpava, deixando 2 arquivos a cada execução, e duas execuções simultâneas colidiam na mesma raiz.
 * Agora o globalSetup cria um diretório novo em `os.tmpdir()` por execução, aponta `STORAGE_LOCAL_DIR` para ele ANTES de os workers subirem e o remove no fim
 * (inclusive quando a suíte falha). Nunca se apaga um diretório que não tenha sido criado por esta função.
 */
import { mkdtempSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const RUN_STORAGE_PREFIX = "levora-test-storage-";

export function createRunStorageDir(base: string = tmpdir()): string {
  return mkdtempSync(path.join(base, RUN_STORAGE_PREFIX));
}

/** Só remove diretórios que esta função poderia ter criado (dentro de `base`, com o prefixo certo). Devolve o que ficou dentro, para relato. */
export function removeRunStorageDir(dir: string, base: string = tmpdir()): { removed: boolean; leftoverFiles: number; reason?: string } {
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) !== path.resolve(base) || !path.basename(resolved).startsWith(RUN_STORAGE_PREFIX)) return { removed: false, leftoverFiles: 0, reason: "não é um diretório criado por createRunStorageDir" };
  if (!existsSync(resolved)) return { removed: true, leftoverFiles: 0 };
  let leftoverFiles = 0;
  const count = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) count(p); else if (statSync(p).isFile()) leftoverFiles++; } };
  try { count(resolved); } catch { /* contagem é informativa */ }
  rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  return { removed: !existsSync(resolved), leftoverFiles };
}
