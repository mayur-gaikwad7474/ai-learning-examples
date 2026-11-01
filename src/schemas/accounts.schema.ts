// Schemas for social accounts. Inputs are what the model sends to a tool; outputs are what
// connection-service answers.
import { z } from 'zod';

// ── Inputs (tools) ──────────────────────────────────────────────────────────────────────────────

// The model calls a list tool for two reasons: the user wants to see the list, or the model needs
// it for another step (finding an account ID). Only the model knows which, so it says so here.
// The app shows the result as cards only when this is true.
export const showToUserSchema = z
  .boolean()
  .describe(
    'true when the user asked to see these results. false when you only need them for another step, such as finding an account ID before scheduling.',
  );

export const listAccountsInputSchema = z.object({
  showToUser: showToUserSchema,
});

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
