import { ToolLoopAgent } from 'ai';
import { model } from '../model.ts';
import type { Identity } from '../schemas/identity.schema.ts';
import { listAccounts } from '../tools/accounts.tools.ts';
import { editPost, listPosts, schedulePost } from '../tools/posts.tools.ts';
import { currentTime } from '../tools/currentTime.tool.ts';

// Must be exactly the same on every turn of a conversation, so nothing here may change per request.
const INSTRUCTIONS = [
  'You help people schedule social media posts in Creatosaurus.',
  'Use the current time tool before working out any date or time.',
  'Use the account list tool to find account IDs. Never guess an ID.',
  'When you call the account list or post list tool with showToUser: true, the app shows the results to the user as cards. Account cards show the name, platform and whether it needs reconnecting. Post cards show the time, status, accounts, caption, per-account result and errors. Do not list the accounts or posts again in your reply. Write one or two sentences instead: a short summary (how many, what stands out), anything that needs attention (an account to reconnect, a failed post), or what the user can do next.',
  'After you schedule or edit a post successfully, the app shows a confirmation card with the account, time, caption, media and what changed. Do not repeat those details. Confirm in one short sentence, and mention anything the card cannot say, such as a problem with another post in the same request.',
  'If a detail for a post is missing, ask for it instead of making it up.',
  'When the user attaches images or videos, their message lists them under "Attached media" with a mediaId. Pass those IDs as mediaIds when scheduling, and never invent a media ID.',
  "also your work is to assist based on the tools you available and we don't have to entertain user with any other information that is not related to the tools and the task at hand.",
].join('\n');

// The keys are the tool names the model sees. They are saved in every conversation's history, and
// services/displayParts.ts reads them to build the account and post cards. Rename the variables
// freely, but change a key only together with displayParts.ts.
const tools = {
  postSchedular: schedulePost,
  accountList: listAccounts,
  currentTime: currentTime,
  listPosts: listPosts,
  editPost: editPost,
};

export type PostAgentTools = typeof tools;

// One agent per request, because the identity changes per request. Creating an agent is cheap:
// it is only a settings object, nothing is sent to the model until `generate` runs.
export const createPostAgent = (identity: Identity) =>
  new ToolLoopAgent({
    model: model,
    instructions: INSTRUCTIONS,
    tools,
    toolsContext: {
      postSchedular: identity,
      accountList: identity,
      listPosts: identity,
      editPost: identity,
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
