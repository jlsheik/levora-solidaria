import {
  setServerSession,
  NotAuthenticatedError,
} from "../../helpers/getSetServerSession.js";
import { User } from "../../helpers/User.js";
import { getServerUserSession } from "../../helpers/getServerUserSession.js";
import superjson from "superjson";

export async function handle(request: Request) {
  try {
    const { user, session } = await getServerUserSession(request);

    // Create response with user data
    const response = new Response(
      superjson.stringify({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          role: user.role,
          platformLevel: user.platformLevel,
        } satisfies User,
      }),
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Update the session cookie with the new lastAccessed time
    await setServerSession(
      response,
      {
        id: session.id,
        createdAt: session.createdAt,
        lastAccessed: session.lastAccessed.getTime(),
      },
      // Renova só o cookie/ocioso; o teto absoluto da sessão NUNCA é estendido (sessionPolicy.tsx).
      { absoluteExpiresAt: session.absoluteExpiresAt }
    );

    return response;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return new Response(
        superjson.stringify({ error: "Not authenticated" }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
          },
        }
      );
    }
    console.error("Session validation error:", error);
    return new Response(
      superjson.stringify({ error: "Session validation failed" }),
      {
        status: 400,
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
  }
}
