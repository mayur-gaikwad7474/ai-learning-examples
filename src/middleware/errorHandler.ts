import type { ErrorRequestHandler } from 'express';
import { z } from 'zod';

// Thrown by services for answers the caller should see, like 404 or 409.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

// Express 5 sends errors from async handlers here, so controllers need no try/catch.
// Full details stay in our logs. The caller gets a short, safe message.
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof HttpError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  if (error instanceof z.ZodError) {
    res.status(400).json({ message: z.prettifyError(error) });
    return;
  }
  // The caller closed the request, so there is nobody to answer.
  if (error instanceof Error && error.name === 'AbortError') return;
  // Bad JSON in the body, from express.json().
  if (error?.type === 'entity.parse.failed') {
    res.status(400).json({ message: 'The request body is not valid JSON.' });
    return;
  }

  console.error('[http] unexpected error:', error);
  res.status(500).json({ message: 'Something went wrong. Please try again.' });
};
