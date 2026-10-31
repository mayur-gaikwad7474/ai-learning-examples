import { z } from 'zod'

// Output: post-scheduler answers errors as { error: { message } }. The message is written for people.
export const serviceErrorResponseSchema = z.object({
    error: z.object({ message: z.string() }),
})
