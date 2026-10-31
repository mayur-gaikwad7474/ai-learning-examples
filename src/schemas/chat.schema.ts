// Input: the body of POST /v1/chat. The caller sends the whole conversation so far each time.
import { modelMessageSchema } from 'ai';
import { z } from 'zod';

export const chatRequestSchema = z.object({
  messages: z
    .array(modelMessageSchema)
    .min(1, 'Send at least one message.')
    .refine((messages) => messages.at(-1)?.role === 'user', 'The last message must be from the user.'),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;
