import { tool } from 'ai';
import type { InferToolOutput, ModelMessage, ToolApprovalStatus } from 'ai';
import { identitySchema } from '../schemas/identity.schema.ts';
import {
  CALENDAR_MAX_WINDOW_DAYS,
  deletePostInputSchema,
  editPostInputSchema,
  listPostsInputSchema,
  schedulePostInputSchema,
} from '../schemas/posts.schema.ts';
import { ServiceError } from '../clients/http.ts';
import { fetchConnectedAccounts } from '../clients/connections.client.ts';
import {
  createScheduledPost,
  deleteScheduledPost,
  fetchScheduledPosts,
  updateScheduledPost,
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
        success: false as const,
        error:
          'That account is not connected to this workspace. Use the account list tool to pick one.',
      };
    }
    if (account.isAccountTokensExpired) {
      return {
        success: false as const,
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
      success: true as const,
      postId: created.id,
      account: account.name,
      platform: account.accountType,
      // For the app's confirmation card, like listAccounts. Older accounts can have no image.
      profileURL: account.profileURL || null,
      scheduledTime: created.scheduleTime,
      scheduled: created.scheduled,
    };
  },
});

// What to tell the model when an edit failed. A 4xx message is written for people (post not
// found, already published, view-only role), so it goes back as a normal result. Otherwise the
// change may already be saved, so the model must not simply try again.
const explainEditFailure = (
  error: unknown,
): { success: false; error: string } => {
  if (!(error instanceof ServiceError)) throw error;

  switch (error.kind) {
    case 'rejected':
      return { success: false, error: error.message };
    case 'unreachable':
      throw new Error(
        'Could not reach the post scheduler. The change may or may not have been saved, so ask the user to check the post in their calendar before trying again.',
      );
    case 'failed':
      // post-scheduler removes the old schedule before saving a new time, so a failure part-way
      // can leave the post without one.
      throw new Error(
        `The post scheduler failed (status ${error.status}). The change may be partly saved, and a post whose time was changed may no longer be scheduled. Ask the user to check the post in their calendar before trying again.`,
      );
    case 'unreadable':
      throw new Error(
        'The post scheduler sent a response that could not be read. Ask the user to check the post in their calendar.',
      );
  }
};

export const editPost = tool({
  description: [
    'Change the caption, publish time or media of a scheduled or draft post in the current workspace. Posts that are published or publishing cannot be edited. Also if the post is scheduled if we have to edit then it should be more than 5 minutes from now then only it can be editable or else we will reject it to edit.',
    'Get the post ID from the list posts tool; never guess one. Send only what the user wants to change.',
    "A new caption or new media replaces it on every account of the post. If the post's accounts have different captions, tell the user they will all get the same caption and ask before editing.",
  ].join(' '),
  inputSchema: editPostInputSchema,
  contextSchema: identitySchema,
  execute: async (
    { postId, caption, scheduledTime, timeZone, mediaIds },
    { context, abortSignal },
  ) => {
    let updated;
    try {
      updated = await updateScheduledPost(
        context,
        postId,
        {
          caption,
          mediaIds,
          scheduleTime: scheduledTime && new Date(scheduledTime).toISOString(),
          timeZone,
        },
        abortSignal,
      );
    } catch (error) {
      return explainEditFailure(error);
    }

    return {
      success: true as const,
      postId: updated.id,
      status:
        updated.status === 'draft'
          ? ('draft' as const)
          : ('scheduled' as const),
      scheduledTime: updated.scheduleTime,
      timeZone: updated.timeZone,
      scheduled: updated.scheduled,
    };
  },
});

// What to tell the model when a delete failed. A 4xx message is written for people (post not found,
// view-only role), so it goes back as a normal result. Otherwise the post may already be deleted,
// so the model must not simply try again.
const explainDeleteFailure = (
  error: unknown,
): { success: false; error: string } => {
  if (!(error instanceof ServiceError)) throw error;

  switch (error.kind) {
    case 'rejected':
      return { success: false, error: error.message };
    case 'unreachable':
      throw new Error(
        'Could not reach the post scheduler. The post may or may not have been deleted, so ask the user to check their calendar before trying again.',
      );
    case 'failed':
      throw new Error(
        `The post scheduler failed (status ${error.status}). The post may or may not have been deleted, so ask the user to check their calendar before trying again.`,
      );
    case 'unreadable':
      throw new Error(
        'The post scheduler sent a response that could not be read. Ask the user to check their calendar.',
      );
  }
};

