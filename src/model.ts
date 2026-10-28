// STEP 1: the model.
//
// A "model" is the AI brain. The Vercel AI SDK talks to each AI company through a "provider".
// Each provider reads its own API key from .env (Anthropic reads ANTHROPIC_API_KEY).
//
// The registry lets you pick a model by name in .env, as "provider:model":
//   AI_MODEL=anthropic:claude-opus-5-5
//   AI_MODEL=anthropic:claude-haiku-5-5
//
// To try another company later, install its provider (for example `npm i @ai-sdk/openai`),
// add it below, put its key in .env, and set AI_MODEL=openai:<model>. Nothing else changes.
import { anthropic } from '@ai-sdk/anthropic';
import { createProviderRegistry } from 'ai';

const providers = { anthropic };
const registry = createProviderRegistry(providers);

type ModelName = `${keyof typeof providers}:${string}`;

export const model = registry.languageModel(
  (process.env.AI_MODEL ?? 'anthropic:claude-haiku-5-5') as ModelName,
);
