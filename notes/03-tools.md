# Lesson 3: Tools

Notes for lesson 3 of [LEARNING-PATH.md](../LEARNING-PATH.md). Tool guidance was checked against
Anthropic's docs and engineering posts, and the AI SDK details against the installed `ai@7`, on
2026-10-26. The walkthrough of your Creatosaurus tools was added on 2026-10-29.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (Anthropic Engineering) | Read | How to design tools an agent uses well: which tools to build, naming, short results, helpful errors, descriptions, evaluating tools. **Start here.** |
| 2 | [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (Anthropic docs) | Read | Tool definition fields, description best practices with good and bad examples, `tool_choice` |
| 3 | [AI SDK: Tools and tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) | Read | `tool()`, `toolChoice`, steps, tool errors, the SDK's error types |
| 4 | [Function Calling is All You Need](https://www.youtube.com/watch?v=KUEmEb71vzQ) (Ilan Bigio, AI Engineer) | Video | Long hands-on workshop: builds a tool-calling loop from scratch, then memory and delegation. It uses OpenAI's API, but the ideas carry over. Watch the first part for this lesson; the rest previews lessons 4 and 15. |
| 5 | [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic Engineering) | Read | Optional for now. Tasks, graders and pass rates. Read the first sections for the eval part of this lesson; lesson 17 covers the rest. |
| 6 | [Anthropic courses: tool use](https://github.com/anthropics/courses/tree/master/tool_use) (GitHub) | Hands-on | Optional. Notebooks that implement tool use against the raw API, without the SDK doing the loop. |

If you only have time for one: resource 1. It covers nearly every Learn item.

---

## The core idea

**The model never runs anything.** It can only produce text. A tool call is the model writing a
structured request, "please call `getWeather` with `{ city: 'Pune' }`". Your code decides whether to run
it, runs it, and sends the result back. Then the model continues with the new information.

That means:

- Tools are how a model reaches anything outside its training data: live data, your database, actions.
- **You** control what actually happens. The model only asks.
- The model picks a tool by reading its name, description and schema, so those are prompt text, not
  documentation.

## 1. What a tool is

A tool has three parts. The weather tool this lesson started from had all three (your Creatosaurus
tools, explained in "Your build" below, have the same parts):

| Part | Who reads it | Purpose |
|---|---|---|
| `description` | The model | **When** to use the tool and what it returns |
| `inputSchema` | The model, and the SDK | **What** to send. The model sees it as JSON Schema; the SDK validates the model's input with Zod before your code runs. |
| `execute` | Only your runtime | **What happens.** Its return value goes back to the model. |

```ts
export const getWeather = tool({
  description: 'Get the current weather for a city.',
  inputSchema: z.object({
    city: z.string().describe('The city name, for example "Pune"'),
  }),
  execute: async ({ city }) => { /* fetch and return a small object */ },
});
```

`.describe()` on a Zod field becomes that parameter's description in the JSON Schema the model sees.
Treat it as prompt text too.

## 2. The model asks, your code runs it

The journey of one tool call, for "What's the weather in Pune?":

```
 1. Your code  → API     instructions + tool definitions (name, description, schema) + user message
 2. Model      → you     "call getWeather({ city: 'Pune' })"        finishReason: 'tool-calls'
 3. SDK                  validates the input against the Zod schema
 4. SDK        → execute your function runs: geocoding fetch, then weather fetch
 5. SDK        → API     everything from step 1 + the tool call + the tool result
 6. Model      → you     "It's clear in Pune, 26.3°C..."            finishReason: 'stop'
```

Points worth noticing:

- Steps 2 and 6 are **two separate model calls**. That's why lesson 1's log showed two steps, with more
  input tokens in the second.
- Tool definitions are sent on **every** call, so they cost input tokens every time. Large or numerous
  tool definitions are a real cost.
- The model can ask for **several tools at once** (for example, weather for Pune and Mumbai in one step).
  The SDK runs them and returns all the results together.
- `ToolLoopAgent` runs steps 2–6 in a loop until the model stops asking for tools or `stopWhen` is
  reached. Lesson 4 covers the loop itself.

**Choosing whether a tool is called** (`toolChoice` in the AI SDK):

| Option | Meaning |
|---|---|
| `'auto'` (default) | The model decides |
| `'none'` | No tools this call |
| `'required'` | Must call some tool |
| `{ type: 'tool', toolName }` | Must call that tool |

On **Opus 5.5 and Sonnet 5.5, forcing a tool (`'required'` or a named tool) returns a 400 error.** Use
`'auto'` and steer with the description and instructions instead. Haiku 5.5 still accepts forced tool
use. Lesson 5 covers structured output, the right tool when you just need JSON back.

## 3. The description decides when it's used

The model chooses tools mainly from their descriptions. Anthropic calls detailed descriptions "by far the
most important factor in tool performance".

A good description answers:

1. **What** does it do, and what does it return?
2. **When** should it be used, and when should it **not** be?
3. **What** does each parameter mean, with examples of valid values?
4. **What are the limits?** What does it not cover?

Aim for **3–4 sentences or more** per tool. Write it like an onboarding note for a new teammate.

```ts
// Before: one line, leaves the model guessing
description: 'Get the current weather for a city.',

// After: what, when, when not, what it returns
description:
  'Get the current weather conditions for a city right now: conditions, temperature in °C, ' +
  'humidity and wind speed. Use this when the user asks about weather now or today. ' +
  'Do not use it for future days; use getForecast for that. ' +
  'Returns an error if the city cannot be found.',
```

Parameter names matter too. Use names that can't be misread (`city`, `days`, `userId` rather than `q`,
`n`, `user`). Use Zod constraints (`.min()`, `.max()`, `.enum()`) to express limits instead of only
describing them.

**Instructions and descriptions work together.** The description says what a tool does. The agent's
`instructions` say how to use the tools together ("for anything about future days, use getForecast").

## 4. Short tool results

Whatever `execute` returns goes into the context as input tokens, and stays there for every later step.
Return what the model needs for its next decision, nothing more.

- **Pick the fields.** The weather tool turns Open-Meteo's large response into five fields. That's the
  right pattern.
- **Use readable values over codes.** `'clear sky'` instead of `weather_code: 0`; a name instead of a
  bare ID. Anthropic found that resolving IDs to names reduced hallucination.
- **Limit lists.** Paginate, filter or cap them, with sensible defaults. If you truncate, say so: "showing
  10 of 240; narrow the search to see more".
- **Keep IDs only if a later call needs them.**

The forecast tool you'll build is a good test: 16 days × 10 fields is a lot of tokens. Return only the
days asked for, with the fields that matter.

## 5. Returning errors the model can recover from

Tools fail: the city doesn't exist, the API is down, the input is out of range. The model can often
recover, by retrying with a corrected input or telling the user clearly, **if the error tells it what
went wrong and what to do**.

Two ways an error reaches the model in the AI SDK:

| Way | What happens | Use for |
|---|---|---|
| **Return an error object** from `execute` | It's a normal tool result; the model reads it | Expected problems: city not found, no results, invalid date range |
| **Throw** from `execute` | The SDK records a `tool-error` and sends the error message back to the model in the next step | Unexpected failures: network down, bad API response |

Write errors as instructions, not codes:

```ts
// Weak: the model can't do anything with this
return { error: 'NOT_FOUND' };

// Strong: what happened and what to try
return {
  error: `No city found called "${city}". Ask the user to check the spelling, or try the ` +
    'English name of the city.',
};
```

Watch for:

- **Silent failures.** The current weather tool doesn't check `response.ok`. If Open-Meteo returns a 500,
  `.json()` fails with a confusing error. Check the HTTP status and return or throw a clear message.
- **Leaking internals.** Error text goes to the model and may be shown to the user. Never include stack
  traces, API keys, internal URLs or raw upstream responses.
- **Errors the model can't fix.** If retrying won't help, say so ("The weather service is unavailable;
  tell the user to try later"), or the model may retry repeatedly. Lesson 6 covers loops.

## 6. Designing a few task-shaped tools

Don't wrap every API endpoint as a tool. Design tools around the **tasks** a user wants done.

- **Fewer, more capable tools.** Every extra tool is another option the model has to choose between, and
  more input tokens on every call. Overlapping tools cause the wrong one to be picked.
- **Match how a person would do the task.** Instead of `listUsers` + `listEvents` + `createEvent`, a
  single `scheduleMeeting` tool that finds a free slot and books it.
- **Clear boundaries.** If two tools could both answer a question, sharpen their descriptions or merge
  them. `getWeather` (now) vs `getForecast` (future days) is a deliberate, clear split.
- **Namespace when tools span services**: `instagram_schedulePost`, `slack_sendMessage`.
- **Hide plumbing.** The weather tool hides geocoding inside `execute`. The model asks for a city and
  never has to call a separate "find coordinates" tool. That's good task shaping.

## 7. Eval cases, code assertions and pass rate

Changing a description is a prompt change. You need a way to know whether it helped or broke something.
An **eval** is a small test suite for model behavior.

| Term | Meaning | In the starter eval |
|---|---|---|
| **Case** | One input plus the expected behavior | `{ prompt: "What's the weather in Pune?", expectedTools: ['getWeather'] }` |
| **Code assertion** | A check written in code, true or false | `assert.deepEqual(calledTools, expectedTools)` |
| **Pass rate** | Passing cases ÷ total cases | `4/5 passed` = 80% |
| **Baseline** | A recorded result to compare changes against | Model ID + prompt version + pass count |

How it differs from normal tests:

- **Results vary between runs.** The same case can pass once and fail the next time. Run important
  checks more than once.
- **It costs money** and calls real APIs, so failures can be network problems, not your agent.
- **A passing case isn't a correct answer.** The starter only checks which tools were called and that
  some text came back. It doesn't check that the temperature in the answer matches the tool result.

Rule: when a case fails, **investigate it before changing the assertion.** Weakening a check to make it
pass hides the problem.

## 8. Checking tool selection separately from answer quality

An agent can fail in two different places, and they need different fixes:

| Failure | Example | Usual fix |
|---|---|---|
| **Wrong tool behavior** | Called `getWeather` for "weather next Tuesday"; called no tool; wrong `days` argument; called the same tool 4 times | Tool descriptions, parameter design, instructions |
| **Wrong answer** | Right tool and right result, but the answer says 30°C when the tool said 26°C, or ignores the error | Instructions, result format, model choice |

So check them separately:

1. **Tool selection:** which tools were called, with which arguments, and how many times. Read these from
   `result.steps`. Code assertions handle this well.
2. **Answer quality:** does the final text match the tool results? For now, review it by hand. Lesson 17
   adds automated graders, including a model as judge.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `tool({ description, inputSchema, execute })` | Defines a tool |
| `z.string().describe('...')` | Parameter description the model reads |
| `tool({ ..., strict: true })` | Asks the provider to guarantee inputs match the schema exactly |
| `tool({ ..., inputExamples: [{ input: {...} }] })` | Example inputs for complex parameters (Anthropic supports this natively) |
| `toolChoice` | `'auto'`, `'none'`, `'required'` or `{ type: 'tool', toolName }`. Forcing isn't allowed on Opus/Sonnet 5.5. |
| `result.steps[i].toolCalls` | Tool calls in one step: `toolName`, `input` |
| `result.steps[i].toolResults` | Results in one step: `toolName`, `output` |
| `result.toolCalls` / `result.toolResults` | All steps combined |
| `NoSuchToolError`, `InvalidToolInputError` | Errors when the model calls a tool that doesn't exist or sends input that fails the schema |

---

## Your build: the Creatosaurus tools, explained

You did this lesson against the real Creatosaurus services instead of the weather agent. This section
walks through that code using the ideas above, so you can explain every decision in it. The code is in
[src/tools/](../src/tools/) (what the model sees), [src/clients/](../src/clients/) (the HTTP calls to
other services) and [src/agents/postScheduler.agent.ts](../src/agents/postScheduler.agent.ts).

### The four tools

| Tool (name the model sees) | The model sends | Your code calls | Returns to the model |
|---|---|---|---|
| `currentTimeTool` | `timeZone?` | Nothing; reads the clock | UTC time, plus local time if a zone was given |
| `accountListTool` | Nothing | connection-service `GET /v1/accounts/:workspaceId` | `id`, `name`, `platform`, `profileURL`, `needsReconnect` per account |
| `postSchedularTool` | `accountId`, `caption`, `scheduledTime`, `timeZone`, `mediaIds?` | connection-service, then post-scheduler `POST /v1/posts` | The new post's ID, account, platform, time and whether it's scheduled |
| `listPostsTool` | `from`, `to` | post-scheduler `GET /v1/workspaces/:workspaceId/posts` | Up to 100 posts with each account's status, plus `hasMore` |

The name the model sees is the **key** in the agent's `tools` object, not the variable name. That's
why `getAccountListTool` in the code appears to the model as `accountListTool`.

### The journey of one request

"Schedule *Hello World* on Instagram tomorrow at 10am" makes the model use three tools in order:

```
Step 1  model → currentTimeTool({ timeZone: 'Asia/Kolkata' })     It doesn't know today's date
        code  → { utc, local: 'Thursday 29 October 2026 ...' }
Step 2  model → accountListTool({})                               It needs an account ID
        code  → { accounts: [{ id: '6ae3…', name: 'Content-AMG', platform: 'instagram', ... }] }
Step 3  model → postSchedularTool({ accountId: '6ae3…', caption: 'Hello World',
                                    scheduledTime: '2026-10-30T10:00:00+05:30', timeZone: 'Asia/Kolkata' })
        code  → { success: true, postId, scheduledTime, scheduled: true }
Step 4  model → "Done! Hello World is scheduled on Content-AMG for tomorrow at 10am."
```

That's **four model calls** for one question. Every call sends the instructions, all four tool
definitions and everything above it again. This is section 2 in practice: tools cost input tokens on
every step, including the ones that don't use them.

The order comes from the tool descriptions and the agent's instructions working together (section 3):

- **Descriptions** say what each tool does ("Get the current date and time. Call this before working
  out any date or time for a post.").
- **Instructions** say how to combine them ("Use the account list tool to find account IDs. Never guess
  an ID.").

### Anatomy of `postSchedularTool`

[posts.tools.ts:30](../src/tools/posts.tools.ts#L30) has every part from section 1, plus
`contextSchema`:

| Part | In this tool |
|---|---|
| `description` | "Schedule a post on one of the connected accounts..., with optional images or videos the user attached in this chat." |
| `inputSchema` | What the model fills in. Each field has a `.describe()` and constraints. It lives in [schemas/posts.schema.ts](../src/schemas/posts.schema.ts). |
| `contextSchema` | Who is asking (`userId`, `workspaceId`, `roles`). Your server passes it in from the gateway's headers, so the model can't set it. Lesson 9 covers this. |
| `execute` | Looks up the account, calls post-scheduler, and turns its reply into a short result |

The schema uses Zod constraints instead of only describing limits in words:

```ts
scheduledTime: z.iso
    .datetime({ offset: true })                           // must include a time zone offset
    .refine((time) => new Date(time).getTime() >= Date.now() + FIVE_MINUTES_MS,
        { message: 'Scheduled time must be at least 5 minutes in the future.' }),
mediaIds: z.array(z.string().regex(/^[a-f\d]{24}$/i, 'A media ID is 24 hexadecimal characters.'))
    .max(MAX_MEDIA_PER_POST)
    .optional(),
```

When the model's input breaks a rule, the SDK **doesn't call `execute`**. It sends the validation
message back to the model as a `tool-error`, and the model usually fixes the input and tries again. So
write Zod messages for the model to read, like the error messages in section 5.

### Three layers of checks

Each layer catches something the others can't:

| Layer | Where | Catches |
|---|---|---|
| **Input schema** | `inputSchema` (Zod, checked by the SDK) | Badly shaped input from the model: a date without an offset, a time in the past, a malformed media ID |
| **Your `execute`** | The account lookup at [line 40](../src/tools/posts.tools.ts#L40) | Input that's well shaped but wrong: an account ID that isn't connected to this workspace, an account that needs reconnecting |
| **The service** | post-scheduler's own validation | Business rules only it knows: media that isn't in this workspace or hasn't finished uploading, platform limits like four images on X |

There's a fourth check going the other way. The responses from connection-service and post-scheduler
are also parsed with Zod (`accountListResponseSchema`, `calendarPageResponseSchema`). Those schemas
list only the fields the tools use. If another service changes its response, the tool fails with a
clear error instead of passing `undefined` to the model.

### Hiding plumbing (section 6)

The model only ever handles the account's `id`. To create a post, post-scheduler also needs the
account's `socialId` (the platform's own page ID) and `accountType`. `execute` looks those up itself:

```ts
const accounts = await fetchConnectedAccounts(context, abortSignal)
const account = accounts.find((candidate) => candidate._id === accountId)
```

This does two jobs:

1. **Fewer things for the model to get wrong.** It passes one ID instead of three fields that must match.
2. **Safety.** The model can't make up a page ID or name an account from another workspace, because
   only accounts returned for *this* workspace can match.

`fetchConnectedAccounts` and `fetchScheduledPosts` are plain helper functions, not tools. Several tools
share them, and the model never sees them.

### Short results (section 4)

| Tool | What it leaves out or shortens | Why |
|---|---|---|
| `accountListTool` | `socialId` and the rest of the account record | The model only needs the `id` for the next call |
| `listPostsTool` | Media, socialIds; captions cut to 280 characters | 100 posts with full captions would be a lot of tokens |
| `listPostsTool` | Turns `queue`/`history` into `scheduled`/`finished`, and account statuses into `published`/`failed`/`pending` | Readable values instead of internal codes, so the model can repeat them to people |
| `listPostsTool` | Fetches one page of up to 100 posts, and returns `hasMore` | A capped list that says when it was cut short |

One trade-off you measured: `profileURL` is in both list results so the app can show account
pictures, but a Facebook image link is about 600 characters. The model never needs it, so for every
account in every result it's tokens spent for the UI, not for the model. If that becomes expensive,
the fix is to send the links to the app separately and leave them out of the tool result.

### Return or throw (section 5)

The tools use both ways deliberately:

| Situation | What the tool does | What the model sees |
|---|---|---|
| Account not connected to this workspace | **Returns** `{ success: false, error }` | "That account is not connected to this workspace. Use the account list tool to pick one." |
| Account needs reconnecting | **Returns** an error | "Content-AMG needs to be reconnected in Creatosaurus before posts can be scheduled on it." |
| No accounts connected | **Returns** an error | Where in Creatosaurus to connect one |
| post-scheduler answers 4xx | **Returns** post-scheduler's own message ([line 15](../src/tools/posts.tools.ts#L15)) | For example "Media … not found in this workspace" |
| post-scheduler answers 5xx | **Throws** ([line 20](../src/tools/posts.tools.ts#L20)) | "The post may have been saved without a schedule, so ask the user to check their calendar before trying again." |
| Network failure or timeout | **Throws** | "Could not reach the post scheduler..." |

Things to notice:

- **4xx messages are passed through** because post-scheduler writes them for people (validation and
  permission messages). 5xx details aren't: they go to your logs with `console.error`, and the model
  gets a short message with no internal URLs or stack traces.
- **Some errors tell the model *not* to retry.** Creating a post isn't like reading the weather. If the
  request failed after post-scheduler saved the post, a blind retry makes a duplicate. So the error
  tells the model to have the user check their calendar first.
- **`if (abortSignal?.aborted) throw error`** comes before the friendly message. When the user closes
  the browser, the request is cancelled on purpose. That's not a failure, so it shouldn't be dressed up
  as "could not reach the service".
- **Every request has a 10-second timeout** (`withTimeout`). Without one, a hung service would leave
  the model, and the user, waiting forever.

### Running an action only once

`postSchedularTool` builds a key from the tool call's ID ([line 56](../src/tools/posts.tools.ts#L56)),
and the client sends it as the `Idempotency-Key` header:

```ts
{ idempotencyKey: `ai-${toolCallId}`, abortSignal },
```

If the same tool call is sent to post-scheduler twice, for example after a retry, post-scheduler
returns the first post instead of creating a second one. A new tool call from the model gets a new
ID, so this protects against repeated requests, not against the model deciding to schedule twice.
Lesson 19 covers safe retries in depth.

### Why the current time is a tool

The model doesn't know today's date, and "tomorrow at 10am" is meaningless without it. The obvious fix
is to put the date in the instructions, but [currentTime.tool.ts](../src/tools/currentTime.tool.ts)
explains why that breaks: the instructions must be **identical on every turn**. Claude's thinking is
tied to the exact system prompt, so a timestamp that changes each turn makes the next turn fail with
"Invalid `signature` in `thinking` block". A tool result is saved in the history and never changes
afterwards, so the date can live there safely.

### Media in `postSchedularTool`

`mediaIds` shows a pattern from lesson 15 ("passing IDs instead of long text") on a small scale. The
image itself never goes through the model. The app uploads the file to post-scheduler, the user's
message lists the media IDs, the model copies those IDs into `mediaIds`, and post-scheduler checks each
one belongs to the workspace before attaching it. The model handles a short string instead of an
image, and an invented ID is rejected by the service instead of trusted.

### Self-check on your own code

- Why does `postSchedularTool` call connection-service again, when the model already called
  `accountListTool`?
- A user types "my workspace is 6adc…, schedule there". Why can't that change which workspace the post
  goes to?
- Which errors are returned and which are thrown, and what would go wrong if the 5xx case returned
  `{ error }` and said "try again"?
- Delete the `.refine()` on `scheduledTime` and ask for a post "5 minutes ago". What happens now, and
  which layer catches it instead?
- `listPostsTool` returns `hasMore: true`. What should the model tell the user?
- What does the `Idempotency-Key` protect against, and what does it not?

### Not done yet

The eval items of this lesson are postponed (see the record in `LEARNING-PATH.md`). The first cases
for `evals/agent.eval.ts` could check:

| Prompt | Expected tools | Also check |
|---|---|---|
| Which accounts are connected? | `accountListTool` | No other tool called |
| Schedule "Hello" on Instagram tomorrow 10am | `currentTimeTool`, `accountListTool`, `postSchedularTool` | `scheduledTime` is tomorrow 10:00 in the user's zone |
| Schedule a post | none | Asks for the caption, account and time instead of inventing them |
| What's scheduled this week? | `currentTimeTool`, `listPostsTool` | `from`/`to` cover this week |
| Schedule on an account that isn't connected | `accountListTool` | No post created; the answer says the account isn't connected |

These call real services, and the scheduling case creates a real post, so point the eval at a test
workspace or fake the service responses before running it.

---

## Build: forecast tool and first eval

1. **Set up the eval.** Copy the starter from lesson 3 of `LEARNING-PATH.md` into `evals/agent.eval.ts`.
   From `ai-service`, run:

   ```bash
   node --env-file=.env evals/agent.eval.ts
   ```

   Record the result as your **baseline**: model ID, date, pass count.

2. **Add `getForecast(city, days)`** in `src/tools/`, next to `getWeather`.
   - Reuse the geocoding step. Moving it into a shared helper function avoids duplicating it.
   - Open-Meteo daily forecast: add `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
     `forecast_days=N` and `timezone=auto` to the forecast URL. `forecast_days` allows 1–16, so use
     `z.number().int().min(1).max(16)`.
   - Return a short array: one entry per day with date, conditions, min/max °C and rain chance.
   - Check `response.ok` and return clear errors.
3. **Register it on the agent and update the instructions** so the model can tell current weather from
   forecasts. Improve both tool descriptions using section 3.
4. **Grow the eval to at least 5 cases.** For example:

   | Prompt | Expected tools | Also check |
   |---|---|---|
   | What's the weather in Pune? | `getWeather` | |
   | Will it rain in Mumbai over the next 3 days? | `getForecast` | `days` is 3 |
   | What's the weather in Xyzabc123? | `getWeather` | Answer says the city wasn't found; no invented numbers |
   | Is it hot today? | none | Asks which city |
   | Compare weather in Pune and Delhi right now | `getWeather` | Called for both cities |

5. **Check arguments, not just tool names**, for at least one case. Read
   `step.toolCalls[i].input` and assert on `days` or `city`.
6. **Prove the eval works:** change one expected tool name and confirm that case fails. Change it back
   and confirm it passes.
7. **Read the answers by hand** and note any mismatch with the tool results.

Record what you found:

| Run | Model | Prompt version | Passed | Failures and why |
|---|---|---|---|---|
| Baseline | | v1 | /2 | |
| After forecast | | v2 | /5 | |

---

## Done when: self-check

- [ ] **Explain the full journey of a tool call:** from the definitions sent to the model, through the
      tool call, validation, `execute`, the result going back, to the final answer.
- [ ] **Write a description that makes the model use the tool at the right time:** shown by
      `getWeather` vs `getForecast` being picked correctly in your eval.
- [ ] **Your eval reports a pass count for at least 5 cases** and exits with a non-zero code on failure.
- [ ] **Changing an expected tool name makes a case fail,** and restoring it makes it pass.
- [ ] **You recorded a baseline** and can explain what each assertion does and does not measure.

Extra checks:

- Why does adding a tenth tool cost money even on questions that don't use it?
- When should `execute` return an error object, and when should it throw?
- Your eval passes 5/5, but the answer says 31°C when the tool returned 26°C. Which check is missing?

---

## Extra practice: post scheduler agent

A second exercise with new problems the weather agent didn't have: tools that change data, IDs that
carry from one call to the next, rules that produce errors, long lists, and dates. The posts live in
an in-memory array, so the eval doesn't depend on the network and you can check what the agent changed.

**Files:**

- `src/tools/posts-store.ts`: an array of posts. Fill it with about 25 posts across Instagram, X and
  LinkedIn, including a few with `status: 'published'`.
- `src/tools/posts.ts`: the three tools.
- `src/agents/scheduler-agent.ts`: set up like [postScheduler.agent.ts](../src/agents/postScheduler.agent.ts).
- `evals/scheduler.eval.ts`

**Tools:**

| Tool | Input | Returns |
|---|---|---|
| `schedulePost` | `platform`, `text`, `scheduledAt` | The new post's ID and a confirmation |
| `listScheduledPosts` | `platform?`, `from?`, `to?`, `limit?` | A short list |
| `cancelPost` | `postId` | A confirmation |

**Rules to enforce in code.** Each one returns an error object written as an instruction (section 5):

1. **Text length per platform:** X 280 characters, Instagram 2,200, LinkedIn 3,000. Give the length
   and the limit: "Text is 312 characters; X allows 280. Shorten it by at least 32 characters."
2. **`scheduledAt` can't be in the past.**
3. **An unknown `postId`** returns an error that tells the model to look up the ID with
   `listScheduledPosts`.
4. **A published post can't be cancelled.** Say so plainly, and that retrying won't help.

Also add one case that **throws**: give the store an environment variable `STORE_DOWN=1` that makes
writes throw. Then compare how the model handles a thrown error with a returned one.

**Design problems to solve:**

- **The model doesn't know today's date.** "Tomorrow at 9am" can't work unless you give it the date.
  Decide whether it goes in the agent's instructions or the tool. Also decide what timezone
  `scheduledAt` uses, and make the schema and the description say so.
- **IDs move from one call to the next.** For "Cancel my LinkedIn post about the product launch", the
  model has to call `listScheduledPosts` first, find the ID, then call `cancelPost`. The descriptions
  have to make that order clear (section 4: keep IDs only if a later call needs them).
- **Short list results.** Cap the list at 10 by default and show only the first ~60 characters of each
  post's text. When you cut the list short, say so: "showing 10 of 23; filter by platform or date to
  see more".
- **Constraints in the schema:** `z.enum` for `platform`, `.min()`/`.max()` for `limit`. Don't rely
  only on the description to state limits.
- **Cancelling can't be undone.** Decide whether the agent should confirm before it cancels, write the
  rule into the instructions, and test it.

**Eval: at least 6 cases.** The new part is checking **what's in the store after the run**, as well as
which tools were called. Reset the store before each case, or one case's changes will affect the next.

| Prompt | Expected tools | Also check |
|---|---|---|
| Schedule "New feature live!" on X for tomorrow 9am | `schedulePost` | The store has a new X post dated tomorrow |
| Post this to X: *(a 400-character text)* | `schedulePost` | Nothing was added to the store; the answer mentions the limit |
| What's scheduled on Instagram this week? | `listScheduledPosts` | `platform` is `'instagram'`; the `from`/`to` dates match this week |
| Cancel my LinkedIn post about the product launch | `listScheduledPosts`, then `cancelPost` | The right ID was cancelled; the order was list, then cancel |
| Cancel post `p_999` | `cancelPost` | No made-up success message |
| Cancel *(the ID of a published post)* | `cancelPost` | The store didn't change |

**Self-check:**

- Why does this agent need today's date when the weather agent didn't?
- The "cancel the launch post" case passes, but the model guessed an ID without calling
  `listScheduledPosts`. Which assertion catches that?
- Would one `managePosts(action, ...)` tool be better than three tools? Use section 6 to argue for one
  answer.
- A case passed on tool calls, but the store is wrong. Is that a tool-selection failure or an
  answer-quality failure (section 8), or something else?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- Anthropic: [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
  [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
- Anthropic docs: [Tool use overview](https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview),
  [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
  [Implement tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use)
- AI SDK: [Tools and tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling),
  [Foundations: tools](https://ai-sdk.dev/docs/foundations/tools)
- [Open-Meteo forecast API](https://open-meteo.com/en/docs)
