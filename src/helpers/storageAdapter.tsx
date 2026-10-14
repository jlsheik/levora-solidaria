/**
 * Adaptador de armazenamento de arquivos. Padrão: disco local, privado por
 * padrão (fora de qualquer diretório servido como estático — só é
 * acessível pelo endpoint autenticado files-download_GET.ts, nunca por URL
 * pública direta). Funciona sem nenhuma credencial externa, ao contrário
 * do e-mail: não há "modo não configurado" aqui porque o disco local é uma
 * implementação real e completa, não um placeholder — mas quando
 * S3_BUCKET/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY estiverem
 * configuradas (funciona com AWS S3 ou qualquer serviço S3-compatível via
 * S3_ENDPOINT, ex.: Cloudflare R2, MinIO), o adaptador real de objeto é
 * usado no lugar, sem mudar nada do resto do sistema.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";

export interface StoredFileRef {
  storageProvider: "local" | "s3";
  storageKey: string;
}

export interface StorageAdapter {
  readonly provider: "local" | "s3";
  upload(input: { organizationId: number; buffer: Buffer; contentType: string }): Promise<StoredFileRef>;
  download(storageKey: string): Promise<Buffer>;
  /** Remove o objeto. Chave já inexistente = sucesso; qualquer outra falha do armazenamento LANÇA (o chamador decide como registrar — nada é engolido aqui). */
  delete(storageKey: string): Promise<void>;
  /** Só o adaptador S3 implementa: lista todas as chaves (somente leitura), para o diagnóstico de integridade (storageIntegrity.ts). */
  listKeys?(): Promise<string[]>;
}

const LOCAL_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads");

/** Raiz administrada do armazenamento em disco (a mesma do adaptador local), para o diagnóstico de integridade. */
export function localStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(process.cwd(), env.STORAGE_LOCAL_DIR || "storage/uploads");
}

class LocalDiskStorageAdapter implements StorageAdapter {
  readonly provider = "local" as const;

  async upload(input: { organizationId: number; buffer: Buffer; contentType: string }): Promise<StoredFileRef> {
    const orgDir = path.join(LOCAL_STORAGE_DIR, String(input.organizationId));
    await mkdir(orgDir, { recursive: true });
    const storageKey = `${input.organizationId}/${randomUUID()}`;
    await writeFile(path.join(LOCAL_STORAGE_DIR, storageKey), input.buffer);
    return { storageProvider: "local", storageKey };
  }

  async download(storageKey: string): Promise<Buffer> {
    return readFile(this.resolveSafePath(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.resolveSafePath(storageKey));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; // já não existe = objetivo cumprido
    }
  }

  // storageKey vem do banco (não de entrada de usuário diretamente), mas
  // confirma o formato `<organizationId>/<uuid>` (o mesmo que o adaptador S3 exige) e que o caminho final continua dentro do diretório de
  // upload antes de tocar no filesystem — defesa em profundidade contra
  // path traversal caso um storageKey malformado chegue aqui. Só a verificação "dentro da raiz" não bastava: `1/../2/<uuid>` resolve para
  // dentro da raiz, mas para o objeto de OUTRA organização.
  private resolveSafePath(storageKey: string): string {
    if (!MANAGED_KEY_SHAPE.test(storageKey)) throw new Error("Chave de armazenamento inválida");
    const resolved = path.resolve(LOCAL_STORAGE_DIR, storageKey);
    if (!resolved.startsWith(LOCAL_STORAGE_DIR + path.sep)) {
      throw new Error("Chave de armazenamento inválida");
    }
    return resolved;
  }
}

/**
 * Toda chave que o adaptador S3 cria tem o formato `<organizationId>/<uuid>`. O valor lido do banco é confirmado contra esse formato antes de ir à rede:
 * o SDK normaliza segmentos `..` no caminho, então uma chave adulterada (`1/../outra-org/x`) poderia apontar para OUTRO objeto do bucket. (O adaptador de
 * disco tem a guarda equivalente em `resolveSafePath`.)
 */
export const MANAGED_KEY_SHAPE = /^\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/; // mesmo formato nos dois provedores (disco: caminho relativo; S3: chave)
const S3_KEY_SHAPE = MANAGED_KEY_SHAPE;
/** A chave gravada em um registro de arquivo tem de ter o formato gerado pelo app E o prefixo da organização do próprio registro (`<organizationId>/<uuid>`). */
export function keyBelongsToOrganization(storageKey: string, organizationId: number): boolean {
  return MANAGED_KEY_SHAPE.test(storageKey) && storageKey.startsWith(`${organizationId}/`);
}
function assertS3KeyShape(key: string): void {
  if (!S3_KEY_SHAPE.test(key)) throw new Error("Chave de armazenamento inválida");
}

class S3StorageAdapter implements StorageAdapter {
  readonly provider = "s3" as const;
  private bucket: string;
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;

