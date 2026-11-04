// Controllers read and check the request, call the service, and send the answer. Errors go to
// errorHandler, so there is no try/catch here, except where a streamed reply has already started.
import type { Request, Response } from 'express';
import {
  answerApprovalBodySchema,
  conversationParamsSchema,
  sendMessageBodySchema,
} from '../schemas/conversation.schema.ts';
import { getIdentity } from '../middleware/requireIdentity.ts';
import { HttpError } from '../middleware/errorHandler.ts';
import * as conversationService from '../services/conversation.service.ts';
import type {
  AgentEvent,
  SendEvent,
  TurnReply,
} from '../services/conversation.service.ts';

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

type StreamEvent =
  | AgentEvent
  | ({ type: 'done' } & TurnReply)
  | { type: 'error'; message: string };

type RunTurn = (
  abortSignal: AbortSignal,
  send: SendEvent,
) => Promise<TurnReply>;

// The app asks for a stream with `Accept: application/x-ndjson` and gets one JSON event per line as
// the agent works, ending with `done` (the saved answer) or `error`. Any other request gets the
// whole reply as JSON once it is ready, as before.
const replyToTurn = async (req: Request, res: Response, runTurn: RunTurn) => {
  const streaming = req.get('Accept') === 'application/x-ndjson';

  // If the browser closes the request, stop the agent so we don't keep paying for the reply.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  // Headers go out with the first event, so an error before it still gets its own status code.
  const send = (event: StreamEvent) => {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Cache-Control', 'no-cache');
      // Tells the gateway's nginx to pass each line on instead of buffering the response.
      res.setHeader('X-Accel-Buffering', 'no');
    }
    res.write(`${JSON.stringify(event)}\n`);
  };

  if (!streaming) {
    const reply = await runTurn(abortController.signal, () => {});
    res.json(reply);
    return;
  }

  // The one try/catch in the controllers: once the stream has started, the status code is already
  // sent, so a failure can only be reported as the last event.
  try {
    const reply = await runTurn(abortController.signal, send);
    send({ type: 'done', ...reply });
  } catch (error) {
    if (!res.headersSent) throw error;
    if (!abortController.signal.aborted) {
      if (!(error instanceof HttpError))
        console.error('[http] unexpected error while streaming:', error);
      send({
        type: 'error',
        message:
          error instanceof HttpError
            ? error.message
            : 'Something went wrong. Please try again.',
      });
    }
  }
  res.end();
};

export const sendMessage = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const body = sendMessageBodySchema.parse(req.body);
  await replyToTurn(req, res, (abortSignal, send) =>
    conversationService.sendMessage(
      getIdentity(res),
      id,
      body,
      abortSignal,
      send,
    ),
  );
};

// Approve or Deny on an approval card. Streams like sendMessage, because approving the last waiting
// request runs the agent again.
export const answerApproval = async (req: Request, res: Response) => {
  const { id } = conversationParamsSchema.parse(req.params);
  const body = answerApprovalBodySchema.parse(req.body);
  await replyToTurn(req, res, (abortSignal, send) =>
    conversationService.answerApproval(
      getIdentity(res),
      id,
      body,
      abortSignal,
      send,
    ),
  );
};
