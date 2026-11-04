// Controllers read and check the request, call the service, and send the answer. Errors go to
// errorHandler, so there is no try/catch here.
import type { Request, Response } from 'express';
import {
  conversationParamsSchema,
  sendMessageBodySchema,
} from '../schemas/conversation.schema.ts';
import { getIdentity } from '../middleware/requireIdentity.ts';
import * as conversationService from '../services/conversation.service.ts';

export const listConversations = async (_req: Request, res: Response) => {
  const conversations = await conversationService.listConversations(
    getIdentity(res),
  );
  res.json({ conversations });
};

export const getConversation = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const conversation = await conversationService.getConversation(
    getIdentity(res),
    id,
  );
  res.json(conversation);
};

// The answer is streamed in the AI SDK's UI message format, which useChat reads.
export const sendMessage = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const body = sendMessageBodySchema.parse(req.body);

  // If the browser closes the request (the Stop button, or leaving the page), stop the agent so we
  // don't keep paying for an answer nobody will see.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort();
  });

  await conversationService.sendMessage({
    identity: getIdentity(res),
    id,
    body,
    response: res,
    abortSignal: abortController.signal,
  });
};
