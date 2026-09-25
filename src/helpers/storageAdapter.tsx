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
  delete(storageKey: string): Promise<void>;
}

const LOCAL_STORAGE_DIR = path.resolve(process.cwd(), process.env.STORAGE_LOCAL_DIR || "storage/uploads");

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
    await unlink(this.resolveSafePath(storageKey)).catch(() => undefined);
  }

  // storageKey vem do banco (não de entrada de usuário diretamente), mas
  // resolve e confirma que o caminho final continua dentro do diretório de
  // upload antes de tocar no filesystem — defesa em profundidade contra
  // path traversal caso um storageKey malformado chegue aqui.
  private resolveSafePath(storageKey: string): string {
    const resolved = path.resolve(LOCAL_STORAGE_DIR, storageKey);
    if (!resolved.startsWith(LOCAL_STORAGE_DIR + path.sep)) {
      throw new Error("Chave de armazenamento inválida");
    }
    return resolved;
  }
}

class S3StorageAdapter implements StorageAdapter {
  readonly provider = "s3" as const;
  private bucket: string;
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;

  constructor(config: { bucket: string; region: string; accessKeyId: string; secretAccessKey: string; endpoint?: string }) {
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
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    const result = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }));
    const chunks: Buffer[] = [];
    for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async delete(storageKey: string): Promise<void> {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey })).catch(() => undefined);
  }
}

function buildStorageAdapter(): StorageAdapter {
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (bucket && region && accessKeyId && secretAccessKey) {
    return new S3StorageAdapter({ bucket, region, accessKeyId, secretAccessKey, endpoint: process.env.S3_ENDPOINT });
  }
  return new LocalDiskStorageAdapter();
}

export const storageAdapter: StorageAdapter = buildStorageAdapter();
