// Codec PNG mínimo e SEM dependências (zlib do Node): decodifica o que o CDP (`Page.captureScreenshot`) e este módulo produzem e grava PNG RGBA.
// Suporta 8 bits (cinza, RGB, paleta, cinza+alfa, RGBA) sem entrelaçamento. O resto é recusado com um erro CLARO (nunca uma imagem "quase certa").
// Valida a assinatura, o CRC de cada bloco, o tamanho dos dados e a sequência IHDR/IDAT/IEND: arquivo truncado ou adulterado não vira imagem.
import { deflateSync, inflateSync } from "node:zlib";

export class PngError extends Error {
  constructor(code, message) { super(message); this.name = "PngError"; this.code = code; }
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, start = 0, end = buf.length) { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Lê só o cabeçalho (largura, altura, tipo de cor, profundidade) validando assinatura e CRC do IHDR. */
export function readHeader(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) throw new PngError("TRUNCATED", "arquivo menor que o cabeçalho PNG");
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError("BAD_SIGNATURE", "não é um PNG (assinatura inválida)");
  const len = buf.readUInt32BE(8); const type = buf.toString("latin1", 12, 16);
  if (type !== "IHDR" || len !== 13) throw new PngError("BAD_DATA", "primeiro bloco não é um IHDR válido");
  if (crc32(buf, 12, 12 + 4 + len) !== buf.readUInt32BE(12 + 4 + len)) throw new PngError("BAD_CRC", "CRC inválido no IHDR");
  const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20);
  return { width, height, bitDepth: buf[24], colorType: buf[25], compression: buf[26], filter: buf[27], interlace: buf[28] };
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decodifica para { width, height, data: Uint8ClampedArray RGBA }. */
export function decodePng(buf) {
  const h = readHeader(buf);
  if (h.width < 1 || h.height < 1 || h.width > 16384 || h.height > 65535) throw new PngError("BAD_DATA", `dimensões inválidas ${h.width}x${h.height}`);
  if (h.bitDepth !== 8) throw new PngError("UNSUPPORTED", `profundidade ${h.bitDepth} bits não suportada (só 8)`);
  if (!(h.colorType in CHANNELS)) throw new PngError("UNSUPPORTED", `tipo de cor ${h.colorType} não suportado`);
  if (h.interlace !== 0) throw new PngError("UNSUPPORTED", "PNG entrelaçado não suportado");
  if (h.compression !== 0 || h.filter !== 0) throw new PngError("BAD_DATA", "método de compressão/filtro desconhecido");
  const idat = []; let plte = null; let trns = null; let pos = 8; let ended = false;
  while (pos < buf.length) {
    if (pos + 12 > buf.length) throw new PngError("TRUNCATED", "bloco PNG cortado");
    const len = buf.readUInt32BE(pos); const type = buf.toString("latin1", pos + 4, pos + 8);
    if (pos + 12 + len > buf.length) throw new PngError("TRUNCATED", `bloco ${type} cortado`);
    if (crc32(buf, pos + 4, pos + 8 + len) !== buf.readUInt32BE(pos + 8 + len)) throw new PngError("BAD_CRC", `CRC inválido no bloco ${type}`);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IDAT") idat.push(body); else if (type === "PLTE") plte = body; else if (type === "tRNS") trns = body; else if (type === "IEND") { ended = true; break; }
    pos += 12 + len;
  }
  if (!ended) throw new PngError("TRUNCATED", "falta o bloco IEND");
  if (!idat.length) throw new PngError("BAD_DATA", "sem dados de imagem (IDAT)");
  let raw;
  try { raw = inflateSync(Buffer.concat(idat)); } catch (e) { throw new PngError("BAD_DATA", `dados de imagem corrompidos (${e.code ?? e.message})`); }
  const ch = CHANNELS[h.colorType]; const stride = h.width * ch;
  if (raw.length !== (stride + 1) * h.height) throw new PngError("BAD_DATA", `tamanho dos dados (${raw.length}) diverge do esperado (${(stride + 1) * h.height})`);
  if (h.colorType === 3 && !plte) throw new PngError("BAD_DATA", "imagem com paleta sem PLTE");
  const px = Buffer.alloc(stride * h.height);
  for (let y = 0; y < h.height; y++) {
    const ft = raw[y * (stride + 1)]; const src = y * (stride + 1) + 1; const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0; const b = y > 0 ? px[dst - stride + x] : 0; const c = x >= ch && y > 0 ? px[dst - stride + x - ch] : 0; const v = raw[src + x];
      let r;
      switch (ft) {
        case 0: r = v; break;
        case 1: r = v + a; break;
        case 2: r = v + b; break;
        case 3: r = v + ((a + b) >> 1); break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); r = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new PngError("BAD_DATA", `filtro de linha inválido (${ft})`);
      }
      px[dst + x] = r & 0xff;
    }
  }
  const data = new Uint8ClampedArray(h.width * h.height * 4);
  for (let i = 0, n = h.width * h.height; i < n; i++) {
    const o = i * 4;
    if (h.colorType === 6) { data[o] = px[i * 4]; data[o + 1] = px[i * 4 + 1]; data[o + 2] = px[i * 4 + 2]; data[o + 3] = px[i * 4 + 3]; }
    else if (h.colorType === 2) { data[o] = px[i * 3]; data[o + 1] = px[i * 3 + 1]; data[o + 2] = px[i * 3 + 2]; data[o + 3] = 255; }
    else if (h.colorType === 0) { data[o] = data[o + 1] = data[o + 2] = px[i]; data[o + 3] = 255; }
    else if (h.colorType === 4) { data[o] = data[o + 1] = data[o + 2] = px[i * 2]; data[o + 3] = px[i * 2 + 1]; }
    else { const idx = px[i]; if (idx * 3 + 2 >= plte.length) throw new PngError("BAD_DATA", "índice de paleta fora do intervalo"); data[o] = plte[idx * 3]; data[o + 1] = plte[idx * 3 + 1]; data[o + 2] = plte[idx * 3 + 2]; data[o + 3] = trns && idx < trns.length ? trns[idx] : 255; }
  }
  return { width: h.width, height: h.height, data };
}

function chunk(type, body) {
  const out = Buffer.alloc(12 + body.length); out.writeUInt32BE(body.length, 0); out.write(type, 4, "latin1"); body.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + body.length), 8 + body.length); return out;
}

/** Codifica RGBA 8 bits (determinístico: mesmo pixel → mesmos bytes → mesmo SHA-256). */
export function encodePng({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new PngError("BAD_DATA", "dimensões inválidas para codificar");
  if (data.length !== width * height * 4) throw new PngError("BAD_DATA", "buffer RGBA com tamanho inconsistente");
  const stride = width * 4; const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (stride + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
