# Lesson 7: Streaming

Notes for lesson 7 of [LEARNING-PATH.md](../LEARNING-PATH.md). The AI SDK details were checked against the
installed `ai@7` (7.0.153) source, and the gateway details against `gateway/nginx.conf`, on 2026-11-03.

> **Name change in `ai@7`:** the learning path says `fullStream`. In the installed version `fullStream` is
> deprecated; the same stream of events is now **`result.stream`**. Older tutorials also call a text chunk's
> content `textDelta`; in `ai@7` it's `text`. These notes use the current names.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [AI SDK: Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text) | Read | `streamText`, `textStream`, the full event stream, `onError`, `smoothStream`. **Start here**, with the streaming sections. |
| 2 | [How to Stream API Responses (Like An AI Chat)](https://www.youtube.com/watch?v=XVCU4WkIwiY) | Video | Streaming from first principles: why a chat answer arrives word by word, and how a server sends it |
| 3 | [A Complete Guide To Vercel's AI SDK](https://www.youtube.com/watch?v=mojZpktAiYQ) | Video | Has a `streamText` chapter next to `generateText`, tools and structured output |
| 4 | [Simplify chatbot logic with useChat in AI SDK!](https://www.youtube.com/watch?v=BMge7SVA5t4) | Video | The `useChat` hook on the browser side: messages, input and loading states |
| 5 | [Build a Chatbot with Vercel AI SDK v5](https://www.youtube.com/watch?v=lp1RtS7RKtw) | Video | Optional. A full streaming chat from server to UI, on the AI SDK 5 API that `ai@7` grew from |
| 6 | [AI SDK: streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) | Read | Every option and every field of the result |
| 7 | [AI SDK: Stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) | Read | What actually travels to the browser: the text stream vs the UI message stream |
| 8 | [High Performance Browser Networking: Server-Sent Events](https://hpbn.co/server-sent-events-sse/) | Read | Optional, deep. How SSE works on the wire, its limits, and why it suits one-way streams |

The videos (2 to 5) are third-party and were chosen by title and description; I couldn't watch them.
Some are older than `ai@7`, so expect `fullStream` and `textDelta` in their code. If you only have time for
one thing: resource 1's streaming sections, then video 2.

---

## The core idea

**`generateText` makes the user wait for the whole answer. `streamText` shows it as it's being written.**
The model takes the same time and costs the same either way; streaming changes what the user sees while
they wait.

Today your assistant uses `agent.generate()`. For "schedule this post", the agent runs four steps (time,
accounts, schedule, answer), and the user watches the three bouncing dots in
[AssistantHome.jsx](../../app-creatosaurus/src/modules/assistant/pages/AssistantHome.jsx) the whole time.
With streaming, the same run could show "Checking your accounts…", then "Scheduling your post…", then the
answer appearing word by word.

```
generate:  [········· waiting ·········] → whole answer at once
stream:    [checking accounts][scheduling] Your·post·for·The·Dev·Corp·is·scheduled…
```

---

## 1. Why streaming feels faster

Two different times matter:

| Time | What it is | Changes with streaming? |
|---|---|---|
| **Time to first token** | How long until the first word appears | Yes: a fraction of a second instead of the whole run |
| **Total time** | How long until the answer is complete | No: the model writes at the same speed |

People judge speed by how long they stare at nothing. A 10-second answer that starts after half a second
feels much faster than a 10-second answer that appears all at once. For an agent, the gap is bigger: every
tool step adds time *before* the answer, and streaming lets you show those steps as progress instead of
silence.

What streaming doesn't do: it doesn't save tokens or money, and it doesn't make the model think faster.
Lesson 18 covers making it actually faster.

## 2. Text stream vs full event stream

```ts
import { streamText } from 'ai';

const result = streamText({ model, prompt: 'Write a short caption about Monday mornings.' });

// Text only: just the words, as they arrive.
for await (const text of result.textStream) process.stdout.write(text);
```

`streamText` returns immediately; you read the result as it arrives. It gives you two ways to read it:

| | `result.textStream` | `result.stream` (was `fullStream`) |
|---|---|---|
| Contains | Only the text, as strings | Every event: text, tool calls, tool results, steps, errors, the end |
| Errors | **Not shown.** Use `onError`. | Arrive as `error` parts |
| Use it for | A plain text answer with no tools | Agents, progress, anything beyond the words |

The events you'll use from `result.stream` (field names from the installed types):

| `part.type` | Means | Useful fields |
|---|---|---|
| `start-step` | A model call started | |
| `text-delta` | A few more characters of text | `part.text` |
| `reasoning-delta` | A bit of the model's reasoning, if it's shown | `part.text` |
| `tool-input-start` | The model started writing a tool call | `part.toolName` |
| `tool-call` | The tool call is complete and about to run | `part.toolName`, `part.input` |
| `tool-result` | Your `execute` finished | `part.toolName`, `part.output` |
| `tool-error` | Your `execute` threw | `part.toolName`, `part.error` |
| `finish-step` | That model call ended | `part.finishReason`, `part.usage` |
| `finish` | The whole run ended | `part.finishReason`, `part.totalUsage` |
| `error` | Something went wrong | `part.error` |
| `abort` | The run was cancelled | |

**Streams don't throw like `generate` does.** With `generateText`, a failed model call throws and your
`try/catch` handles it. With `streamText`, the call has already returned; an error mid-answer shows up as an
`error` part, and is passed to `onError`, which by default just does `console.error` (from the installed
source). If you only read `textStream`, an error looks like an answer that simply stopped. Always handle
`error` parts or pass `onError`.

### Agents stream too

`agent.stream()` runs the same loop as `agent.generate()` and streams every step. It returns a promise, so
`await` it first:

```ts
const result = await createPostAgent(identity).stream({ prompt });

for await (const part of result.stream) {
  if (part.type === 'text-delta') process.stdout.write(part.text);
}
```

Everything `generate` gives you is still there, as promises that resolve when the stream ends:
`await result.text`, `await result.steps`, `await result.usage`, `await result.responseMessages`.

### Smoother text

Models send text in uneven bursts. `smoothStream` re-chunks it into words or lines for a steadier look:

```ts
streamText({ model, prompt, experimental_transform: smoothStream({ chunking: 'word' }) });
```

It's purely cosmetic: same text, same speed overall.

## 3. Showing tool progress

The three tool events tell you how far a tool call has got:

```
tool-input-start  → the model decided to call it        "Checking your accounts…"
tool-call         → the input is complete, it's running
tool-result       → done (or tool-error: it failed)     "✓ Accounts" / show the card
```

`tool-input-start` comes first, as soon as the model starts writing the call, so it's the right moment to
show "Checking your accounts…". Map your tool names to words people understand:

```ts
const PROGRESS: Record<string, string> = {
  currentTime: 'Checking the time…',
  accountList: 'Checking your accounts…',
  listPosts: 'Looking at your posts…',
  postSchedular: 'Scheduling your post…',
  editPost: 'Updating your post…',
};

for await (const part of result.stream) {
  switch (part.type) {
    case 'text-delta':
      process.stdout.write(part.text);
      break;
    case 'tool-input-start':
      process.stdout.write(`\n[${PROGRESS[part.toolName] ?? `Running ${part.toolName}…`}]\n`);
      break;
    case 'tool-error':
      process.stdout.write(`\n[${part.toolName} failed]\n`);
      break;
    case 'error':
      process.stdout.write('\n[Something went wrong. Please try again.]\n');
      break;
    case 'finish':
      console.log(`\n(tokens: ${part.totalUsage.inputTokens} in, ${part.totalUsage.outputTokens} out)`);
      break;
  }
}
```

**This connects to your cards.** Today the server builds `parts` after the whole run (`toDisplayParts`). In a
streamed chat, an account card can appear the moment `accountList`'s `tool-result` arrives, before the model
has written its sentence. That's the "streaming those parts live" item in lesson 21.

## 4. Sending a stream to a browser

The browser can't read a JavaScript stream on your server; the stream has to travel over HTTP. The AI SDK
uses **Server-Sent Events (SSE)**: one normal HTTP response that stays open, with the server writing small
events into it as they happen (resource 8).

There are two formats, from resource 7:

| Format | Express | Contains | Read with |
|---|---|---|---|
| Text stream | `result.pipeTextStreamToResponse(res)` | Only the text | `fetch` and read the body |
| **UI message stream** | `result.pipeUIMessageStreamToResponse(res)` | Text, tool calls and results, steps, errors | `useChat` from `@ai-sdk/react` |

For a chat with tools, you want the UI message stream; `useChat` on the browser turns it back into messages
with `text` parts and `tool-<name>` parts, each with a state (`input-available`, `output-available`,
`output-error`). In Express:

```ts
// The same route as today, but streaming the answer instead of returning JSON.
export const sendMessage = async (req: Request, res: Response) => {
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abortController.abort();
  });

  const result = await createPostAgent(getIdentity(res)).stream({
    messages,
    abortSignal: abortController.signal,
  });
  result.pipeUIMessageStreamToResponse(res);
};
```

`useChat` isn't in `app-creatosaurus` yet (`npm i @ai-sdk/react`); moving the assistant page to it is
lesson 21's build.

### Your stack: three things that break streaming

1. **Compression buffers it.** `ai-service` uses the `compression()` middleware. Compression collects output
   before sending it, so a streamed answer arrives all at once at the end. Skip compression for streams:

   ```ts
   app.use(compression({
     filter: (req, res) =>
       !String(res.getHeader('Content-Type')).startsWith('text/event-stream') &&
       compression.filter(req, res),
   }));
   ```

2. **The gateway is already fine.** nginx buffers responses by default, which would also hold the stream
   back. But the AI SDK's stream responses send `x-accel-buffering: no` (from the installed source), which
   tells nginx not to buffer that response, so `/ai/` needs no change.
3. **Silence can trip the timeout.** The gateway's `proxy_read_timeout 130s` counts time *between* bytes. A
   streamed answer that keeps sending text never hits it, but a tool call that runs a long time without any
   output could. `pipeUIMessageStreamToResponse(res, { keepAliveMs: 15_000 })` sends a small keep-alive
   comment when the stream has been quiet that long.

### Saving the conversation

Today you save both sides of a turn after `generate` finishes. With a stream, the answer finishes *after*
your route has started responding. Wait for the promises (`await result.responseMessages`), then save, the
same way. Keep the rule you already have: save the whole turn only when it completes, never half of it.

## 5. Cancelling

A user can stop an answer they don't want: `useChat` has a `stop()` function. That closes the request, and
your server should stop the agent so you stop paying for it.

Your [conversation.controller.ts](../src/controllers/conversation.controller.ts) already does the server half:
`res.on('close')` aborts the `AbortController`, and the same signal goes into the agent and every tool's
`fetch`. With streaming, the same code stops the stream mid-answer. What happens then:

- The stream emits an `abort` part and ends. `onAbort` runs if you passed one.
- The text so far was already sent; the user keeps what they saw.
- A tool that already ran **has already happened**. If `postSchedular` finished before the stop, the post
  exists. Cancelling stops the *rest* of the answer, not what's done. (Approval before risky tools is
  lesson 13.)
- Decide what to save. The simplest safe rule matches what you do today: if the turn didn't finish, save
  nothing to the model history.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `streamText({ model, prompt \| messages, tools, ... })` | Like `generateText`, but returns at once and streams the answer |
| `agent.stream({ prompt \| messages })` | The agent loop, streamed. Returns a promise: `await` it. |
| `result.textStream` | Only the text, as strings. No errors. |
| `result.stream` | Every event (`text-delta`, `tool-input-start`, `tool-call`, `tool-result`, `tool-error`, `finish-step`, `finish`, `error`, `abort`…). `fullStream` is the deprecated name. |
| `await result.text` / `.steps` / `.usage` / `.responseMessages` | The same values as `generate`, once the stream ends |
| `onError` | Called for errors mid-stream. Default: `console.error`. |
| `onAbort` | Called when the run is cancelled |
| `experimental_transform: smoothStream({ chunking })` | Steadier text, by `'word'` or `'line'` |
| `result.pipeUIMessageStreamToResponse(res, { keepAliveMs })` | Send the full stream to an Express response, for `useChat` |
| `result.pipeTextStreamToResponse(res)` | Send only the text |
| `result.toUIMessageStreamResponse()` | The same as a web `Response`, for fetch-style servers |
| `result.consumeStream()` | Read the stream to the end without using it, so the promises resolve |
| `useChat` (`@ai-sdk/react`) | The browser side: messages, streaming state, `stop()` |

---

## Build: stream the post agent in the terminal

The exercise in `LEARNING-PATH.md` uses the weather agent, which is gone from this project. Use your post
agent with a **read-only** prompt, so nothing is scheduled.

1. **Set up a test identity.** Add `TEST_USER_ID` and `TEST_WORKSPACE_ID` to `.env`, with your own IDs (your
   saved conversations in MongoDB have them). The tools need a real workspace to read from.
2. **Stream it:** `src/lessons/07-stream.ts` creates `createPostAgent(identity)`, calls `.stream()` with
   "Which accounts are connected, and what's scheduled this week?", and prints `text-delta` as it arrives
   and `[Checking your accounts…]` on each `tool-input-start`, using the `PROGRESS` map from section 3.
   Handle `tool-error`, `error` and `finish` too.
3. **Measure the difference.** Record the time to the first `text-delta` and the total time. Then run the
   same prompt with `.generate()` and record its total time.
4. **Cancel it.** Add an `AbortController`, pass its signal, and call `abort()` on Ctrl+C
   (`process.on('SIGINT', …)`). Stop a run halfway and print what parts you got, including `abort`.
5. **Optional:** add `smoothStream({ chunking: 'word' })` and compare how it looks.

Record what you found:

| Version | Time to first text | Total time | Notes |
|---|---|---|---|
| `generate` | (same as total) | | |
| `stream` | | | Did the progress lines appear before the text? |
| `stream`, cancelled | | | Which parts arrived after you pressed Ctrl+C? |

---

## Done when: self-check

- [ ] **Explain `textStream` vs `stream`** (the old `fullStream`): what each contains, and why an error can
      be invisible in one of them.
- [ ] **Show tool progress while streaming:** your terminal run prints a progress line for each tool before
      the answer.

Extra checks:

- Streaming doesn't make the model faster. So what exactly gets faster, and why do users care?
- Why does a `try/catch` around `streamText` not catch a model error halfway through the answer?
- Your streamed answer arrives all at once at the end in production but not locally. Name two things that
  could be buffering it in your stack.
- The user presses Stop after `postSchedular` ran. Does the post exist? What should be saved?
- When would you choose `pipeTextStreamToResponse` over `pipeUIMessageStreamToResponse`?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- AI SDK: [Generating Text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text),
  [streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
  [Stream protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol),
  [Chatbot tool usage](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage)
- SSE: [High Performance Browser Networking: Server-Sent Events](https://hpbn.co/server-sent-events-sse/)
- Videos (third-party, not reviewed): [How to Stream API Responses](https://www.youtube.com/watch?v=XVCU4WkIwiY),
  [A Complete Guide To Vercel's AI SDK](https://www.youtube.com/watch?v=mojZpktAiYQ),
  [Simplify chatbot logic with useChat](https://www.youtube.com/watch?v=BMge7SVA5t4),
  [Build a Chatbot with Vercel AI SDK v5](https://www.youtube.com/watch?v=lp1RtS7RKtw)
