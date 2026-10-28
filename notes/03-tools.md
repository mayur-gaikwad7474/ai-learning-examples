# Lesson 3: Tools

Notes for lesson 3 of [LEARNING-PATH.md](../LEARNING-PATH.md). Tool guidance was checked against
Anthropic's docs and engineering posts, and the AI SDK details against the installed `ai@7`, on
2026-10-26.

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

A tool has three parts. The weather tool in [src/tools/weather.ts](../src/tools/weather.ts) has all
three:

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
- `src/agents/scheduler-agent.ts`: set up like [weather-agent.ts](../src/agents/weather-agent.ts).
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
