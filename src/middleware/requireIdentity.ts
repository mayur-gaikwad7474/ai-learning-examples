import type { NextFunction, Request, Response } from 'express';
import type { Identity } from '../schemas/identity.schema.ts';

const readHeader = (req: Request, name: string): string | undefined => {
  const value = req.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single && single.length > 0 ? single : undefined;
};

// The same rule as post-scheduler-service and connection-service: trust only the identity headers
// the gateway sets, and refuse the request when they are missing instead of guessing.
export const requireIdentity = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
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

export const getIdentity = (res: Response): Identity =>
  res.locals.identity as Identity;
