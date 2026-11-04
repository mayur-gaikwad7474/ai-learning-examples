// post-scheduler-service owns posts and their schedules.
import type { Identity } from '../schemas/identity.schema.ts';
import {
  calendarPageResponseSchema,
  createdPostResponseSchema,
  deletedPostResponseSchema,
  updatedPostResponseSchema,
} from '../schemas/posts.schema.ts';
import type {
  NewScheduledPost,
  ScheduledPostChanges,
} from '../schemas/posts.schema.ts';
import { createServiceClient } from './http.ts';

const request = createServiceClient({
  tag: 'post-scheduler',
  name: 'the post scheduler',
  baseUrl: process.env.POST_SCHEDULER_SERVICE_URL ?? 'http://localhost:4005',
});

// post-scheduler's most posts per calendar page.
const CALENDAR_MAX_LIMIT = 100;

// Builds the legacy post body the app's post editor sends: the same media goes on the post and on
// its one account. `idempotencyKey` makes a retried request return the first post instead of
// creating a second one.
export const createScheduledPost = async (
  identity: Identity,
  post: NewScheduledPost,
  options: { idempotencyKey: string; abortSignal?: AbortSignal },
) => {
  const media = post.mediaIds.map((mediaId) => ({ mediaId }));
  const { account } = post;

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
      accounts: [
        {
          socialId: account.socialId,
          accountType: account.accountType,
          name: account.name,
          caption: post.caption,
          mediaURL: media,
        },
      ],
    },
    abortSignal: options.abortSignal,
  });
  return body.data;
};

// Sends only the fields that change; post-scheduler keeps the rest. A new caption or new media
// also sends customizedEach: false. Without it, a post with its own caption and media per account
// keeps those, and post-scheduler answers 200 without changing anything.
export const updateScheduledPost = async (
  identity: Identity,
  postId: string,
  changes: ScheduledPostChanges,
  abortSignal?: AbortSignal,
) => {
  const { caption, mediaIds, scheduleTime, timeZone } = changes;

  const body = await request(
    `/v1/posts/${encodeURIComponent(postId)}`,
    updatedPostResponseSchema,
    {
      identity,
      method: 'PATCH',
      body: {
        workspaceId: identity.workspaceId,
        ...(caption !== undefined && { draftMessage: caption }),
        ...(mediaIds !== undefined && {
          draftMedia: mediaIds.map((mediaId) => ({ mediaId })),
        }),
        ...((caption !== undefined || mediaIds !== undefined) && {
          customizedEach: false,
        }),
        ...(scheduleTime !== undefined && { scheduleTime }),
        ...(timeZone !== undefined && { timeZone }),
      },
      abortSignal,
    },
  );
  return body.data;
};

// Removes the post from every account in the calendar and cancels its queued publish. A post that
// was already published stays live on its platforms: removing it there is a separate endpoint.
export const deleteScheduledPost = async (
  identity: Identity,
  postId: string,
  abortSignal?: AbortSignal,
) => {
  const query = new URLSearchParams({ workspaceId: identity.workspaceId });
  const body = await request(
    `/v1/posts/${encodeURIComponent(postId)}?${query}`,
    deletedPostResponseSchema,
    { identity, method: 'DELETE', abortSignal },
  );
  return body.data;
};

// Fetches one page only: up to 100 posts is enough for a chat answer, and `hasMore` says when the
// range held more.
export const fetchScheduledPosts = async (
  identity: Identity,
  from: string,
  to: string,
  abortSignal?: AbortSignal,
) => {
  const query = new URLSearchParams({
    from,
    to,
    limit: String(CALENDAR_MAX_LIMIT),
  });
  const body = await request(
    `/v1/workspaces/${encodeURIComponent(identity.workspaceId)}/posts?${query}`,
    calendarPageResponseSchema,
    {
      identity,
      abortSignal,
    },
  );
  return body.data;
};
