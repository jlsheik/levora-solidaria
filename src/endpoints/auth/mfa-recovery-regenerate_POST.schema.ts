import { authRequest } from "../../helpers/authClient.js";

export type OutputType = { recoveryCodes: string[] };

export const postMfaRecoveryRegenerate = () => authRequest<OutputType>("POST", "mfa-recovery-regenerate", {});
