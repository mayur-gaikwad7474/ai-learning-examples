// STEP 5: the agent behind an HTTP API, so a web page can chat with it instead of the terminal.
//
//   POST /v1/chat   body: { messages: [...the whole conversation so far...] }
//                   reply: { text, responseMessages }
//
// The server keeps no memory between requests. The caller sends the full history each time and
// adds `responseMessages` to it afterwards, exactly like the `messages` array in src/chat.ts.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { Identity } from './schemas/identity.schema.ts';
import { chatRequestSchema } from './schemas/chat.schema.ts';
import { createPostAgent } from './agents/postScheduler.agent.ts';

// 4000-4008 are other Creatosaurus services; 4009 was Muse's old realtime port and stays retired.
const PORT = Number(process.env.PORT ?? 4010);

const readHeader = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
};

// The same rule as post-scheduler-service and connection-service: trust only the identity headers
// the gateway sets, and refuse the request when they are missing instead of guessing.
const requireIdentity = (req: Request, res: Response, next: NextFunction): void => {
  const userId = readHeader(req, 'x-user-id');
  const workspaceId = readHeader(req, 'x-workspace-id');

  if (!userId || !workspaceId) {
    res.status(401).json({ message: 'Unauthorized (Invalid credentials)' });
    return;
  }

  // Same parsing as the other services: an empty X-Roles becomes [], never [''].
  const roles = (readHeader(req, 'x-roles') ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);

  res.locals.identity = { userId, workspaceId, roles } satisfies Identity;
  next();
};

const app = express();

// Conversations grow with every turn, so allow more than Express's 100kb default.
app.use(express.json({ limit: '2mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'ai-learning-examples' });
});

app.post('/v1/chat', requireIdentity, async (req, res) => {
  const parsed = chatRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: z.prettifyError(parsed.error) });
    return;
  }

  const identity = res.locals.identity as Identity;

  // If the browser closes the request, stop the agent so we don't keep paying for the reply.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  try {
    const agent = createPostAgent(identity);
    const result = await agent.generate({
      messages: parsed.data.messages,
      abortSignal: abortController.signal,
      onStepFinish: (step) => {
        for (const call of step.toolCalls) console.log(`  [tool call] ${call.toolName}`, call.input);
        for (const part of step.content) {
          if (part.type === 'tool-error') console.log(`  [tool error] ${part.toolName}`, String(part.error));
        }
      },
    });

    res.json({ text: result.text, responseMessages: result.responseMessages });
  } catch (error) {
    if (abortController.signal.aborted) return;

    // Full details stay in our logs. The caller gets a short, safe message.
    console.error('[chat] the agent failed:', error);
    res.status(502).json({ message: 'The assistant could not reply. Please try again.' });
  }
});

app.listen(PORT, () => {
  console.log(`AI chat API running on http://localhost:${PORT}`);
});
