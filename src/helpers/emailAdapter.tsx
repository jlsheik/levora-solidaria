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
import { logEvent, safeErrorCode } from "./opLog.js";

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type SendEmailResult =
  | { sent: true; messageId: string }
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

function buildEmailAdapter(): EmailAdapter {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM;

  if (host && port && user && pass && from) {
    return new SmtpEmailAdapter({ host, port, user, pass, from });
  }
  return new NotConfiguredEmailAdapter();
}

export const emailAdapter: EmailAdapter = buildEmailAdapter();
