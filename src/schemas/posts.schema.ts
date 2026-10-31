// Schemas for posts. Inputs are what the model sends to a tool; outputs are what
// post-scheduler-service answers.
import { z } from 'zod';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
// The most any platform takes in one post (Instagram and LinkedIn carousels). Platform-specific
// limits, like four images on X, are checked by post-scheduler.
const MAX_MEDIA_PER_POST = 10;

// post-scheduler's longest range for the calendar endpoint.
export const CALENDAR_MAX_WINDOW_DAYS = 93;
const CALENDAR_MAX_WINDOW_MS = CALENDAR_MAX_WINDOW_DAYS * 24 * 60 * 60 * 1000;

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
  // post-scheduler checks each ID belongs to this workspace and finished uploading, so an
  // invented or foreign ID is rejected there and comes back to the model as an error.
  mediaIds: z
    .array(
      z
        .string()
        .regex(/^[a-f\d]{24}$/i, 'A media ID is 24 hexadecimal characters.'),
    )
    .max(MAX_MEDIA_PER_POST)
    .optional()
    .describe(
      'IDs of media the user attached in this conversation, in the order to post them. Only use IDs listed under "Attached media".',
    ),
  scheduledTime: z.iso
    .datetime({ offset: true })
    .refine(
      (time) => new Date(time).getTime() >= Date.now() + FIVE_MINUTES_MS,
      { message: 'Scheduled time must be at least 5 minutes in the future.' },
    )
    .describe(
      'The time at which the post should be scheduled, as an ISO 8601 date-time.',
    ),
});

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

// ── Outputs (post-scheduler-service) ────────────────────────────────────────────────────────────
// We only read the fields we use, and check them, because these responses come from other services.

export const createdPostResponseSchema = z.object({
  data: z.object({
    id: z.string(),
    scheduleTime: z.string().nullable(),
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
