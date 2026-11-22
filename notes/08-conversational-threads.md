# Lesson 8: Conversational threads

Notes for lesson 8 of [LEARNING-PATH.md](../LEARNING-PATH.md). The AI SDK details were checked against the
installed `ai@7` (7.0.153) source and its bundled docs
(`node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx`), and the Creatosaurus details
against this project and `ai-service`, on 2026-11-22.

> **Name changes in `ai@7`:** older docs say `result.response.messages`. In the installed version
> `result.response` is deprecated; the messages a call produced are now **`result.responseMessages`**
> (on a stream, `await result.responseMessages`). The UI stream helpers' `onFinish` is deprecated too; it's
> now **`onEnd`**. [conversation.service.ts](../src/services/conversation.service.ts) still uses `onFinish`,
> which works but will go away. These notes use the current names.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [AI SDK: Chatbot message persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence) | Read | Saving and loading UI messages, chat and message IDs, validating saved messages, sending only the last message. **Start here.** |
| 2 | [Claude docs: Working with messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages) | Read | The raw API view: the Messages API is stateless, so you send the whole conversation every time |
| 3 | [This is why LLMs have no memory](https://www.youtube.com/watch?v=_J7WXeRHE38) | Video | Why each API call starts fresh, and where "memory" in a chat really comes from |
| 4 | [AI Agents with History and Persistence Memory](https://www.youtube.com/watch?v=xkkgeLOA214) | Video | Several threads per user, saved in SQLite locally and Postgres in production |
| 5 | [AI SDK: Prompts](https://ai-sdk.dev/docs/foundations/prompts) | Read | The model message types (`system`, `user`, `assistant`, `tool`) and their content parts |
| 6 | [AI SDK: Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot) | Read | Optional. The browser side: `useChat`, `messages`, `parts`, and what the hook keeps in memory |
| 7 | [AI on Rails: Persisting chat history](https://www.youtube.com/watch?v=ZbtjropEwPk) | Video | Optional. The same problem in another stack: a chat that continues after a reload |

The videos (3, 4 and 7) are third-party and were chosen by title and description; I couldn't watch them.
Video 7 uses Rails, so its code won't map to yours, only the idea. If you only have time for one thing:
resource 1, then video 3.

---

## The core idea

**The model doesn't remember anything. Your app does.** Every model call is a fresh start: the model sees
only what you send in that request. A "conversation" is your code sending the earlier messages again,
every turn.

```
Turn 1:  [instructions] [user: weather in Pune?]                                        → "31°C, sunny"
Turn 2:  [instructions] [user: weather in Pune?] [assistant: 31°C, sunny] [user: and tomorrow?] → "33°C"
Turn 3:  [instructions] [ …everything above… ] [user: …]                                → …
```

So a thread is three jobs for your code:

1. **Keep** the messages (in memory, a file or a database).
2. **Send** the relevant ones with each new question.
3. **Pick** which ones: the more you send, the more every turn costs (section 7).

---

## 1. Models remember nothing between calls

Two separate calls:

```ts
await generateText({ model, prompt: 'My name is Sam.' });
const result = await generateText({ model, prompt: "What's my name?" });
// → "I don't know your name."
```

The second call knows nothing about the first. There's no session on the provider's side; the Claude
docs (resource 2) put it plainly: the Messages API is stateless, so you always send the full conversation.

This is why "and tomorrow?" fails on its own. "Tomorrow" of what, where? The question only makes sense
next to the earlier turn about Pune.

ChatGPT and Claude.ai *feel* like they remember because their app does what this lesson teaches: it saves
your messages and sends them back each time. (Some providers now offer threads stored on their side;
Anthropic has one in beta. The AI SDK doesn't use them, and keeping the history yourself works with any
model.)

## 2. Sending history every turn

Instead of `prompt`, pass `messages`: the conversation so far, ending with the new question.

```ts
import type { ModelMessage } from 'ai';

const messages: ModelMessage[] = [];

async function ask(text: string) {
  messages.push({ role: 'user', content: text });
  const result = await agent.generate({ messages });
  // Everything the model produced this turn: its text, its tool calls and their results.
  messages.push(...result.responseMessages);
  return result.text;
}

await ask("What's the weather in Pune?");
await ask('And tomorrow?'); // works: the first turn is in `messages`
```

Two details matter:

- **Push `responseMessages`, not just `result.text`.** An agent turn is more than its final sentence. It
  includes the assistant's tool calls and the `tool` messages with their results. If you save only the
  text, the next turn can't see that `accountList` returned three accounts, and the model may call it
  again or guess.
- **Order is fixed.** A tool call must be followed by its result, and the history should start with a
  `user` message. A thread that breaks these rules is refused by the provider. This is why a half-finished
  answer is dangerous to save (section 5).

## 3. UI messages vs model messages

The AI SDK has two message formats, for two different readers:

| | `UIMessage` | `ModelMessage` |
|---|---|---|
| For | Your app and the browser | The model |
| Shape | `{ id, role, parts: [...] }` | `{ role, content }` (`system`, `user`, `assistant`, `tool`) |
| Tool calls | One part per call, `tool-<name>`, with its input, output **and state** (`input-available`, `output-available`, `output-error`, `approval-requested`…) | A tool call in an `assistant` message, its result in a separate `tool` message |
| Has an `id` | Yes, every message | No |
| Extras | `data-*` parts (your own, like attachments), `metadata`, full tool output for cards | Only what the model should read |
| Made by | `useChat`, and the UI stream (`pipeAgentUIStreamToResponse`) | `convertToModelMessages(uiMessages)`, and `result.responseMessages` |

**Store UI messages.** The AI SDK docs recommend it (resource 1), and both your projects do it:

- A UI message has everything needed to show the chat again: the reopened chat shows the same account and
  post cards it showed live.
- It can always be turned into model messages; the other way round loses things (IDs, states, data parts).
- `convertToModelMessages(messages, { tools })` runs each tool's `toModelOutput` when it converts. So the
  saved `listPosts` part keeps the media URLs for the cards, and the model still sees only `"media":
  ["image"]` (lesson 3).

In this project, [conversation.service.ts](../src/services/conversation.service.ts) hands UI messages to
`pipeAgentUIStreamToResponse` (`uiMessages`), which does the conversion for you. Your own `data-attachments`
part has no model equivalent, so `convertDataPart: attachmentsForModel` turns it into a line of text with
each file's `mediaId`.

**Not every saved part should reach the model.** `ai-service`'s
[chatHistory.ts](../../ai-service/src/services/chatHistory.ts) (`toAgentHistory`) removes some before
converting:

| Left out | Why |
|---|---|
| `reasoning` parts | Claude signs its thinking against the exact conversation it was written in, and refuses it when replayed into one that differs at all. Earlier turns' thinking isn't needed anyway. |
| Tool calls with no result | From a stopped answer. The model can't be shown a call without its result. |
| Messages that no longer match today's tools | A call saved before a tool's input changed. Without this, one old message breaks the chat forever. |

The rule: **what you save is for people; what you send is chosen from it.**

## 4. Display parts, and why there's now only one list

Your first version saved two lists per conversation: `messages` (model history) and `display` (what
people see), with `parts` on assistant answers and a fallback of `[{ type: 'text', text }]` for answers
saved before parts existed.

That works, but two lists can drift apart, and you have to write both on every turn. Saving UI messages
makes `display` unnecessary: the UI message *is* the display, and the model history is computed from it
each turn (section 3).

The fallback idea is still worth keeping: **saved data outlives your code.** When the format changes, you
either migrate old documents, read them with a fallback, or (what this project did) save the new format
somewhere new. `ConversationModel` uses the `chats` collection, and the old `conversations` collection is
no longer read.

## 5. Saving and resuming threads

A thread needs two kinds of ID:

| ID | Made by | Used for |
|---|---|---|
| **Chat ID** | The app, before the first message (`useChat` needs one). An ObjectId here, a UUID in `ai-service`. | The URL (`/agent/:chatId`), loading the thread, and which thread a new message belongs to |
| **Message ID** | The user's: `useChat`. The answer's: **the server**, with `generateMessageId: generateId`. | Finding one message again: matching an Approve or Deny to its answer, or replacing an answer in place |

The answer's ID must come from the server when you save on the server, so the browser and the database
know the answer by the same ID (resource 1, "Message IDs").

### One turn, step by step

What [conversation.service.ts](../src/services/conversation.service.ts) does:

```
browser sends only the new message
  → validate it (safeValidateUIMessages)
  → lock the conversation (or create it on its first message)
  → load the saved messages, add the new one
  → run the agent, streaming the answer (pipeAgentUIStreamToResponse)
  → when it ends (onEnd): save the whole conversation, answer included
  → unlock
```

Resuming is then just loading: `getConversation` returns the saved UI messages, the app passes them to
`useChat` as its starting `messages`, and the next question continues the thread. Nothing is kept in the
server's memory between turns, so a restart or a second server changes nothing.

### When to save

| Choice | This project | `ai-service` |
|---|---|---|
| The question | With the answer, at the end | **Before** the model runs, so it survives a model failure |
| A failed or stopped answer | Not saved: the thread continues from the last complete turn | Saved with what was written, marked `interrupted`, minus tool calls that never got a result |
| Storage | One document with a `messages` array | One document per message (`chatMessages`), so a long chat never nears MongoDB's 16 MB document limit |

Both are valid. The first is simpler; the second keeps more of what the user saw. Whatever you choose,
**never save a history the model will refuse**: a tool call without its result, or an answer cut off
halfway through a tool step.

### Things that break saved threads

You've already met these in this codebase:

- **Mongoose drops empty objects.** A tool call with no input (`input: {}`) is saved with no input at all,
  and the AI SDK rejects it next turn. Fix: `minimize: false` on the schema.
- **`undefined` saved as `null`.** The AI SDK rejects `providerOptions: null`. Fix: `ignoreUndefined: true`
  in [db.ts](../src/db.ts).
- **Two messages at once.** Two answers running on the same history would both save, and one would
  overwrite the other. Fix: a lock (`lockedUntil` here, `generatingUntil` in `ai-service`) that expires on
  its own, set a little longer than the gateway's 130-second limit.
- **Tools change, saved messages don't.** Validate saved messages with `safeValidateUIMessages({ messages,
  tools })` and leave out (and log) the ones that fail, rather than failing the whole chat.

## 6. Keeping threads per user

A thread belongs to one person in one workspace. Three rules keep it that way:

1. **The owner comes from the request, never from the body or the model.** The gateway sets `X-User-Id`
   and `X-Workspace-Id`; `requireIdentity` reads them. (This is lesson 9's main idea.)
2. **Every query includes the owner.** `ownedBy(identity)` adds `{ workspaceId, userId }` to each `find`
   and `update`, so loading by chat ID alone is impossible:

   ```ts
   ConversationModel.findOne({ _id: id, ...ownedBy(identity) });
   ```

   Someone else's chat answers **404**, exactly like a chat that doesn't exist, so nobody can learn which
   IDs are taken.
3. **The browser sends only its newest message.** The saved history is the real one. If the browser sent
   the whole thread, a user could edit an earlier answer, or invent a tool result saying a post was
   approved. `checkUserMessage` also refuses a user message with anything but text and attachments.

## 7. Why long threads get expensive

Every turn resends the whole thread, and every **agent step** within a turn resends it again (lesson 4).
So the cost of a turn grows with the length of the chat.

An illustration with made-up round numbers: instructions and tools are 4,000 tokens, and each turn adds
1,000 tokens of history. One step per turn:

| | Input tokens for that turn | Input tokens so far |
|---|---|---|
| Turn 1 | 5,000 | 5,000 |
| Turn 10 | 14,000 | 95,000 |
| Turn 20 | 24,000 | 290,000 |

Twenty questions asked as twenty separate chats would cost 100,000. The same twenty in one thread cost
almost three times as much, and a turn with three agent steps triples that turn again. A single big tool
result (a `listPosts` with a hundred posts) is paid for again on every later step of every later turn.

Long threads also get **worse**, not just pricier: models pay less attention to the middle of a long
context ("context rot", lesson 10).

What to do about it, in order of effort:

| Fix | How | Lesson |
|---|---|---|
| Send only recent messages | `ai-service` loads at most 40 messages, then keeps the newest that fit a 30,000-token budget (`HISTORY_TOKEN_BUDGET`), always starting at a question | here |
| Keep tool results small | `toModelOutput`, which you already use | 3 |
| Cache the unchanged start | Prompt caching makes resent tokens much cheaper | 18 |
| Summarize old turns | Replace early turns with a short summary | 10 |
| Start a new chat | Suggest it when the topic changes | 10, 30 |

This is why "Done when" says history must be supplied on each call, but **not every past turn**: the
model needs the turns that matter for this question, not all of them.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `generateText({ messages })` / `agent.generate({ messages })` | Send a conversation instead of a single `prompt` |
| `ModelMessage` | A message for the model: `system`, `user`, `assistant` or `tool`, with `content` |
| `result.responseMessages` | The messages this call produced (assistant text, tool calls, tool results). Push them onto the history. On a stream, `await` it. `result.response.messages` is the deprecated way. |
| `UIMessage` | A message for the app: `{ id, role, parts, metadata? }` |
| `InferAgentUIMessage<typeof agent>` | A `UIMessage` type whose tool parts are typed by your agent's tools |
| `convertToModelMessages(uiMessages, { tools })` | UI messages → model messages, applying each tool's `toModelOutput` |
| `validateUIMessages` / `safeValidateUIMessages({ messages, tools, dataSchemas })` | Check saved or received messages against today's tools and data parts. The `safe` one returns `{ success }` instead of throwing. |
| `pipeAgentUIStreamToResponse({ agent, uiMessages, originalMessages, generateMessageId, onEnd })` | Run the agent on UI messages and stream the answer. `onEnd` gets `messages` (the whole thread) and `responseMessage` (just the answer). `onFinish` is the deprecated name. |
| `generateId`, `createIdGenerator({ prefix, size })` | IDs for messages and chats |
| `useChat({ id, messages, transport })` (`@ai-sdk/react`) | The browser side: start from saved `messages`, and `prepareSendMessagesRequest` to send only the last one |

---

## Build: a terminal chat that survives a restart

The exercise in `LEARNING-PATH.md` uses the weather agent, which is gone from this project. Use your post
agent with **read-only** questions, so nothing is scheduled.

1. **Set up a test identity** if you didn't in lesson 7: `TEST_USER_ID` and `TEST_WORKSPACE_ID` in `.env`.
2. **A loop with memory:** `src/lessons/08-chat.ts` reads lines with `node:readline/promises`, calls
   `createPostAgent(identity).generate({ messages })`, prints `result.text`, and pushes the question and
   `result.responseMessages` onto a `ModelMessage[]` (section 2).
3. **Prove the follow-up works.** Ask "Which accounts are connected?", then "Which of them is on
   Instagram?". Then comment out the history (send only the new question) and ask the same two. Record
   what the second answer says each time.
4. **Save and resume.** After each turn, write the messages to `.chats/<id>.json`. On start, take an
   optional chat ID from the command line (`node --env-file=.env src/lessons/08-chat.ts <id>`), load that
   file if it exists, and continue. Restart and ask a follow-up about the earlier turn. Add `.chats/` to
   `.gitignore`.
5. **Save only complete turns.** Wrap the call in `try/catch`; if it fails, don't push or save anything,
   so the file always holds a history the model will accept.
6. **Watch the cost grow.** Print `result.totalUsage.inputTokens` after each turn. Ask about ten questions
   and note how input tokens change from turn 1 to turn 10.

This terminal version saves `ModelMessage`s, because there's no UI to show. The app saves `UIMessage`s
(section 3); being able to say why each is right in its place is the point.

Record what you found:

| Check | Result |
|---|---|
| Follow-up with history | |
| Follow-up without history | |
| Follow-up after a restart | |
| Input tokens: turn 1 / turn 10 | |

---

## Done when: self-check

- [ ] **Explain why relevant history must be supplied on each call, and why it need not include every
      past turn:** the model is stateless; but more history costs more on every step, gets less attention,
      and old turns may not matter to this question.
- [ ] **Save and resume a thread:** your terminal chat continues a conversation after a restart.

Extra checks:

- You save only `result.text` after each turn. What goes wrong on the next turn after a tool call?
- Why does the app store `UIMessage`s and not `ModelMessage`s? What would you lose the other way round?
- Why does the browser send only its newest message instead of the whole thread?
- A user stops an answer halfway through a tool step. What must you not save, and why?
- Someone guesses another user's chat ID and opens `/agent/<id>`. What stops them, and what status code do
  they get?
- Thread A has 3 turns, thread B has 30. Why does the same question cost more in B?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- AI SDK: [Chatbot message persistence](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence),
  [Prompts](https://ai-sdk.dev/docs/foundations/prompts),
  [Chatbot](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot)
- Claude: [Working with messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages),
  [Messages examples](https://platform.claude.com/docs/en/api/messages-examples)
- In this codebase: [conversation.service.ts](../src/services/conversation.service.ts),
  [conversation.schema.ts](../src/schemas/conversation.schema.ts),
  `ai-service`'s [chatHistory.ts](../../ai-service/src/services/chatHistory.ts) and
  [WORKING.md, "Saved chats"](../../ai-service/WORKING.md#saved-chats)
- Videos (third-party, not reviewed): [This is why LLMs have no memory](https://www.youtube.com/watch?v=_J7WXeRHE38),
  [AI Agents with History and Persistence Memory](https://www.youtube.com/watch?v=xkkgeLOA214),
  [AI on Rails: Persisting chat history](https://www.youtube.com/watch?v=ZbtjropEwPk)
