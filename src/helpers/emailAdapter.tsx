/**
 * Adaptador real de e-mail (SMTP), configurado por variáveis de ambiente.
 * Sem credenciais configuradas, a plataforma continua funcionando — o
 * convite é criado normalmente e devolvido na resposta da API para quem
 * convidou compartilhar manualmente — mas a interface NUNCA finge que um
 * e-mail foi enviado quando não foi (regra do master prompt contra
 * "fake features": nada de "e-mail enviado" sem confirmação real do
 * provedor).
 */
import nodemailer, { type Transporter } from "nodemailer";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logEvent, safeErrorCode } from "./opLog.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendEmailResult =
  | { sent: true; messageId: string; synthetic?: true }
  | { sent: false; reason: "not_configured" }
  | { sent: false; reason: "provider_error"; error: string };

export interface EmailAdapter {
  readonly isConfigured: boolean;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

class SmtpEmailAdapter implements EmailAdapter {
  readonly isConfigured = true;
  private transporter: Transporter;
  private from: string;

  constructor(config: { host: string; port: number; user: string; pass: string; from: string }) {
    this.from = config.from;
    this.transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.port === 465,
      auth: { user: config.user, pass: config.pass },
    });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
      });
      return { sent: true, messageId: info.messageId };
    } catch (error) {
      // M46: só um código seguro (o objeto de erro do SMTP pode carregar host, destinatário e trechos da resposta do servidor).
      logEvent({ event: "email_send", status: "falha", errorCode: safeErrorCode(error) });
      return { sent: false, reason: "provider_error", error: error instanceof Error ? error.message : String(error) };
    }
  }
}

class NotConfiguredEmailAdapter implements EmailAdapter {
  readonly isConfigured = false;
  private warned = false;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!this.warned) {
      console.warn(
        "[email] SMTP não configurado (defina SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS e SMTP_FROM no .env) — e-mails não serão enviados de verdade. A ação que originou este e-mail continua registrada normalmente; quem a realizou precisa compartilhar a informação por outro canal."
      );
      this.warned = true;
    }
    // M47: o log NÃO traz destinatário nem assunto (e-mail é dado pessoal; o assunto pode citar nomes). Só o fato de que não foi enviado.
    logEvent({ event: "email_send", status: "ignorado", context: { reason: "smtp_nao_configurado" } });
    return { sent: false, reason: "not_configured" };
  }
}

/** Mensagens "enviadas" pelo transporte sintético (F1). Só memória do processo; nenhuma saída de rede. */
export const syntheticOutbox: Array<{ id: string; to: string; subject: string; text: string; at: string }> = [];

/**
 * Transporte SINTÉTICO (F1): para testes e desenvolvimento isolado. NUNCA abre conexão de rede: guarda a mensagem em memória e, se `SYNTHETIC_EMAIL_DIR`
 * estiver definido, em um arquivo JSON local (para o navegador de teste ler o link). Ligado só por `EMAIL_TRANSPORT=synthetic` e **recusado em produção**.
 * O resultado traz `synthetic: true`: nada aqui é entrega real nem prova de entrega por provedor.
 */
class SyntheticEmailAdapter implements EmailAdapter {
  readonly isConfigured = true;
  constructor(private readonly dir?: string) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const id = `synthetic-${randomUUID()}`;
    const record = { id, to: input.to, subject: input.subject, text: input.text, at: new Date().toISOString() };
    syntheticOutbox.push(record);
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${record.at.replace(/[:.]/g, "-")}-${id}.json`), JSON.stringify(record, null, 2), "utf8");
    }
    logEvent({ event: "email_send", status: "ok", context: { transport: "synthetic" } });
    return { sent: true, messageId: id, synthetic: true };
  }
}

export function buildEmailAdapter(env: NodeJS.ProcessEnv = process.env): EmailAdapter {
  if (env.EMAIL_TRANSPORT === "synthetic") {
    if (env.NODE_ENV === "production") {
      logEvent({ event: "email_send", status: "ignorado", context: { reason: "transporte_sintetico_recusado_em_producao" } });
    } else {
      return new SyntheticEmailAdapter(env.SYNTHETIC_EMAIL_DIR || undefined);
    }
  }
  const host = env.SMTP_HOST;
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : undefined;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  const from = env.SMTP_FROM;

  if (host && port && user && pass && from) {
    return new SmtpEmailAdapter({ host, port, user, pass, from });
  }
  return new NotConfiguredEmailAdapter();
}

export const emailAdapter: EmailAdapter = buildEmailAdapter();
