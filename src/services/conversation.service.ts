// Conversations: list them, open one, and answer a new message.
//
// How one turn works:
//   1. useChat sends only the newest message. We load the saved conversation and add it.
//   2. pipeAgentUIStreamToResponse runs the agent and streams the answer to the browser in the AI
//      SDK's format, which useChat reads and shows as it arrives.
//   3. When the answer is complete, onFinish saves the whole conversation, answer included.
//
// Approvals use the same endpoint. When the agent wants to run a tool that needs approval
// (deletePost), its answer stops with that tool in the state "approval-requested". The user clicks
// Approve or Deny, useChat sends the last assistant message again with that answer on it, and the
// agent continues from there: the SDK runs the tool if approved, and tells the model if denied.
import type { Response } from 'express';
import {
  generateId,
  isToolUIPart,
  pipeAgentUIStreamToResponse,
  safeValidateUIMessages,
} from 'ai';
import type { DataUIPart, InferAgentUIMessage, UIMessage } from 'ai';
import { createPostAgent } from '../agents/postScheduler.agent.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import type { Identity } from '../schemas/identity.schema.ts';
import {
  ConversationModel,
  attachmentsSchema,
} from '../schemas/conversation.schema.ts';
import type { SendMessageBody } from '../schemas/conversation.schema.ts';

// A message of this agent's conversations, with each tool part typed by its tool (tool-listPosts...).
type PostChatMessage = InferAgentUIMessage<ReturnType<typeof createPostAgent>>;

const LIST_LIMIT = 50;
const MAX_TITLE_LENGTH = 60;
// Longer than the gateway's 130-second timeout, so the lock outlives any answer still running.
const LOCK_MS = 3 * 60 * 1000;

// Every query includes the owner, so one person can never read or write another's conversation.
const ownedBy = (identity: Identity) => ({
  workspaceId: identity.workspaceId,
  userId: identity.userId,
});

// Conversations with no messages yet are left out: one is saved before its first answer, and that
// answer can fail.
export const listConversations = async (identity: Identity) => {
  const conversations = await ConversationModel.find(
    { ...ownedBy(identity), 'messages.0': { $exists: true } },
    { title: 1, updatedAt: 1 },
  )
    .sort({ updatedAt: -1 })
    .limit(LIST_LIMIT)
    .lean();

  return conversations.map((conversation) => ({
    id: String(conversation._id),
    title: conversation.title,
    updatedAt: conversation.updatedAt,
  }));
};

export const getConversation = async (identity: Identity, id: string) => {
  const conversation = await ConversationModel.findOne({
    _id: id,
    ...ownedBy(identity),
  }).lean();
  if (!conversation)
    throw new HttpError(404, 'This conversation was not found.');

  return {
    id: String(conversation._id),
    title: conversation.title,
    messages: conversation.messages as UIMessage[],
  };
};

