// Schemas for conversations. Requests are what the app sends; the model is how a conversation is
// saved in MongoDB.
import { Schema, model } from 'mongoose';
import type { Types } from 'mongoose';
import type { InferToolOutput } from 'ai';
import { z } from 'zod';
import type { listAccounts } from '../tools/accounts.tools.ts';
import type { listPosts } from '../tools/posts.tools.ts';

// The most media one post takes on any platform (Instagram and LinkedIn carousels).
const MAX_ATTACHMENTS = 10;
const MAX_MESSAGE_LENGTH = 10_000;

// ── Requests (HTTP) ─────────────────────────────────────────────────────────────────────────────

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Not a valid ID.');

export const conversationParamsSchema = z.object({
  id: objectIdSchema,
});

// Media the user uploaded through post-scheduler before sending. The URL is only for showing a
// thumbnail; the model gets the mediaId.
const attachmentSchema = z.object({
  mediaId: objectIdSchema,
  type: z.string().min(1).max(20),
  URL: z.url(),
});

export const sendMessageBodySchema = z
  .object({
    text: z.string().trim().max(MAX_MESSAGE_LENGTH).default(''),
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).default([]),
  })
  .refine(
    ({ text, attachments }) => text.length > 0 || attachments.length > 0,
    {
      message: 'Write a message or attach media.',
    },
  );

export type Attachment = z.infer<typeof attachmentSchema>;
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

// ── Display parts (what the app renders) ────────────────────────────────────────────────────────
// An assistant answer is a list of parts in the order they happened: text the model wrote, and
// cards built from tool results. The app picks a component for each `type`. Card data is the
// tool's own output, so it shows exactly what our services returned, never the model's retelling.

type SuccessOutput<T> = Extract<T, { success: true }>;
type AccountsOutput = SuccessOutput<InferToolOutput<typeof listAccounts>>;
type PostsOutput = SuccessOutput<InferToolOutput<typeof listPosts>>;

export type DisplayPart =
  | { type: 'text'; text: string }
  | { type: 'accounts'; accounts: AccountsOutput['accounts'] }
  | { type: 'posts'; posts: PostsOutput['posts']; hasMore: boolean }
  // Confirmation after a post was created. `scheduled` is false when post-scheduler saved the post
  // but could not create its publish schedule.
  | {
      type: 'scheduledPost';
      postId: string;
      account: { name: string; platform: string; profileURL: string | null };
      caption: string;
      mediaCount: number;
      scheduledTime: string | null;
      timeZone: string;
      scheduled: boolean;
    }
  // Confirmation after a post was edited, with only what changed. null means "not changed".
  | {
      type: 'editedPost';
      postId: string;
      status: 'draft' | 'scheduled';
      scheduledTime: string | null;
      timeZone: string | null;
      scheduled: boolean;
      changes: {
        caption: string | null;
        time: boolean;
        mediaCount: number | null;
      };
    };

// ── Database (MongoDB) ──────────────────────────────────────────────────────────────────────────

export type DisplayMessage = {
  _id: Types.ObjectId;
  role: 'user' | 'assistant';
  // The answer's text alone. Kept so an app that does not read `parts` yet still works.
  text: string;
  // Missing on messages saved before parts existed, and on the user's own messages.
  parts?: DisplayPart[];
  attachments: Attachment[];
  createdAt: Date;
};

const displayMessageSchema = new Schema<DisplayMessage>({
  role: { type: String, enum: ['user', 'assistant'], required: true },
  text: { type: String, default: '' },
  // Each part has its own shape, set by DisplayPart above, so MongoDB stores them as they are.
  parts: { type: [Schema.Types.Mixed], default: undefined },
  attachments: [
    new Schema(
      {
        mediaId: { type: String, required: true },
        type: { type: String, required: true },
        URL: { type: String, required: true },
      },
      { _id: false },
    ),
  ],
  createdAt: { type: Date, required: true },
});

const conversationSchema = new Schema(
  {
    // A conversation belongs to one person in one workspace, from the gateway's identity headers.
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    title: { type: String, default: 'New chat' },
    // The exact model history the agent needs, including reasoning and tool steps. It must go
    // back to the model unchanged, and it never goes to the browser.
    messages: { type: [Schema.Types.Mixed], default: [] },
    // What people see: their messages and the assistant's final answers.
    display: { type: [displayMessageSchema], default: [] },
    // Set while the agent is answering, so two messages sent at once cannot both run on the
    // same history. It expires on its own if the server stops mid-answer.
    lockedUntil: { type: Date, default: null },
  },
  // minimize: false keeps empty objects, like the `{}` input of a tool call that takes no input.
  { timestamps: true, minimize: false },
);

conversationSchema.index({ workspaceId: 1, userId: 1, updatedAt: -1 });

export const ConversationModel = model('Conversation', conversationSchema);
