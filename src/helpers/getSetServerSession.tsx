import { jwtVerify, SignJWT } from "jose";

const encoder = new TextEncoder();
const secret = process.env.JWT_SECRET;

export const SessionExpirationSeconds = 60 * 60 * 24 * 7; // 1 week
// Probability to run cleanup (10%)
export const CleanupProbability = 0.1;

// Only send the ID in the cookie to the client
// We should store id -> user id and user data mapping in our database for max security
export interface Session {
  // this should be a crypto random string
  id: string;
  createdAt: number;
  lastAccessed: number;

  // Whether the user needs to change their password
  // Useful for password reset or setting up new user with initial password
  passwordChangeRequired?: boolean;
}

const CookieName = "floot_built_app_session";

export class NotAuthenticatedError extends Error {
  constructor(message?: string) {
    super(message ?? "Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

/**
 * Returns the user session or throw an error. Make sure to handle the error (return a proper request)
 */
export async function getServerSessionOrThrow(
  request: Request
): Promise<Session> {
  // Note: if session is valid, also consider making the cookie rolling by using setSession

  const cookieHeader = request.headers.get("cookie") || "";
  const cookies = cookieHeader
    .split(";")
    .reduce((cookies: Record<string, string>, cookie) => {
      const [name, value] = cookie.trim().split("=");
      if (name && value) {
        cookies[name] = decodeURIComponent(value);
      }
      return cookies;
    }, {});
  const sessionCookie = cookies[CookieName];

  if (!sessionCookie) {
    throw new NotAuthenticatedError();
  }
  try {
    const { payload } = await jwtVerify(sessionCookie, encoder.encode(secret));
    return {
      id: payload.id as string,
      createdAt: payload.createdAt as number,
      lastAccessed: payload.lastAccessed as number,
      passwordChangeRequired: payload.passwordChangeRequired as boolean,
    };
  } catch (error) {
    throw new NotAuthenticatedError();
  }
}

export async function setServerSession(
  response: Response,
  session: Session,
  options: { absoluteExpiresAt?: Date } = {}
): Promise<void> {
  // Fase 89: o cookie/JWT nunca vive além do teto absoluto da sessão (a linha em `sessions` é a autoridade; ver
  // sessionPolicy.tsx). Sem `absoluteExpiresAt` mantém-se o comportamento anterior (7 dias).
  const nowSeconds = Math.floor(Date.now() / 1000);
  let lifetimeSeconds = SessionExpirationSeconds;
  if (options.absoluteExpiresAt) {
    const remaining = Math.floor(options.absoluteExpiresAt.getTime() / 1000) - nowSeconds;
    lifetimeSeconds = Math.max(1, Math.min(SessionExpirationSeconds, remaining));
  }
  // Precisa bater com o Max-Age do cookie abaixo (SessionExpirationSeconds,
  // 7 dias) — antes disso o JWT interno expirava em "1d" fixo enquanto o
  // cookie dizia durar 7 dias, então a sessão real caía em 1 dia sem
  // nenhum aviso (a verificação do JWT falhava antes do cookie expirar).
  // Ver docs/SECURITY.md.
  const token = await new SignJWT({
    id: session.id,
    createdAt: session.createdAt,
    lastAccessed: session.lastAccessed,
    passwordChangeRequired: session.passwordChangeRequired,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(nowSeconds + lifetimeSeconds)
    .sign(encoder.encode(secret));

  const cookieValue = [
    `${CookieName}=${token}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${lifetimeSeconds}`,
  ].join("; ");

  response.headers.set("Set-Cookie", cookieValue);
}

export function clearServerSession(response: Response) {
  // Clear the session cookie by setting an expired date
  const cookieValue = [
    `${CookieName}=`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=0", // Expire immediately
  ].join("; ");

  response.headers.set("Set-Cookie", cookieValue);
}