// Locks the conversation for one turn, and creates it on its first message. Nothing is streamed
// before this, so a 404 or 409 still reaches the app as a plain error.
const startTurn = async (identity: Identity, id: string) => {
  const owner = { _id: id, ...ownedBy(identity) };
  const now = new Date();

  try {
    return await ConversationModel.findOneAndUpdate(
      { ...owner, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
      { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
  } catch (error) {
    // 11000 (duplicate key): the ID exists but did not match, so it is either locked or not ours.
    if ((error as { code?: number }).code !== 11000) throw error;
    const ours = await ConversationModel.exists(owner);
    if (!ours) throw new HttpError(404, 'This conversation was not found.');
    throw new HttpError(
      409,
      'The assistant is still answering your previous message.',
    );
  }
};

const endTurn = (identity: Identity, id: string) =>
  ConversationModel.updateOne(
    { _id: id, ...ownedBy(identity) },
    { $set: { lockedUntil: null } },
  );

// The browser may only send text and attachments as the user. Tool parts come from the agent.
const checkUserMessage = (message: UIMessage) => {
  const allowed = message.parts.every(
    (part) => part.type === 'text' || part.type === 'data-attachments',
  );
  if (!allowed)
    throw new HttpError(400, 'A message can only contain text and media.');
};

// Copies the user's Approve or Deny from the browser's copy of the last assistant message onto our
// saved copy. Only the answers are taken, never anything else the browser sent, so it cannot change
// what the agent did or said.
const withApprovalAnswers = (history: UIMessage[], message: UIMessage) => {
  const last = history.at(-1);
  if (last?.role !== 'assistant' || last.id !== message.id) {
    throw new HttpError(409, 'This answer is not the latest one in the chat.');
  }

  const answers = new Map<string, boolean>();
  for (const part of message.parts) {
    if (isToolUIPart(part) && part.state === 'approval-responded')
      answers.set(part.approval.id, part.approval.approved);
  }

  const parts = last.parts.map((part) => {
    if (!isToolUIPart(part) || part.state !== 'approval-requested') return part;
    const approved = answers.get(part.approval.id);
    if (approved === undefined) return part;
    return {
      ...part,
      state: 'approval-responded' as const,
      approval: { ...part.approval, approved },
    };
  });

  // useChat sends the answers once every request in the message has one.
  const unanswered = parts.some(
    (part) => isToolUIPart(part) && part.state === 'approval-requested',
  );
  if (unanswered)
    throw new HttpError(400, 'Approve or deny every request first.');

  return [...history.slice(0, -1), { ...last, parts }];
};

// After a Deny, the SDK saves the tool as "output-denied", which it later sends to the model as a
// different kind of result than the one the model saw when it answered the Deny. Claude's thinking
// is signed against the exact earlier messages, so that difference made every later turn fail.
// Sending such tools as "approval-responded" (denied) again gives the model the same result every
// time. Only what the model sees changes; the saved conversation keeps "output-denied".
const forTheModel = (messages: UIMessage[]): UIMessage[] =>
  messages.map((message) => ({
    ...message,
    parts: message.parts.map((part) =>
      isToolUIPart(part) && part.state === 'output-denied'
        ? { ...part, state: 'approval-responded' as const }
        : part,
    ),
  }));

// The model cannot see the app's thumbnails, so an attachments part reaches it as text with each
// file's mediaId, which the post tools take.
const attachmentsForModel = (part: DataUIPart<Record<string, unknown>>) => {
  if (part.type !== 'data-attachments') return undefined;
  const list = attachmentsSchema
    .parse(part.data)
    .map((file) => `- ${file.type} (mediaId: ${file.mediaId})`)
    .join('\n');
  return { type: 'text' as const, text: `Attached media:\n${list}` };
};

const titleOf = (message: UIMessage) => {
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join(' ')
    .trim();
  if (!text) return 'Media';
  return text.length > MAX_TITLE_LENGTH
    ? `${text.slice(0, MAX_TITLE_LENGTH)}…`
    : text;
};

export const sendMessage = async ({
  identity,
  id,
  body,
  response,
  abortSignal,
}: {
  identity: Identity;
  id: string;
  body: SendMessageBody;
  response: Response;
  abortSignal: AbortSignal;
}) => {
  // Check the message's full shape (parts, tool states, attachments) with the AI SDK.
  const validated = await safeValidateUIMessages({
    messages: [body.message],
    dataSchemas: { attachments: attachmentsSchema },
  });
  if (!validated.success)
    throw new HttpError(400, 'This message is not valid.');
  const [message] = validated.data;
  if (message.role === 'user') checkUserMessage(message);

  const owner = { _id: id, ...ownedBy(identity) };
  const conversation = await startTurn(identity, id);

  try {
    const history = conversation.messages as UIMessage[];
    const messages =
      message.role === 'user'
        ? [...history, message]
        : withApprovalAnswers(history, message);
    const title = history.length === 0 ? titleOf(message) : conversation.title;

    await pipeAgentUIStreamToResponse({
      response,
      agent: createPostAgent(identity),
      // What the model sees, and what the answer is added to (see forTheModel).
      uiMessages: forTheModel(messages),
      // Every saved message was checked when it arrived, so it has this agent's shape.
      originalMessages: messages as PostChatMessage[],
      convertDataPart: attachmentsForModel,
      // The saved conversation is the real one, so the server names each new answer. An Approve or
      // Deny is matched to its answer by this ID (see withApprovalAnswers).
      generateMessageId: generateId,
      abortSignal,
      // Runs once the answer is complete, with the whole conversation including it. A failed or
      // stopped answer is not saved, so the next message continues from the last complete one.
      onFinish: async ({ messages: finished, isAborted, outcome }) => {
        if (isAborted || outcome.status !== 'completed') return;
        await ConversationModel.updateOne(owner, {
          $set: { messages: finished, title },
        });
      },
      // The stream has already started, so an error can only be reported inside it. The details
      // go to our logs; useChat shows this message.
      onError: (error) => {
        console.error('[conversation] the agent failed:', error);
        return 'The assistant could not reply. Please try again.';
      },
    });
  } finally {
    await endTurn(identity, id);
  }
};
