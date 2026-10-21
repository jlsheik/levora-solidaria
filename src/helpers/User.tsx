// If you need to udpate this type, make sure to also update
// components/ProtectedRoute
// endpoints/auth/login_with_password_POST
// endpoints/auth/register_with_password_POST
// endpoints/auth/session_GET
// helpers/getServerUserSession
// together with this in one toolcall.

export interface User {
  id: number;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  // Derivado de `platformLevel` (compatibilidade com o frontend): "admin" ⇔ possui platform_access ativo.
  // A autorização de plataforma NÃO vem deste campo — ver helpers/platformAccess.
  role: "admin" | "user";
  platformLevel: "owner" | "admin" | null;
}
