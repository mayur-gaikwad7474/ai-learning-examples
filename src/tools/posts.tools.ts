import { tool } from 'ai';
import { identitySchema } from '../schemas/identity.schema.ts';
import {
  CALENDAR_MAX_WINDOW_DAYS,
  listPostsInputSchema,
  schedulePostInputSchema,
} from '../schemas/posts.schema.ts';
import { ServiceError } from '../clients/http.ts';
import { fetchConnectedAccounts } from '../clients/connections.client.ts';
import {
  createScheduledPost,
  fetchScheduledPosts,
} from '../clients/postScheduler.client.ts';

// What to tell the model when creating a post failed. A 4xx message is written for people
// (validation, permissions), so it goes back as a normal result. Otherwise the post may already
// exist, so the model must not simply try again.
const explainScheduleFailure = (
  error: unknown,
): { success: false; error: string } => {
  if (!(error instanceof ServiceError)) throw error;

  switch (error.kind) {
    case 'rejected':
      return { success: false, error: error.message };
    case 'unreachable':
      // The request may have reached post-scheduler before failing.
      throw new Error(
        'Could not reach the post scheduler. The post may or may not have been saved, so ask the user to check their calendar before trying again.',
      );
    case 'failed':
      // post-scheduler saves the post before creating the schedule.
      throw new Error(
        `The post scheduler failed (status ${error.status}). The post may have been saved without a schedule, so ask the user to check their calendar before trying again.`,
      );
    case 'unreadable':
      throw new Error(
        'The post scheduler sent a response that could not be read. Ask the user to check their calendar.',
      );
  }
};

// `inputSchema` is what the model fills in. `contextSchema` is what our own code passes in
// (the identity from the gateway), so the model cannot choose or change it.
export const schedulePost = tool({
  description:
    'Schedule a post on one of the connected accounts of the current workspace, with optional images or videos the user attached in this chat.',
  inputSchema: schedulePostInputSchema,
  contextSchema: identitySchema,
  execute: async (
    { accountId, timeZone, caption, scheduledTime, mediaIds },
    { context, abortSignal, toolCallId },
  ) => {
    // Look the account up ourselves: post-scheduler needs its socialId and accountType, and the
    // model must not be able to invent a page ID or use another workspace's account.
    const accounts = await fetchConnectedAccounts(context, abortSignal);
    const account = accounts.find((candidate) => candidate._id === accountId);

    if (!account) {
      return {
        success: false,
        error:
          'That account is not connected to this workspace. Use the account list tool to pick one.',
      };
    }
    if (account.isAccountTokensExpired) {
      return {
        success: false,
        error: `${account.name} needs to be reconnected in Creatosaurus before posts can be scheduled on it.`,
      };
    }

    let created;
    try {
      created = await createScheduledPost(
        context,
        {
          account,
          caption,
          mediaIds: mediaIds ?? [],
          scheduleTime: new Date(scheduledTime).toISOString(),
          timeZone,
        },
        // Same tool call, same key: if this request is retried, post-scheduler will not
        // create a second post.
        { idempotencyKey: `ai-${toolCallId}`, abortSignal },
      );
    } catch (error) {
      return explainScheduleFailure(error);
    }

    return {
      success: true,
      postId: created.id,
      account: account.name,
      platform: account.accountType,
      scheduledTime: created.scheduleTime,
      scheduled: created.scheduled,
    };
  },
});

// Legacy calendar statuses, turned into words the model can repeat to people.
const POST_STATUS_LABELS: Record<string, string> = {
  queue: 'scheduled',
  draft: 'draft',
  history: 'finished',
};
const ACCOUNT_STATUS_LABELS: Record<string, string> = {
  success: 'published',
  failed: 'failed',
  reconciliation_required: 'unknown, check on the platform',
};

// Long captions would make a 100-post answer expensive; the start is enough to recognise a post.
const MAX_CAPTION_LENGTH = 280;
const shortenCaption = (caption: string) =>
  caption.length > MAX_CAPTION_LENGTH
    ? `${caption.slice(0, MAX_CAPTION_LENGTH)}…`
    : caption;

export const listPosts = tool({
  description: [
    `Get the posts of the current workspace in Creatosaurus between two dates, with the publish status on each account. Use it to check that a post was scheduled, or to answer questions about upcoming or past posts.`,
    `The range can be at most ${CALENDAR_MAX_WINDOW_DAYS} days (about 3 months). Call it once per question and never split a longer period into several calls.`,
    `If the user asks about a longer period, such as a whole year, do not call this tool. Tell them you can look at up to 3 months at a time, and offer options: the last 3 months, a specific quarter (for example Jan–Mar), or a specific month.`,
  ].join(' '),

  inputSchema: listPostsInputSchema,
  contextSchema: identitySchema,
  execute: async ({ from, to }, { context, abortSignal }) => {
    const page = await fetchScheduledPosts(context, from, to, abortSignal);

    // Give the model what it needs to talk about a post, plus the profile image so the app can
    // show post cards. socialIds and media stay out.
    const posts = page.items.map((post) => ({
      id: post.id,
      status: POST_STATUS_LABELS[post.status] ?? post.status,
      scheduledTime: post.scheduleTime,
      timeZone: post.timeZone,
      accounts: post.accounts.map((account) => ({
        name: account.name,
        platform: account.accountType,
        profileURL: account.profileURL || null,
        caption: shortenCaption(account.caption || post.draftMessage || ''),
        status: ACCOUNT_STATUS_LABELS[account.status] ?? 'pending',
        postUrl: account.postUrl || null,
        error: account.error || null,
      })),
    }));

    // An empty range is a normal answer, not a failure.
    return { success: true, posts, hasMore: page.hasMore };
  },
});
