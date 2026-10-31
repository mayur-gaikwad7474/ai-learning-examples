// The one place that talks HTTP to other Creatosaurus services. Every client goes through
// `createServiceClient`, so timeouts, identity headers, logging and response checks work the same
// way everywhere.
import { z } from 'zod'
import type { Identity } from '../schemas/identity.schema.ts'
import { serviceErrorResponseSchema } from '../schemas/serviceError.schema.ts'

const REQUEST_TIMEOUT_MS = 10_000

// Why a request failed. Tools need this to pick what to tell the model: a 4xx message is written for
// people and can be repeated, but after a network error or a 5xx a write may or may not have happened.
//   unreachable  the request never got an answer (network failure or timeout)
//   rejected     the service answered 4xx
//   failed       the service answered 5xx
//   unreadable   the service answered 2xx with a body we could not read
export type ServiceErrorKind = 'unreachable' | 'rejected' | 'failed' | 'unreadable'

export class ServiceError extends Error {
    readonly kind: ServiceErrorKind
    readonly status: number | null

    constructor(kind: ServiceErrorKind, status: number | null, message: string) {
        super(message)
        this.name = 'ServiceError'
        this.kind = kind
        this.status = status
    }
}

const identityHeaders = (identity: Identity) => ({
    'X-User-Id': identity.userId,
    'X-Workspace-Id': identity.workspaceId,
    'X-Roles': identity.roles.join(','),
})

const withTimeout = (abortSignal?: AbortSignal) =>
    AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(abortSignal ? [abortSignal] : [])])

type Service = {
    tag: string // for our logs, e.g. 'post-scheduler'
    name: string // for messages the model may repeat, e.g. 'the post scheduler'
    baseUrl: string
}

type RequestOptions = {
    identity: Identity
    method?: 'GET' | 'POST'
    body?: unknown
    headers?: Record<string, string>
    abortSignal?: AbortSignal
}

// Returns a function that calls one service with the gateway's identity and checks the response
// against `schema`. We only read the fields we use, and check them, because these responses come
// from other services. Details go to our logs; the thrown message is safe to show the model.
export const createServiceClient = (service: Service) =>
    async <Schema extends z.ZodType>(path: string, schema: Schema, options: RequestOptions): Promise<z.infer<Schema>> => {
        const { identity, method = 'GET', body, headers, abortSignal } = options
        const url = `${service.baseUrl}${path}`

        let response: Response
        try {
            response = await fetch(url, {
                method,
                headers: {
                    ...identityHeaders(identity),
                    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
                    ...headers,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: withTimeout(abortSignal),
            })
        } catch (error) {
            // The caller cancelled: let that through as it is, it is not the service's fault.
            if (abortSignal?.aborted) throw error
            console.error(`[${service.tag}] ${method} ${url} failed:`, error)
            throw new ServiceError('unreachable', null, `Could not reach ${service.name}. Please try again.`)
        }

        const json = await response.json().catch(() => null)

        if (!response.ok) {
            console.error(`[${service.tag}] ${method} ${url} answered ${response.status}:`, JSON.stringify(json))

            if (response.status < 500) {
                // A message in any other shape falls back to the status.
                const message = serviceErrorResponseSchema.safeParse(json).data?.error.message
                throw new ServiceError('rejected', response.status, message ?? `The request was rejected by ${service.name} (status ${response.status}).`)
            }
            throw new ServiceError('failed', response.status, `Something went wrong in ${service.name} (status ${response.status}).`)
        }

        const parsed = schema.safeParse(json)
        if (!parsed.success) {
            console.error(`[${service.tag}] unexpected response from ${method} ${url}:`, z.prettifyError(parsed.error))
            throw new ServiceError('unreadable', response.status, `The response from ${service.name} could not be read.`)
        }

        return parsed.data
    }
