import { Types } from 'mongoose';
import type { ModelMessage, UserModelMessage } from 'ai';
import type { Identity } from '../schemas/identity.schema.ts';
import { ConversationModel } from '../schemas/conversation.schema.ts';
import type {
  Attachment,
  DisplayMessage,
  SendMessageBody,
} from '../schemas/conversation.schema.ts';
import { createPostAgent } from '../agents/postScheduler.agent.ts';
import { HttpError } from '../middleware/errorHandler.ts';

const LIST_LIMIT = 50;
const MAX_TITLE_LENGTH = 60;
// Longer than the gateway's 130-second timeout, so the lock outlives any answer still running.
const LOCK_MS = 3 * 60 * 1000;

type ConversationSummary = {
  _id: Types.ObjectId;
  title: string;
  updatedAt: Date;
};

const toSummary = (conversation: ConversationSummary) => ({
  id: String(conversation._id),
  title: conversation.title,
  updatedAt: conversation.updatedAt,
});

const toDisplay = (message: DisplayMessage) => ({
  id: String(message._id),
  role: message.role,
  text: message.text,
  attachments: message.attachments,
  createdAt: message.createdAt,
});

// Every query includes the owner, so one person can never read or write another's conversation.
const ownedBy = (identity: Identity) => ({
  workspaceId: identity.workspaceId,
  userId: identity.userId,
});

// Attached media goes to the model as its IDs only, never the file. The IDs stay in the history,
// so a later "post that image on LinkedIn too" still knows which media to use.
const toModelMessage = (
  text: string,
  attachments: Attachment[],
): UserModelMessage => {
  if (attachments.length === 0) return { role: 'user', content: text };

  const list = attachments
    .map(
      (attachment) => `- ${attachment.type} (mediaId: ${attachment.mediaId})`,
    )
    .join('\n');
  const media = { type: 'text' as const, text: `Attached media:\n${list}` };
  return {
    role: 'user',
    content: text ? [{ type: 'text', text }, media] : [media],
  };
};

const toTitle = (text: string, attachments: Attachment[]) => {
  if (!text)
    return attachments.length === 1
      ? '1 attachment'
      : `${attachments.length} attachments`;
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH)}…`
    : text;
};

const runAgent = async (
  identity: Identity,
  messages: ModelMessage[],
  abortSignal: AbortSignal,
) => {
  try {
    return await createPostAgent(identity).generate({
      messages,
      abortSignal,
      onStepEnd: (step) => {
        for (const call of step.toolCalls)
          console.log(`  [tool call] ${call.toolName}`, call.input);
        for (const part of step.content) {
          if (part.type === 'tool-error')
            console.log(`  [tool error] ${part.toolName}`, String(part.error));
        }
      },
    });
  } catch (error) {
    if (abortSignal.aborted) throw error;
    console.error('[conversation] the agent failed:', error);
    throw new HttpError(
      502,
      'The assistant could not reply. Please try again.',
    );
  }
};

// Conversations with no messages yet are left out: one is created just before its first message,
// and that message can fail.
export const listConversations = async (identity: Identity) => {
  const conversations = await ConversationModel.find(
    { ...ownedBy(identity), 'display.0': { $exists: true } },
    { title: 1, updatedAt: 1 },
  )
    .sort({ updatedAt: -1 })
    .limit(LIST_LIMIT)
    .lean();

  return conversations.map(toSummary);
};

export const createConversation = async (identity: Identity) => {
  const conversation = await ConversationModel.create(ownedBy(identity));
  return toSummary(conversation);
};

export const getConversation = async (identity: Identity, id: string) => {
  const conversation = await ConversationModel.findOne(
    { _id: id, ...ownedBy(identity) },
    { title: 1, display: 1, updatedAt: 1 },
  ).lean();
  if (!conversation)
    throw new HttpError(404, 'This conversation was not found.');

  return {
    ...toSummary(conversation),
    messages: conversation.display.map(toDisplay),
  };
};

// Loads the saved history, adds the new message, runs the agent and saves both sides of the turn.
// The browser sends only the new message, so it cannot change what the model saw before.
export const sendMessage = async (
  identity: Identity,
  id: string,
  body: SendMessageBody,
  abortSignal: AbortSignal,
) => {
  const owner = { _id: id, ...ownedBy(identity) };
  const sentAt = new Date();

  const conversation = await ConversationModel.findOneAndUpdate(
    {
      ...owner,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: sentAt } }],
    },
    { $set: { lockedUntil: new Date(sentAt.getTime() + LOCK_MS) } },
  ).lean();

  if (!conversation) {
    const exists = await ConversationModel.exists(owner);
    if (!exists) throw new HttpError(404, 'This conversation was not found.');
    throw new HttpError(
      409,
      'The assistant is still answering your previous message.',
    );
  }

  try {
    const userMessage = toModelMessage(body.text, body.attachments);
    const result = await runAgent(
      identity,
      [...(conversation.messages as ModelMessage[]), userMessage],
      abortSignal,
    );

    const title =
      conversation.display.length === 0
        ? toTitle(body.text, body.attachments)
        : conversation.title;
    const question: DisplayMessage = {
      _id: new Types.ObjectId(),
      role: 'user',
      text: body.text,
      attachments: body.attachments,
      createdAt: sentAt,
    };
    const answer: DisplayMessage = {
      _id: new Types.ObjectId(),
      role: 'assistant',
      text: result.text,
      attachments: [],
      createdAt: new Date(),
    };

    // Both sides are saved together after the agent finishes, so a failed turn leaves no half of it.
    await ConversationModel.updateOne(owner, {
      $push: {
        messages: { $each: [userMessage, ...result.responseMessages] },
        display: { $each: [question, answer] },
      },
      $set: { title },
    });

    return { title, message: toDisplay(answer) };
  } finally {
    await ConversationModel.updateOne(owner, { $set: { lockedUntil: null } });
  }
};
