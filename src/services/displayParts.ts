// Turns one agent run into the parts the app shows.
//
// The agent works in steps. In each step the model writes some text and/or calls tools, and the
// tool results come back before the next step. We walk the steps in order and keep:
//   - text the model wrote, as `text` parts
//   - list results the model marked showToUser: true, as card parts
//   - posts it scheduled or edited, as confirmation cards
// Everything else (results it only needed for another step, failed calls, other tools) stays out.
import type { StepResult, TypedToolResult } from 'ai';
import type { PostAgentTools } from '../agents/postScheduler.agent.ts';
import type { DisplayPart } from '../schemas/conversation.schema.ts';

type PostAgentStep = StepResult<PostAgentTools>;

// A finished step's content and a live stream both carry tool results in this shape, so the same
// card is built either way: from `steps` after the run, or from `result.stream` as it happens.
type ToolResultPart = { type: 'tool-result' } & TypedToolResult<PostAgentTools>;

export const toCardPart = (part: ToolResultPart): DisplayPart | null => {
  if (part.dynamic) return null;

  // Checking toolName lets TypeScript know the exact input and output of that tool.
  if (part.toolName === 'accountList') {
    const { input, output } = part;
    if (!input.showToUser || !output.success) return null;
    return { type: 'accounts', accounts: output.accounts };
  }

  if (part.toolName === 'listPosts') {
    const { input, output } = part;
    if (!input.showToUser || !output.success) return null;
    return { type: 'posts', posts: output.posts, hasMore: output.hasMore };
  }

  // A post that was created or changed is always worth showing, so these need no showToUser.
  // A failed attempt shows no card: the model explains it in its text.
  // The caption and media come from the input because the service saved exactly what we sent.
  if (part.toolName === 'postSchedular') {
    const { input, output } = part;
    if (!output.success) return null;
    return {
      type: 'scheduledPost',
      postId: output.postId,
      account: {
        name: output.account,
        platform: output.platform,
        profileURL: output.profileURL,
      },
      caption: input.caption,
      mediaCount: input.mediaIds?.length ?? 0,
      scheduledTime: output.scheduledTime,
      timeZone: input.timeZone,
      scheduled: output.scheduled,
    };
  }

  if (part.toolName === 'editPost') {
    const { input, output } = part;
    if (!output.success) return null;
    return {
      type: 'editedPost',
      postId: output.postId,
      status: output.status,
      scheduledTime: output.scheduledTime,
      timeZone: output.timeZone,
      scheduled: output.scheduled,
      changes: {
        caption: input.caption ?? null,
        time: input.scheduledTime !== undefined,
        mediaCount: input.mediaIds?.length ?? null,
      },
    };
  }

  return null;
};

export const toDisplayParts = (steps: PostAgentStep[]): DisplayPart[] => {
  const parts: DisplayPart[] = [];

  for (const step of steps) {
    for (const content of step.content) {
      if (content.type === 'text') {
        const text = content.text.trim();
        if (!text) continue;

        // Text from two steps in a row, with no card between them, reads as one message.
        const previous = parts.at(-1);
        if (previous?.type === 'text') previous.text += `\n\n${text}`;
        else parts.push({ type: 'text', text });
        continue;
      }

      if (content.type !== 'tool-result') continue;
      const card = toCardPart(content);
      if (card) parts.push(card);
    }
  }

  return parts;
};
