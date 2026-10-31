import { ToolLoopAgent } from 'ai';
import { model } from '../model.ts';
import type { Identity } from '../schemas/identity.schema.ts';
import { listAccounts } from '../tools/accounts.tools.ts';
import { listPosts, schedulePost } from '../tools/posts.tools.ts';
import { currentTime } from '../tools/currentTime.tool.ts';

// Must be exactly the same on every turn of a conversation, so nothing here may change per request.
const INSTRUCTIONS = [
  'You help people schedule social media posts in Creatosaurus.',
  'Use the current time tool before working out any date or time.',
  'Use the account list tool to find account IDs. Never guess an ID.',
  'If a detail for a post is missing, ask for it instead of making it up.',
  'When the user attaches images or videos, their message lists them under "Attached media" with a mediaId. Pass those IDs as mediaIds when scheduling, and never invent a media ID.',
  "also your work is to assist based on the tools you available and we don't have to entertain user with any other information that is not related to the tools and the task at hand.",
].join('\n');

// One agent per request, because the identity changes per request. Creating an agent is cheap:
// it is only a settings object, nothing is sent to the model until `generate` runs.
//
// The keys below are the tool names the model sees, and they are saved in every conversation's
// history and read by the app (account and post cards). Rename the variables freely, but change a
// key only together with the app.
export const createPostAgent = (identity: Identity) =>
  new ToolLoopAgent({
    model: model,
    instructions: INSTRUCTIONS,
    tools: {
      postSchedular: schedulePost,
      accountList: listAccounts,
      currentTime: currentTime,
      listPosts: listPosts,
    },
    toolsContext: {
      postSchedular: identity,
      accountList: identity,
      listPosts: identity,
    },

    onStepStart({ stepNumber, modelId }) {
      console.log(`Step ${stepNumber} starting`, { modelId });
    },
    onToolExecutionStart({ toolCall }) {
      console.log(`Tool call starting: ${toolCall.toolName}`);
    },
    onToolExecutionEnd({ toolCall, toolExecutionMs, toolOutput }) {
      console.log(
        `Tool call finished: ${toolCall.toolName} (${toolExecutionMs}ms)`,
        {
          success: toolOutput.type === 'tool-result',
        },
      );
    },
    onStepEnd({ stepNumber, usage, performance, finishReason, toolCalls }) {
      console.log(`Step ${stepNumber} completed:`, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        outputTokensPerSecond: performance.effectiveOutputTokensPerSecond,
        stepTimeMs: performance.stepTimeMs,
        finishReason,
        toolsUsed: toolCalls?.map((tc) => tc.toolName),
      });
    },
    onEnd({ usage, steps }) {
      console.log('Agent finished:', {
        totalSteps: steps.length,
        totalTokens: usage.totalTokens,
      });
    },
  });
