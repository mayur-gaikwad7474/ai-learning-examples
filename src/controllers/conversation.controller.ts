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

export const createConversation = async (_req: Request, res: Response) => {
  const conversation = await conversationService.createConversation(
    getIdentity(res),
  );
  res.status(201).json(conversation);
};

export const getConversation = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const conversation = await conversationService.getConversation(
    getIdentity(res),
    id,
  );
  res.json(conversation);
};

export const sendMessage = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const body = sendMessageBodySchema.parse(req.body);

  // If the browser closes the request, stop the agent so we don't keep paying for the reply.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  const reply = await conversationService.sendMessage(
    getIdentity(res),
    id,
    body,
    abortController.signal,
  );
  res.json(reply);
};
