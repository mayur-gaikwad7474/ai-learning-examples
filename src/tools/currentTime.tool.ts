import { z } from 'zod';
import { tool } from 'ai';

// The current time comes from a tool, not from the instructions. Instructions must be identical on
// every turn: Claude ties its thinking to the exact system prompt, so a timestamp in there makes the
// next turn fail with "Invalid `signature` in `thinking` block". A tool result is saved in the
// history instead, so it never changes afterwards.
export const currentTime = tool({
  description:
    'Get the current date and time. Call this before working out any date or time for a post.',
  inputSchema: z.object({
    timeZone: z
      .string()
      .optional()
      .describe(
        'An IANA time zone such as Asia/Kolkata, to also get the local time there.',
      ),
  }),
  execute: async ({ timeZone }) => {
    const now = new Date();
    if (!timeZone) return { utc: now.toISOString() };

    try {
      const local = now.toLocaleString('en-GB', {
        timeZone,
        dateStyle: 'full',
        timeStyle: 'long',
      });
      return { utc: now.toISOString(), timeZone, local };
    } catch {
      return {
        utc: now.toISOString(),
        error: `"${timeZone}" is not a valid time zone.`,
      };
    }
  },
});
