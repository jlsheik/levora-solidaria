/**
 * Análise antimalware de arquivos enviados. Contrato desacoplado do provedor (`FileScanner`), uma implementação REAL (cliente do protocolo do ClamAV `clamd`, `INSTREAM`) e modo de operação
 * explícito. Regras invioláveis:
 *  - o resultado só vale como "limpo" se o scanner RESPONDEU "OK"; timeout, erro de rede, resposta malformada, resposta desconhecida ou scanner ausente = `indisponivel` (nunca aprovação);
 *  - o modo é OBRIGATÓRIO em produção (`NODE_ENV=production`) mesmo que nada esteja configurado: sem scanner, nada é liberado (falha fechada). Só `FILE_SCAN_MODE=disabled` fora de produção
 *    dispensa a análise, e o arquivo fica marcado `dispensado` (não `aprovado`);
 *  - o conteúdo do arquivo nunca é registrado em log; a mensagem devolvida ao usuário é genérica.
 * clamd NÃO autentica conexões TCP: o serviço deve ficar em rede privada (nunca exposto à Internet). Ver docs/ANTIMALWARE_ARQUIVOS.md.
 */
import net from "node:net";

export type ScanOutcome =
  | { status: "limpo"; engine: string | null }
  | { status: "infectado"; signature: string; engine: string | null }
  | { status: "indisponivel"; reason: ScanUnavailableReason };

export type ScanUnavailableReason = "scanner_nao_configurado" | "timeout" | "erro_de_conexao" | "resposta_invalida" | "resposta_desconhecida" | "arquivo_grande_demais" | "erro_inesperado";

export interface FileScanner {
  readonly name: string;
  scan(buffer: Buffer): Promise<ScanOutcome>;
}

export type ScanMode = "required" | "disabled";

export function getScanMode(env: NodeJS.ProcessEnv = process.env): ScanMode {
  if (env.NODE_ENV === "production") return "required"; // produção nunca roda sem análise, nem por engano de configuração
  const explicit = (env.FILE_SCAN_MODE ?? "").toLowerCase();
  if (explicit === "required") return "required";
  return "disabled";
}

/** Situações em que o arquivo pode ser SERVIDO. `dispensado`/`legado` só fora do modo obrigatório. */
export function isReleasable(scanStatus: string, mode: ScanMode = getScanMode()): boolean {
  if (scanStatus === "aprovado") return true;
  if (mode === "required") return false;
  return scanStatus === "dispensado" || scanStatus === "legado_nao_analisado";
}

/** Scanner usado quando a análise é obrigatória mas nada está configurado: SEMPRE indisponível (falha fechada). */
export class UnconfiguredScanner implements FileScanner {
  readonly name = "nao-configurado";
  async scan(): Promise<ScanOutcome> {
    return { status: "indisponivel", reason: "scanner_nao_configurado" };
  }
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Limite que o servidor clamd aceita no stream (StreamMaxLength); acima disso devolve erro. */
  maxBytes: number;
}

/** Cliente do protocolo clamd (`zINSTREAM`, `zVERSION`). Uma conexão por análise; tudo com tempo limite. */
export class ClamdScanner implements FileScanner {
  readonly name = "clamd";
  constructor(private readonly options: ClamdOptions) {}

  private talk(commands: (socket: net.Socket) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.options.host, port: this.options.port });
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (err: Error | null, value?: string) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(value ?? "");
      };
      socket.setTimeout(this.options.timeoutMs, () => done(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
      socket.on("error", (e) => done(e));
      socket.on("data", (d) => chunks.push(d));
      socket.on("end", () => done(null, Buffer.concat(chunks).toString("utf8")));
      socket.on("close", () => done(null, Buffer.concat(chunks).toString("utf8")));
      socket.on("connect", () => commands(socket));
    });
  }

  async version(): Promise<string | null> {
    try {
      const r = (await this.talk((s) => s.write("zVERSION\0"))).replace(/\0/g, "").trim();
      return r || null;
    } catch {
      return null;
    }
  }

  async scan(buffer: Buffer): Promise<ScanOutcome> {
    if (buffer.length > this.options.maxBytes) return { status: "indisponivel", reason: "arquivo_grande_demais" };
    let reply: string;
    try {
      reply = await this.talk((s) => {
        s.write("zINSTREAM\0");
        for (let off = 0; off < buffer.length; off += 64 * 1024) {
          const chunk = buffer.subarray(off, Math.min(off + 64 * 1024, buffer.length));
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length, 0);
          s.write(len);
          s.write(chunk);
        }
        s.write(Buffer.alloc(4)); // chunk de tamanho zero encerra o stream
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      return { status: "indisponivel", reason: code === "TIMEOUT" ? "timeout" : "erro_de_conexao" };
    }
    return parseClamdReply(reply, await this.version());
  }
}

/** Interpreta a resposta do clamd. SÓ "stream: OK" é limpo; "<assinatura> FOUND" é infectado; qualquer outra coisa é indisponível. */
export function parseClamdReply(raw: string, engine: string | null): ScanOutcome {
  const reply = raw.replace(/\0/g, "").trim();
  if (reply === "") return { status: "indisponivel", reason: "resposta_invalida" };
  const lines = reply.split(/\r?\n/);
  if (lines.length !== 1) return { status: "indisponivel", reason: "resposta_invalida" };
  const m = /^stream:\s*(.+)$/.exec(reply);
  if (!m) return { status: "indisponivel", reason: "resposta_invalida" };
  const body = m[1].trim();
  if (body === "OK") return { status: "limpo", engine };
  const found = /^(.{1,200}) FOUND$/.exec(body);
  if (found) return { status: "infectado", signature: found[1].replace(/[^\w.\-:/ ]/g, "?"), engine };
  return { status: "indisponivel", reason: /ERROR$/.test(body) ? "resposta_desconhecida" : "resposta_desconhecida" };
}

let override: FileScanner | null | undefined;
/** SOMENTE testes: força um scanner (ou `null` para "nenhum"); `undefined` volta à configuração real. */
export function setFileScannerForTests(scanner: FileScanner | null | undefined) {
  override = scanner;
}

export function buildFileScanner(env: NodeJS.ProcessEnv = process.env): FileScanner {
  if (override !== undefined) return override ?? new UnconfiguredScanner();
  const host = env.CLAMD_HOST;
  if (!host) return new UnconfiguredScanner();
  const port = Number(env.CLAMD_PORT ?? 3310);
  const timeoutMs = Number(env.CLAMD_TIMEOUT_MS ?? 15000);
  const maxBytes = Number(env.CLAMD_MAX_BYTES ?? 25 * 1024 * 1024);
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return new UnconfiguredScanner();
  return new ClamdScanner({ host, port, timeoutMs, maxBytes });
}
