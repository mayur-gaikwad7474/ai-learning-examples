import { Types } from 'mongoose';
import type { ModelMessage, ToolModelMessage, UserModelMessage } from 'ai';
import type { Identity } from '../schemas/identity.schema.ts';
import { ConversationModel } from '../schemas/conversation.schema.ts';
import type {
  AnswerApprovalBody,
  ApprovalDecision,
  Attachment,
  DisplayMessage,
  DisplayPart,
  SendMessageBody,
} from '../schemas/conversation.schema.ts';
import { createPostAgent } from '../agents/postScheduler.agent.ts';
import { toCardPart, toDisplayParts } from './displayParts.ts';
import { HttpError } from '../middleware/errorHandler.ts';

// What the app sees while the agent works: which tool is running, the text as it is written, and
// each card as soon as its tool returns. The finished answer is sent separately, once it is saved.
export type AgentEvent =
  | { type: 'progress'; toolName: string }
  | { type: 'text'; text: string }
  | { type: 'card'; part: DisplayPart };

export type SendEvent = (event: AgentEvent) => void;

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

// Messages saved before parts existed get their text as the only part, so the app can always read
// `parts` and never has to handle both shapes.
const toDisplay = (message: DisplayMessage) => ({
  id: String(message._id),
  role: message.role,
  text: message.text,
  parts: message.parts ?? [{ type: 'text', text: message.text }],
  attachments: message.attachments,
  createdAt: message.createdAt,
});

// What one turn answers: the new assistant message (null when the agent did not run), and earlier
// messages whose approval cards changed, which the app swaps in by ID.
export type TurnReply = {
  title: string;
  message: ReturnType<typeof toDisplay> | null;
  updated: ReturnType<typeof toDisplay>[];
};

// Every query includes the owner, so one person can never read or write another's conversation.
const ownedBy = (identity: Identity) => ({
  workspaceId: identity.workspaceId,
  userId: identity.userId,
});

type PendingApproval = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
};

// Approval requests in the history that have no tool result yet. The agent stops at a request, so
// these all come from the last answer; there can be several when the model asked for more than one
// delete in the same step.
const findPendingApprovals = (messages: ModelMessage[]): PendingApproval[] => {
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type === 'tool-result') answered.add(part.toolCallId);
    }
  }

  const toolNames = new Map<string, string>();
  const pending: PendingApproval[] = [];
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string')
      continue;
    for (const part of message.content) {
      if (part.type === 'tool-call')
        toolNames.set(part.toolCallId, part.toolName);
      if (
        part.type === 'tool-approval-request' &&
        !answered.has(part.toolCallId)
      ) {
        pending.push({
          approvalId: part.approvalId,
          toolCallId: part.toolCallId,
          toolName: toolNames.get(part.toolCallId) ?? '',
        });
      }
    }
  }
  return pending;
};

const NOT_ANSWERED =
  'Not done: the user sent a new message instead of approving, so nothing was deleted.';

// Every tool call needs a result before the model is called again, and the SDK only reads approval
// answers from the very last message. So when the user types instead of answering, the waiting
// calls are closed here as denied, before the new message.
const closePendingApprovals = (
  pending: PendingApproval[],
): ToolModelMessage => ({
  role: 'tool',
  content: pending.map((approval) => ({
    type: 'tool-result',
    toolCallId: approval.toolCallId,
    toolName: approval.toolName,
    output: { type: 'execution-denied', reason: NOT_ANSWERED },
  })),
});

// The saved display with these decisions written into their approval cards. Messages without such
// a card are returned as the same objects, which is how changed ones are told apart.
const withDecisions = (
  display: DisplayMessage[],
  decisions: Map<string, ApprovalDecision>,
) =>
  display.map((message) => {
    const changes = message.parts?.some(
      (part) =>
        part.type === 'deleteApproval' && decisions.has(part.approvalId),
    );
    if (!changes) return message;
    return {
      ...message,
      parts: message.parts?.map((part) =>
        part.type === 'deleteApproval' && decisions.has(part.approvalId)
          ? { ...part, decision: decisions.get(part.approvalId)! }
          : part,
      ),
    };
  });

const changedMessages = (before: DisplayMessage[], after: DisplayMessage[]) =>
  after.filter((message, index) => message !== before[index]).map(toDisplay);

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

const agentFailed = (error: unknown) => {
  console.error('[conversation] the agent failed:', error);
  return new HttpError(502, 'The assistant could not reply. Please try again.');
};

