import { tool } from 'ai';
import { identitySchema } from '../schemas/identity.schema.ts';
import { listAccountsInputSchema } from '../schemas/accounts.schema.ts';
import { fetchConnectedAccounts } from '../clients/connections.client.ts';

// `inputSchema` is what the model fills in. `contextSchema` is what our own code passes in
// (the identity from the gateway), so the model cannot choose or change it.
export const listAccounts = tool({
  description: `Get the social media accounts connected to the current workspace in Creatosaurus.
     Accounts with needsReconnect: true cannot publish until the user reconnects them.`,
  inputSchema: listAccountsInputSchema,
  contextSchema: identitySchema,
  execute: async (_input, { context, abortSignal }) => {
    // A thrown error (service down, bad response) is sent to the model as a tool error.
    const connected = await fetchConnectedAccounts(context, abortSignal);

    // Give the model only what it needs to pick an account, plus the profile image so the app can
    // show account cards. socialIds stay out. Older accounts can have no image, so send null then.
    const accounts = connected.map((account) => ({
      id: account._id,
      name: account.name,
      platform: account.accountType,
      profileURL: account.profileURL || null,
      needsReconnect: account.isAccountTokensExpired ?? false,
    }));

    if (accounts.length === 0) {
      return {
        success: false,
        error:
          'No social accounts are connected to this workspace. Connect one in Creatosaurus under Brand & Social Accounts first.',
      };
    }

    return { success: true, accounts };
  },
});
