import { ToolLoopAgent } from 'ai';
import { model } from '../model.ts';
import type { Identity } from '../schemas/identity.schema.ts';
import { listAccounts } from '../tools/accounts.tools.ts';
import { listPosts, schedulePost} from '../tools/posts.tools.ts';
import { currentTime} from '../tools/currentTime.tool.ts';

// Must be exactly the same on every turn of a conversation, so nothing here may change per request.
const INSTRUCTIONS = [
  'You help people schedule social media posts in Creatosaurus.',
  'Use the current time tool before working out any date or time.',
  'Use the account list tool to find account IDs. Never guess an ID.',
  'If a detail for a post is missing, ask for it instead of making it up.',
  'When the user attaches images or videos, their message lists them under "Attached media" with a mediaId. Pass those IDs as mediaIds when scheduling, and never invent a media ID.',
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
  });
