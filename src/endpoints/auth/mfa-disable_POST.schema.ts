import { authRequest } from "../../helpers/authClient.js";

export const postMfaDisable = () => authRequest<{ message: string }>("POST", "mfa-disable", {});
