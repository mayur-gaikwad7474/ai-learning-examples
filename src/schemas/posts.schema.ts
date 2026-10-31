// Schemas for posts. Inputs are what the model sends to a tool; requests are what our client
// sends to post-scheduler-service; outputs are what it answers.
import { z } from 'zod';
import type { ConnectedAccount } from './accounts.schema.ts';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
// The most any platform takes in one post (Instagram and LinkedIn carousels). Platform-specific
// limits, like four images on X, are checked by post-scheduler.
const MAX_MEDIA_PER_POST = 10;

// post-scheduler's longest range for the calendar endpoint.
export const CALENDAR_MAX_WINDOW_DAYS = 93;
const CALENDAR_MAX_WINDOW_MS = CALENDAR_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const objectIdSchema = z
  .string()
  .regex(/^[a-f\d]{24}$/i, 'An ID is 24 hexadecimal characters.');

// post-scheduler checks each ID belongs to this workspace and finished uploading, so an
// invented or foreign ID is rejected there and comes back to the model as an error.
const mediaIdsSchema = z.array(objectIdSchema).max(MAX_MEDIA_PER_POST);

const futureDateTimeSchema = z.iso
  .datetime({ offset: true })
  .refine((time) => new Date(time).getTime() >= Date.now() + FIVE_MINUTES_MS, {
    message: 'Scheduled time must be at least 5 minutes in the future.',
  });

// ── Inputs (tools) ──────────────────────────────────────────────────────────────────────────────

export const schedulePostInputSchema = z.object({
  accountId: z
    .string()
    .describe(
      'The ID of the social media account, taken from the account list tool.',
    ),
  timeZone: z
    .string()
    .describe(
      'The time zone for the scheduled post, for example Asia/Kolkata.',
    ),
  caption: z.string().min(1).describe('The caption for the social media post.'),
  mediaIds: mediaIdsSchema
    .optional()
    .describe(
      'IDs of media the user attached in this conversation, in the order to post them. Only use IDs listed under "Attached media".',
    ),
  scheduledTime: futureDateTimeSchema.describe(
    'The time at which the post should be scheduled, as an ISO 8601 date-time.',
  ),
});

// Only what the model may change. Publishing now (shareNow), draft/scheduled status and the
// post's accounts are left out on purpose, so an edit can never publish a post or move it.
export const editPostInputSchema = z
  .object({
    postId: objectIdSchema.describe(
      'The ID of the post to edit, taken from the list posts tool.',
    ),
    caption: z
      .string()
      .min(1)
      .optional()
      .describe('The new caption. It replaces the caption on every account.'),
    scheduledTime: futureDateTimeSchema
      .optional()
      .describe('The new publish time, as an ISO 8601 date-time.'),
    timeZone: z
      .string()
      .optional()
      .describe(
        'The time zone of the new time, for example Asia/Kolkata. Send it with scheduledTime.',
      ),
    mediaIds: mediaIdsSchema
      .optional()
      .describe(
        'The new media, in the order to post them. It replaces all media on the post. Only use IDs listed under "Attached media"; send [] to remove all media.',
      ),
  })
  .refine(
    ({ caption, scheduledTime, mediaIds }) =>
      caption !== undefined ||
      scheduledTime !== undefined ||
      mediaIds !== undefined,
    { message: 'Change at least one of caption, scheduledTime or mediaIds.' },
  );

export const listPostsInputSchema = z
  .object({
    from: z.iso
      .datetime({ offset: true })
      .describe('Start of the range, as an ISO 8601 date-time.'),
    to: z.iso
      .datetime({ offset: true })
      .describe('End of the range, as an ISO 8601 date-time.'),
  })
  .refine(({ from, to }) => new Date(from) <= new Date(to), {
    message: 'from must be before to.',
    path: ['to'],
  })
  .refine(
    ({ from, to }) =>
      new Date(to).getTime() - new Date(from).getTime() <=
      CALENDAR_MAX_WINDOW_MS,
    {
      message: `The range cannot be longer than ${CALENDAR_MAX_WINDOW_DAYS} days.`,
      path: ['to'],
    },
  );

// ── Requests (our client → post-scheduler-service) ──────────────────────────────────────────────

export type NewScheduledPost = {
  account: Pick<ConnectedAccount, 'socialId' | 'accountType' | 'name'>;
  caption: string;
  mediaIds: string[];
  scheduleTime: string;
  timeZone: string;
};

// What an edit may change. There is no shareNow, status or accounts here on purpose: an edit
// must never publish a post right away or move it to other accounts.
export type ScheduledPostChanges = {
  caption?: string;
  mediaIds?: string[];
  scheduleTime?: string;
  timeZone?: string;
};

// ── Outputs (post-scheduler-service) ────────────────────────────────────────────────────────────
// We only read the fields we use, and check them, because these responses come from other services.

export const createdPostResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    scheduleTime: z.string().nullable(),
    scheduled: z.boolean(),
  }),
});

// PATCH /v1/posts/:postId answers with the post after the change.
export const updatedPostResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    status: z.string(),
    scheduleTime: z.string().nullable(),
    timeZone: z.string().nullable(),
    scheduled: z.boolean(),
  }),
});

// The calendar endpoint still returns the legacy post shape the app's calendar uses.
export const calendarPageResponseSchema = z.object({
  data: z.object({
    items: z.array(
      z.object({
        id: z.string(),
        status: z.string(),
        scheduleTime: z.string().nullable(),
        timeZone: z.string().nullable(),
        draftMessage: z.string().nullish(),
        accounts: z.array(
          z.object({
            name: z.string(),
            accountType: z.string(),
            profileURL: z.string().optional(),
            caption: z.string().nullish(),
            status: z.string(),
            postUrl: z.string().nullish(),
            error: z.string().nullish(),
          }),
        ),
      }),
    ),
    hasMore: z.boolean(),
  }),
});
