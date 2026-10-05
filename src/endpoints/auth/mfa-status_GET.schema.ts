import { authRequest } from "../../helpers/authClient.js";

export type OutputType = { active: boolean; pending: boolean; recoveryCodesRemaining: number; requiredByPolicy: boolean; recentlyAuthenticated: boolean };

export const getMfaStatus = () => authRequest<OutputType>("GET", "mfa-status");
