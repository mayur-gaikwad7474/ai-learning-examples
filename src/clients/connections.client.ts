// connection-service owns the social accounts connected to a workspace.
import type { Identity } from '../schemas/identity.schema.ts'
import { accountListResponseSchema } from '../schemas/accounts.schema.ts'
import type { ConnectedAccount } from '../schemas/accounts.schema.ts'
import { createServiceClient } from './http.ts'

const request = createServiceClient({
    tag: 'connections',
    name: 'the accounts service',
    baseUrl: process.env.CONNECTIONS_SERVICE_URL ?? 'http://localhost:4002',
})

export const fetchConnectedAccounts = async (identity: Identity, abortSignal?: AbortSignal): Promise<ConnectedAccount[]> => {
    const body = await request(`/v1/accounts/${encodeURIComponent(identity.workspaceId)}`, accountListResponseSchema, {
        identity,
        abortSignal,
    })
    return body.data.accounts
}
