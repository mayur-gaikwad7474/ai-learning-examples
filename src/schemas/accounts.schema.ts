// Schemas for social accounts. Inputs are what the model sends to a tool; outputs are what
// connection-service answers.
import { z } from 'zod';

// ── Inputs (tools) ──────────────────────────────────────────────────────────────────────────────

export const listAccountsInputSchema = z.object({});

// ── Outputs (connection-service) ────────────────────────────────────────────────────────────────
// We only read the fields we use, and check them, because these responses come from other services.

export const connectedAccountSchema = z.object({
  _id: z.string(),
  socialId: z.string(),
  name: z.string(),
  accountType: z.string(),
  profileURL: z.string().optional(),
  isAccountTokensExpired: z.boolean().optional(),
});

export const accountListResponseSchema = z.object({
  data: z.object({
    accounts: z.array(connectedAccountSchema),
  }),
});

export type ConnectedAccount = z.infer<typeof connectedAccountSchema>;