// Never runs on its own: the agent's toolApproval (deletePostApproval below) makes every call wait
// for the user's Approve or Deny in the app, and this runs only after Approve.
export const deletePost = tool({
  description: [
    'Delete one post from the Creatosaurus calendar of the current workspace, whether it is scheduled, a draft, failed or published. A scheduled post will no longer go out.',
    'Deleting a published post only removes it from the calendar: it stays live on the social platform.',
    'Get the post ID from the list posts tool; never guess one. Delete one post per call.',
    'The app asks the user to approve every delete with buttons, so call this tool directly instead of asking "are you sure?" in your reply.',
  ].join(' '),
  inputSchema: deletePostInputSchema,
  contextSchema: identitySchema,
  execute: async ({ postId }, { context, abortSignal }) => {
    let deleted;
    try {
      deleted = await deleteScheduledPost(context, postId, abortSignal);
    } catch (error) {
      return explainDeleteFailure(error);
    }

    return {
      success: true as const,
      postId: deleted.id,
      cancelledSchedule: deleted.cancelledSchedule,
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

type CalendarPost = Awaited<
  ReturnType<typeof fetchScheduledPosts>
>['items'][number];

// Every media file in the post, once, as the calendar shows it: accounts can share files, and a
// draft with no accounts keeps its media on the post itself.
const mediaOf = (post: CalendarPost) => {
  const accountMedia = post.accounts.flatMap(
    (account) => account.mediaURL ?? [],
  );
  const media =
    accountMedia.length > 0 ? accountMedia : (post.draftMedia ?? []);
  const unique = new Map(media.map((file) => [file.mediaId, file]));
  return [...unique.values()].map((file) => ({
    mediaId: file.mediaId,
    URL: file.url,
    type: file.type,
  }));
};

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

    // What the model needs to talk about a post, plus what the app's post cards show (profile
    // images and media). socialIds stay out. toModelOutput below trims this for the model.
    const posts = page.items.map((post) => ({
      id: post.id,
      status: POST_STATUS_LABELS[post.status] ?? post.status,
      scheduledTime: post.scheduleTime,
      timeZone: post.timeZone,
      media: mediaOf(post),
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
    return { success: true as const, posts, hasMore: page.hasMore };
  },

  // What the model sees, instead of the full output above. The media URLs are long and only the
  // app needs them, so the model gets each file's type ("image", "video"), which is enough to say
  // "the post with two images". The full output still reaches services/displayParts.ts for the
  // cards, and only this version is saved in the conversation's model history.
  toModelOutput: ({ output }) => ({
    type: 'json',
    value: {
      ...output,
      posts: output.posts.map((post) => ({
        ...post,
        media: post.media.map((file) => file.type),
      })),
    },
  }),
});

type ListedPost = Extract<
  InferToolOutput<typeof listPosts>,
  { success: true }
>['posts'][number];

// A post as the model saw it in a list posts result: the toModelOutput version above, where media
// is only each file's type.
export type ModelListedPost = Omit<ListedPost, 'media'> & { media: string[] };

// The post with this ID in the newest list posts result of the history, or null when the model was
// never shown it. The history holds only the model's version of each result (see toModelOutput).
export const findListedPost = (
  messages: ModelMessage[],
  postId: string,
): ModelListedPost | null => {
  for (const message of messages.toReversed()) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (
        part.type !== 'tool-result' ||
        part.toolName !== 'listPosts' ||
        part.output.type !== 'json'
      )
        continue;
      // Written by toModelOutput above, so it has this shape.
      const { posts } = part.output.value as { posts: ModelListedPost[] };
      const post = posts.find((candidate) => candidate.id === postId);
      if (post) return post;
    }
  }
  return null;
};

// A post post-scheduler is sending right now shows as finished with an account still pending.
// Deleting it then can still let it go out while it disappears from the calendar.
const isPublishing = (post: ModelListedPost) =>
  post.status === 'finished' &&
  post.accounts.some((account) => account.status === 'pending');

// Runs before every deletePost call, in our code, so the model cannot skip it. Calls that are
// already wrong are refused with a reason the model reads; every other call waits for the user's
// Approve or Deny. The user approves the post they were shown, so the ID must come from a list.
export const deletePostApproval = (
  { postId }: { postId: string },
  { messages }: { messages: ModelMessage[] },
): ToolApprovalStatus => {
  const post = findListedPost(messages, postId);
  if (!post) {
    return {
      type: 'denied',
      reason:
        'Not deleted: this post ID was not in a list posts result. Find the post with the list posts tool first, then delete it by the ID shown there.',
    };
  }
  if (isPublishing(post)) {
    return {
      type: 'denied',
      reason:
        'Not deleted: this post is being published right now. Tell the user to try again in a few minutes, once it has finished.',
    };
  }
  return 'user-approval';
};
