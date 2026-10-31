// post-scheduler-service owns posts and their schedules.
import type { Identity } from '../schemas/identity.schema.ts'
import type { ConnectedAccount } from '../schemas/accounts.schema.ts'
import { calendarPageResponseSchema, createdPostResponseSchema } from '../schemas/posts.schema.ts'
import { createServiceClient } from './http.ts'

const request = createServiceClient({
    tag: 'post-scheduler',
    name: 'the post scheduler',
    baseUrl: process.env.POST_SCHEDULER_SERVICE_URL ?? 'http://localhost:4005',
})

// post-scheduler's most posts per calendar page.
const CALENDAR_MAX_LIMIT = 100

export type NewScheduledPost = {
    account: Pick<ConnectedAccount, 'socialId' | 'accountType' | 'name'>
    caption: string
    mediaIds: string[]
    scheduleTime: string
    timeZone: string
}

// Builds the legacy post body the app's post editor sends: the same media goes on the post and on
// its one account. `idempotencyKey` makes a retried request return the first post instead of
// creating a second one.
export const createScheduledPost = async (
    identity: Identity,
    post: NewScheduledPost,
    options: { idempotencyKey: string; abortSignal?: AbortSignal },
) => {
    const media = post.mediaIds.map((mediaId) => ({ mediaId }))
    const { account } = post

    const body = await request('/v1/posts', createdPostResponseSchema, {
        identity,
        method: 'POST',
        headers: { 'Idempotency-Key': options.idempotencyKey },
        body: {
            workspaceId: identity.workspaceId,
            status: 'queue',
            shareNow: false,
            scheduleTime: post.scheduleTime,
            timeZone: post.timeZone,
            draftMessage: post.caption,
            draftMedia: media,
            accounts: [{ socialId: account.socialId, accountType: account.accountType, name: account.name, caption: post.caption, mediaURL: media }],
        },
        abortSignal: options.abortSignal,
    })
    return body.data
}

// Fetches one page only: up to 100 posts is enough for a chat answer, and `hasMore` says when the
// range held more.
export const fetchScheduledPosts = async (identity: Identity, from: string, to: string, abortSignal?: AbortSignal) => {
    const query = new URLSearchParams({ from, to, limit: String(CALENDAR_MAX_LIMIT) })
    const body = await request(`/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/posts?${query}`, calendarPageResponseSchema, {
        identity,
        abortSignal,
    })
    return body.data
}
