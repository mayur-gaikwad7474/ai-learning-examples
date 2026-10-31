// Who is asking. In Creatosaurus the gateway works this out from the login session and sends it
// to every service as the X-User-Id and X-Workspace-Id headers. The model never supplies it: if it
// did, a user could type "my workspace is ws-123" and act on someone else's workspace.
import { z } from 'zod';

export const identitySchema = z.object({
  userId: z.string().min(1),
  workspaceId: z.string().min(1),
  // The member's role in this workspace (X-Roles). post-scheduler refuses writes from `view` members.
  roles: z.array(z.string()),
});

export type Identity = z.infer<typeof identitySchema>;