  constructor(config: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string; requestTimeoutMs?: number }) {
    this.bucket = config.bucket;
    // Import dinâmico: só instancia o cliente e carrega o SDK de fato
    // quando S3 está configurado — em ambientes que só usam disco local (a
    // maioria em desenvolvimento), nada do AWS SDK é executado.
    this.clientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: config.region,
          endpoint: config.endpoint,
          forcePathStyle: Boolean(config.endpoint), // necessário para R2/MinIO
          // Sem isto o SDK espera para sempre um S3 que não responde (ou um corpo que trava no meio) e a requisição de download ficava pendurada.
          // `socketTimeout` = inatividade do socket (mata resposta que nunca chega E corpo que trava no meio); `requestTimeout` do SDK só emite aviso, não interrompe.
          requestHandler: { connectionTimeout: Math.min(config.requestTimeoutMs ?? 30_000, 10_000), socketTimeout: config.requestTimeoutMs ?? 30_000 },
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        })
    );
  }

  async upload(input: { organizationId: number; buffer: Buffer; contentType: string }): Promise<StoredFileRef> {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    const storageKey = `${input.organizationId}/${randomUUID()}`;
    await client.send(new PutObjectCommand({ Bucket: this.bucket, Key: storageKey, Body: input.buffer, ContentType: input.contentType }));
    return { storageProvider: "s3", storageKey };
  }

  async download(storageKey: string): Promise<Buffer> {
    assertS3KeyShape(storageKey);
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    const result = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /**
   * Lista TODAS as chaves do bucket (só `ListObjectsV2`, todas as páginas) para o diagnóstico de integridade. Qualquer falha, página sem token de continuação, token repetido
   * ou resposta inválida LANÇA: uma listagem parcial nunca é devolvida como completa.
   */
  async listKeys(): Promise<string[]> {
    const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    const keys: string[] = []; const seenTokens = new Set<string>(); let token: string | undefined;
    for (let page = 0; page < 100_000; page++) {
      const res = await client.send(new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }));
      for (const o of res.Contents ?? []) { if (typeof o.Key !== "string") throw new Error("Resposta de listagem inválida"); keys.push(o.Key); }
      if (!res.IsTruncated) return keys;
      const next = res.NextContinuationToken;
      if (!next || seenTokens.has(next)) throw new Error("Paginação da listagem inconsistente");
      seenTokens.add(next); token = next;
    }
    throw new Error("Listagem excedeu o limite de páginas");
  }

  async delete(storageKey: string): Promise<void> {
    if (!S3_KEY_SHAPE.test(storageKey)) return; // nunca vai à rede com chave fora do formato (o app só cria chaves nesse formato)
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey })); // DeleteObject de chave inexistente responde 204; falhas reais propagam
  }
}

/** Exportada para os testes construírem o adaptador S3 REAL contra um endpoint local (test/storageS3.test.ts); o app usa só `storageAdapter` abaixo. */
export function buildStorageAdapter(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const bucket = env.S3_BUCKET;
  const region = env.S3_REGION;
  const accessKeyId = env.S3_ACCESS_KEY_ID;
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY;

  if (bucket && region && accessKeyId && secretAccessKey) {
    return new S3StorageAdapter({ bucket, region, accessKeyId, secretAccessKey, endpoint: env.S3_ENDPOINT, requestTimeoutMs: Number(env.S3_REQUEST_TIMEOUT_MS) > 0 ? Number(env.S3_REQUEST_TIMEOUT_MS) : undefined });
  }
  return new LocalDiskStorageAdapter();
}

export const storageAdapter: StorageAdapter = buildStorageAdapter();

/**
 * Erro CONTROLADO de provedor: o valor gravado em `files.storageProvider` é desconhecido, ou o provedor existe mas não está configurado neste ambiente
 * (ex.: arquivo que foi para o S3 e o processo atual subiu sem as variáveis S3_*). Nunca há fallback para outro armazenamento: ler a chave de um provedor
 * no outro seria ler (ou apagar) o objeto errado.
 */
export class StorageProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageProviderError";
  }
}

const S3_ENV_KEYS = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
const byProviderCache = new Map<string, StorageAdapter>();

/**
 * Adaptador do provedor GRAVADO no registro do arquivo (`files.storageProvider`, escrito no upload com `stored.storageProvider`), e não o do provedor
 * configurado agora: assim, trocar o armazenamento padrão entre disco e S3 não torna os arquivos antigos inacessíveis. Valor desconhecido ou provedor
 * sem configuração lança `StorageProviderError`. Chame SÓ depois de autorizar a requisição (nada toca o armazenamento antes disso).
 */
export function adapterForProvider(provider: string, env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  if (provider !== "local" && provider !== "s3") throw new StorageProviderError(`Provedor de armazenamento desconhecido: ${JSON.stringify(String(provider).slice(0, 40))}`);
  if (env === process.env && storageAdapter.provider === provider) return storageAdapter;
  if (provider === "local") {
    let a = byProviderCache.get("local"); if (!a) { a = new LocalDiskStorageAdapter(); byProviderCache.set("local", a); } return a;
  }
  if (S3_ENV_KEYS.some((k) => !env[k])) throw new StorageProviderError("O provedor s3 não está configurado neste ambiente");
  const cacheKey = `s3|${S3_ENV_KEYS.map((k) => env[k]).join("|")}|${env.S3_ENDPOINT ?? ""}`;
  let a = env === process.env ? byProviderCache.get(cacheKey) : undefined;
  if (!a) { a = buildStorageAdapter(env); if (env === process.env) byProviderCache.set(cacheKey, a); }
  return a;
}
