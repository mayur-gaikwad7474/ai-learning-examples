// Schemas for conversations. Requests are what the app sends; the model is how a conversation is
// saved in MongoDB.
import { Schema, model } from 'mongoose';
import { z } from 'zod';

// The most media one post takes on any platform (Instagram and LinkedIn carousels).
const MAX_ATTACHMENTS = 10;

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, 'Not a valid ID.');

// ── Requests (HTTP) ─────────────────────────────────────────────────────────────────────────────

// The app makes up the ID of a new conversation itself (useChat needs one before the first
// message), and the conversation is saved when that first message arrives.
export const conversationParamsSchema = z.object({
  id: objectIdSchema,
});

// What useChat sends: only the newest message. The rest of the conversation is saved here, so the
// browser cannot change what the model saw before. It is either the user's new message, or the last
// assistant message with the user's Approve or Deny on it. The service checks its full shape with
// the AI SDK.
export const sendMessageBodySchema = z.object({
  message: z.looseObject({
    id: z.string().min(1).max(100),
    role: z.enum(['user', 'assistant']),
    parts: z.array(z.unknown()).max(50),
  }),
});

// Media the user uploaded through post-scheduler before sending. It travels in the user's message
// as a `data-attachments` part: the app shows thumbnails from the URL, the model gets the mediaId.
export const attachmentsSchema = z
  .array(
    z.object({
      mediaId: objectIdSchema,
      type: z.string().min(1).max(20),
      URL: z.url(),
    }),
  )
  .max(MAX_ATTACHMENTS);

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

// ── Database (MongoDB) ──────────────────────────────────────────────────────────────────────────

const conversationSchema = new Schema(
  {
    // A conversation belongs to one person in one workspace, from the gateway's identity headers.
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    title: { type: String, default: 'New chat' },
    // The conversation exactly as useChat shows it: the AI SDK's UI messages, with the text and
    // every tool call (input, output and approval). It is turned into model messages on each turn.
    messages: { type: [Schema.Types.Mixed], default: [] },
    // Set while the agent is answering, so two messages sent at once cannot both run on the same
    // history. It expires on its own if the server stops mid-answer.
    lockedUntil: { type: Date, default: null },
  },
  // minimize: false keeps empty objects, like the `{}` input of a tool call that takes no input.
  { timestamps: true, minimize: false },
);

conversationSchema.index({ workspaceId: 1, userId: 1, updatedAt: -1 });

// Saved in the "chats" collection. Conversations from before useChat stay in "conversations" in
// their old format; this version does not read them.
export const ConversationModel = model(
  'Conversation',
  conversationSchema,
  'chats',
);