// Streams the run to `send` as it happens, then returns the same values `generate` would.
// A stream does not throw when the model fails halfway: the failure arrives as an `error` part,
// so it is turned into a throw here, and the turn is not saved.
// A run that continues after an approval first executes the approved tools, before its first step.
// Those results are only in the stream, not in `steps`, so their cards are returned separately.
const runAgent = async (
  identity: Identity,
  messages: ModelMessage[],
  abortSignal: AbortSignal,
  send: SendEvent,
) => {
  try {
    const result = await createPostAgent(identity).stream({
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

    let stepStarted = false;
    const approvedCards: DisplayPart[] = [];

    for await (const part of result.stream) {
      if (part.type === 'start-step') stepStarted = true;
      else if (part.type === 'text-delta')
        send({ type: 'text', text: part.text });
      else if (part.type === 'tool-input-start')
        send({ type: 'progress', toolName: part.toolName });
      else if (part.type === 'tool-result') {
        const card = toCardPart(part);
        if (card) send({ type: 'card', part: card });
        if (card && !stepStarted) approvedCards.push(card);
      } else if (part.type === 'error') {
        abortSignal.throwIfAborted();
        throw agentFailed(part.error);
      }
    }
    // A cancelled run ends the stream with an `abort` part instead of an error.
    abortSignal.throwIfAborted();

    return {
      text: await result.text,
      steps: await result.steps,
      responseMessages: await result.responseMessages,
      approvedCards,
    };
  } catch (error) {
    if (abortSignal.aborted || error instanceof HttpError) throw error;
    throw agentFailed(error);
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

// Marks the conversation as busy, so two turns cannot run on the same history at once. Nothing is
// sent before the lock is taken, so a 404 or 409 still reaches the app as a plain error.
const lockConversation = async (identity: Identity, id: string) => {
  const owner = { _id: id, ...ownedBy(identity) };
  const now = new Date();

  const conversation = await ConversationModel.findOneAndUpdate(
    {
      ...owner,
      $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }],
    },
    { $set: { lockedUntil: new Date(now.getTime() + LOCK_MS) } },
  ).lean();

  if (!conversation) {
    const exists = await ConversationModel.exists(owner);
    if (!exists) throw new HttpError(404, 'This conversation was not found.');
    throw new HttpError(
      409,
      'The assistant is still answering your previous message.',
    );
  }
  return conversation;
};

const unlockConversation = (identity: Identity, id: string) =>
  ConversationModel.updateOne(
    { _id: id, ...ownedBy(identity) },
    { $set: { lockedUntil: null } },
  );

const toAnswer = (
  result: Awaited<ReturnType<typeof runAgent>>,
  history: ModelMessage[],
): DisplayMessage => ({
  _id: new Types.ObjectId(),
  role: 'assistant',
  text: result.text,
  parts: [
    ...result.approvedCards,
    ...toDisplayParts(result.steps, [...history, ...result.responseMessages]),
  ],
  attachments: [],
  createdAt: new Date(),
});

// Loads the saved history, adds the new message, runs the agent and saves both sides of the turn.
// The browser sends only the new message, so it cannot change what the model saw before.
export const sendMessage = async (
  identity: Identity,
  id: string,
  body: SendMessageBody,
  abortSignal: AbortSignal,
  send: SendEvent,
): Promise<TurnReply> => {
  const owner = { _id: id, ...ownedBy(identity) };
  const sentAt = new Date();
  const conversation = await lockConversation(identity, id);

  try {
    // Deletes still waiting for an answer are dropped: typing instead of answering means "no".
    const pending = findPendingApprovals(
      conversation.messages as ModelMessage[],
    );
    const closing = pending.length > 0 ? [closePendingApprovals(pending)] : [];
    const display = withDecisions(
      conversation.display,
      new Map(pending.map((approval) => [approval.approvalId, 'expired'])),
    );

    const userMessage = toModelMessage(body.text, body.attachments);
    const history = [
      ...(conversation.messages as ModelMessage[]),
      ...closing,
      userMessage,
    ];
    const result = await runAgent(identity, history, abortSignal, send);

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
    const answer = toAnswer(result, history);

    // Both sides are saved together after the agent finishes, so a failed turn leaves no half of it.
    await ConversationModel.updateOne(owner, {
      $push: {
        messages: {
          $each: [...closing, userMessage, ...result.responseMessages],
        },
      },
      $set: { title, display: [...display, question, answer] },
    });

    return {
      title,
      message: toDisplay(answer),
      updated: changedMessages(conversation.display, display),
    };
  } finally {
    await unlockConversation(identity, id);
  }
};

// Records the user's Approve or Deny on one approval card. When the last answer of that turn is
// in, the agent continues: the SDK runs each approved tool, tells the model about each denied one,
// and the model writes its reply. Until then, only the card is saved.
export const answerApproval = async (
  identity: Identity,
  id: string,
  body: AnswerApprovalBody,
  abortSignal: AbortSignal,
  send: SendEvent,
): Promise<TurnReply> => {
  const owner = { _id: id, ...ownedBy(identity) };
  const conversation = await lockConversation(identity, id);

  try {
    const messages = conversation.messages as ModelMessage[];
    const pending = findPendingApprovals(messages);
    if (!pending.some((approval) => approval.approvalId === body.approvalId)) {
      throw new HttpError(409, 'This request was already answered.');
    }

    // Answers already given to the other waiting requests are kept on their cards.
    const pendingIds = new Set(pending.map((approval) => approval.approvalId));
    const decisions = new Map<string, ApprovalDecision>();
    for (const message of conversation.display) {
      for (const part of message.parts ?? []) {
        if (
          part.type === 'deleteApproval' &&
          pendingIds.has(part.approvalId) &&
          part.decision !== 'pending'
        )
          decisions.set(part.approvalId, part.decision);
      }
    }
    decisions.set(body.approvalId, body.approved ? 'approved' : 'denied');
    const display = withDecisions(conversation.display, decisions);
    const updated = changedMessages(conversation.display, display);

    const waiting = pending.some(
      (approval) => !decisions.has(approval.approvalId),
    );
    if (waiting) {
      await ConversationModel.updateOne(owner, { $set: { display } });
      return { title: conversation.title, message: null, updated };
    }

    const answers: ToolModelMessage = {
      role: 'tool',
      content: pending.map((approval) => ({
        type: 'tool-approval-response',
        approvalId: approval.approvalId,
        approved: decisions.get(approval.approvalId) === 'approved',
      })),
    };
    const history = [...messages, answers];
    const result = await runAgent(identity, history, abortSignal, send);
    const answer = toAnswer(result, history);

    // The answers are saved with the run, so a failed or stopped run can be answered again.
    await ConversationModel.updateOne(owner, {
      $push: {
        messages: { $each: [answers, ...result.responseMessages] },
      },
      $set: { display: [...display, answer] },
    });

    return { title: conversation.title, message: toDisplay(answer), updated };
  } finally {
    await unlockConversation(identity, id);
  }
};
