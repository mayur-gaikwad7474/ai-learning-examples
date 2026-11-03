# Lesson 6: Preventing infinite loops

Notes for lesson 6 of [LEARNING-PATH.md](../LEARNING-PATH.md). The AI SDK details were checked against the
installed `ai@7` (7.0.153) source, and the agent guidance against Anthropic's engineering posts, on
2026-11-02.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [AI SDK: Loop control](https://ai-sdk.dev/docs/agents/loop-control) | Read | `stopWhen`, the built-in stop conditions, custom conditions, and `prepareStep`. **Start here.** |
| 2 | [How Claude Code's Agent Loop (--max turns) Actually Works](https://www.youtube.com/watch?v=yEOacsVK0N8) | Video | The think → act → read-result cycle in a real coding agent, and why it has a turn limit |
| 3 | [AI Agent Mastery: Is Your Agent Stuck in a Loop?](https://www.youtube.com/watch?v=M5it7vaEAP8) | Video | Spotting an agent that's looping, and getting it out |
| 4 | [Fix CrewAI Agents Retrying Forever (max_iter Trap)](https://www.youtube.com/watch?v=7_3ahdTqFAo) | Video | Optional. Another framework, same problem: a default iteration limit that's higher than people expect |
| 5 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic Engineering) | Read | Re-read the "Agents" section: tasks usually end on their own, but you add stopping conditions like a maximum number of iterations to stay in control |
| 6 | [Agent guardrails: loop limits, cost caps and human approval gates](https://dev.to/gabrielanhaia/agent-guardrails-loop-limits-cost-caps-and-human-approval-gates-56fn) (DEV Community) | Read | A practical tour of step limits, cost caps and approvals across frameworks |
| 7 | [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic Engineering) | Read | Optional. How Anthropic kept many agents from "spiraling out of control" in production |
| 8 | [When Agents Do Not Stop: Uncovering Infinite Agentic Loops in LLM Agents](https://arxiv.org/pdf/2607.01641) (arXiv) | Paper | Optional, deep. Why you can't rely on the model to stop on its own |

The videos (2 to 4) are third-party and were chosen by title and description; I couldn't watch them.
There's no official video on this topic. If you only have time for one thing: resource 1, then video 2.

---

## The core idea

**The model decides when the loop ends.** In lesson 4 you saw the loop: call the model, run the tools it
asks for, repeat until it answers. Nothing in that loop guarantees it finishes. If the model keeps asking
for tools, it keeps going, and every step costs time and money, because every step resends the whole
history (lesson 1).

So you add limits in **code**, where the model can't talk its way past them:

| Limit | Stops… | AI SDK |
|---|---|---|
| Steps | Too many model calls | `stopWhen: isStepCount(n)` |
| A rule | A pattern you can detect, like the same call twice | A custom `stopWhen`, or `prepareStep` |
| A budget | Too many tokens, or too much money | A custom `stopWhen` that adds up `usage` |
| Time | Too long a wait | `timeout`, `abortSignal` |
| Tool access | The model calling what it shouldn't, at this point | `prepareStep` → `activeTools`, `toolChoice` |

And one rule that matters as much as the limits: **when a limit stops the run, the user still gets a
friendly answer**, never an empty message or a 500.

---

## 1. Why agents loop

Your post scheduler agent has no `stopWhen`, so it relies on the `ToolLoopAgent` default of 20 steps. The
usual causes of runaway loops, with the versions you've met in this project:

| Cause | What it looks like | In Creatosaurus |
|---|---|---|
| **A tool keeps failing** | The model retries the same call, hoping for a different result | Post-scheduler down: the model calls `postSchedular` again and again |
| **A result that looks like failure** | An empty list makes the model try other inputs | No posts this week → it tries last week, next week, this month… |
| **Splitting work it shouldn't** | One question becomes many calls | Your Day 6 finding: "show 2025" became 4 parallel `listPosts` calls, one per quarter |
| **Ping-pong between tools** | A → B → A → B, never converging | List accounts → schedule fails → list accounts again → schedule again |
| **A goal it can't meet** | It keeps searching for something that isn't there | "Schedule it on TikTok" when no TikTok account is connected |

You've already fixed two of these the right way, **in the tools**, before any limit was needed:

- `listPosts`'s description says "Call it once per question and never split a longer period into several
  calls", and tells the model what to offer when the range is too long.
- `explainScheduleFailure` in [posts.tools.ts](../src/tools/posts.tools.ts) doesn't just say "error". For
  a network failure, it tells the model the post **may already exist** and to ask the user to check the
  calendar before trying again. A tool result that says what to do next is the best loop prevention
  there is.

**Fix the cause first; limits are the safety net.** A limit stops the damage, but the user still doesn't
get what they asked for.

## 2. Step limits

```ts
import { isStepCount, ToolLoopAgent } from 'ai';

const MAX_STEPS = 8;

const agent = new ToolLoopAgent({
  model,
  instructions: INSTRUCTIONS,
  tools,
  stopWhen: isStepCount(MAX_STEPS),
});
```

**Choosing the number.** Look at your real runs (your `onStepEnd` logs): "schedule a post with media" is
about 4 steps (time, accounts, schedule, answer). Pick a limit with room above your longest normal task,
about double, so normal work never hits it. 20 is generous for an agent with 5 tools; 8 to 10 would do.

| | Default | Notes |
|---|---|---|
| `ToolLoopAgent` | `isStepCount(20)` | A safety net, not a design choice. Set your own. |
| `generateText` / `streamText` | `isStepCount(1)` | One step. With tools, set `stopWhen` or you get an empty answer (lesson 4). |

### The trap: a limit leaves the user with nothing

From the installed source, `stopWhen` is only checked **after a step that called tools**. So when a limit
stops the run, the last step is a tool call, and the model never got to write an answer:
`result.text` is `''`, and your chat shows an empty message.

Fix it by **taking the tools away on the last allowed step**, so the model has to answer in words:

```ts
const agent = new ToolLoopAgent({
  model,
  instructions: INSTRUCTIONS,
  tools,
  stopWhen: isStepCount(MAX_STEPS),
  // stepNumber starts at 0, so MAX_STEPS - 1 is the last step the limit allows.
  prepareStep: ({ stepNumber }) =>
    stepNumber === MAX_STEPS - 1 ? { toolChoice: 'none' } : undefined,
});
```

On that step the model can't call a tool, so it writes an answer from what it has, often "I couldn't
finish this, here's what I found", and the loop ends normally.

Why `toolChoice: 'none'` and not `activeTools: []`? Claude's API rejects a request whose history contains
tool calls but that defines no tools. `toolChoice: 'none'` keeps the tools defined and only stops the
model from calling them.

**Keep a code fallback too**, for anything that still ends without text (a timeout, a provider error):

```ts
const result = await agent.generate({ messages, abortSignal });
const text = result.text.trim() || "Sorry, I couldn't finish that. Please try again with a simpler request.";
```

## 3. Stop conditions

`stopWhen` takes one condition or an array; **any** condition returning `true` stops the loop. A condition
is just a function of the steps so far.

| Condition | Stops when |
|---|---|
| `isStepCount(n)` | `n` steps have run |
| `hasToolCall('name', ...)` | The latest step called one of these tools |
| `isLoopFinished()` | Never: it runs until the model answers. Removes the safety net; avoid it. |
| `({ steps }) => boolean` | Your own rule (sections 4 and 7) |

```ts
stopWhen: [isStepCount(MAX_STEPS), sameCallTwice, overTokenBudget(50_000)],
```

**`hasToolCall` stops right after that tool runs**, before the model can say anything about it. That's
right for a "final answer" tool whose input *is* the answer. It's wrong for `postSchedular`: you'd
schedule the post and then show the user an empty message.

## 4. Token, cost and time budgets

A step limit counts calls, not cost. Eight steps with a huge history cost far more than eight short ones,
because each step resends everything before it. A budget measures what you actually care about.

**Token budget** as a stop condition, using each step's `usage`:

```ts
import type { StopCondition, ToolSet } from 'ai';

const overTokenBudget =
  (maxTokens: number): StopCondition<ToolSet> =>
  ({ steps }) =>
    steps.reduce(
      (total, step) => total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
      0,
    ) > maxTokens;
```

**Cost budget:** the same idea, with tokens times price. Input and output tokens have different prices,
and cached input is cheaper again (lesson 18). Take the prices from the provider's pricing page for your
`AI_MODEL`, and keep them in config, not scattered in code.

Two things to know about budgets:

- **They're checked after a step, not before.** A budget of 50,000 tokens can end at 58,000 if the last
  step was big. Set the limit with that margin in mind.
- **Per run isn't per user.** A budget per `generate` call stops one runaway answer. Someone sending 100
  messages is a different problem: rate limits and quotas (lesson 20). Your `ai-service` already limits
  each user to 30 requests a minute.

**Time** is section 5.

## 5. Timeouts

`timeout` caps how long a run can take. It accepts a number of milliseconds (the whole run), or an object
with separate limits, from the installed types:

```ts
const result = await agent.generate({
  messages,
  abortSignal,
  timeout: {
    totalMs: 110_000, // the whole run
    stepMs: 45_000,   // one model call
    toolMs: 15_000,   // any one tool call
  },
});
```

When a timeout fires, the call throws; your `runAgent` catch in
[conversation.service.ts](../src/services/conversation.service.ts) turns that into "The assistant could not
reply. Please try again."

**Your timeouts are layers, and the order matters:**

```
one service request (http.ts)    10s    REQUEST_TIMEOUT_MS
  < one tool call                 15s    timeout.toolMs
  < the whole agent run          110s    timeout.totalMs
  < the gateway                  130s    proxy_read_timeout for /ai/
  < the conversation lock        180s    LOCK_MS
```

Each inner limit should fire before the outer one. If the agent had no `totalMs`, the gateway would cut
the connection at 130s and the user would see a gateway error, not your friendly message. The lock is the
outermost on purpose: it must outlive any answer still running.

### Cancelling

`abortSignal` stops a run from outside. Your [conversation.controller.ts](../src/controllers/conversation.controller.ts)
already does this: when the browser closes the request, it aborts the agent, so you stop paying for an
answer nobody will read. The tools pass the same signal into their `fetch` calls (`clients/http.ts`), so a
running service request stops too.

## 6. Controlling which tools are allowed per step

`prepareStep` runs before every step and can change what the model is allowed to do in that step:

| Return | Effect |
|---|---|
| `{ activeTools: ['listPosts', 'currentTime'] }` | Only these tools exist for this step |
| `{ toolChoice: 'none' }` | Tools stay defined, but the model must answer in text |
| `{ toolChoice: 'auto' }` | The default: the model decides |
| `{ model: cheaperModel }` | Use a different model for this step (lesson 18) |

Examples for your agent:

- **Force an answer on the last step:** section 2.
- **One post per request:** after `postSchedular` succeeds, remove it, so a confused model can't
  schedule a duplicate (lesson 4 has the code, and the trade-off: it also blocks "schedule on LinkedIn
  *and* Instagram").
- **Stop retrying a broken tool:** section 7.

`toolChoice` also accepts `'required'` and `{ type: 'tool', toolName }` to force a tool call. The Claude
docs say newer models reject forced tool use, so check them before relying on it. For loop control you
almost always want the opposite anyway: fewer tools, or none.

## 7. Detecting repeated calls

The clearest sign of a loop is the **same tool with the same input**, again. This rule catches it:

```ts
import type { StopCondition, ToolSet } from 'ai';

// True when the latest step repeats a tool call (same tool, same input) from an earlier step.
const sameCallTwice: StopCondition<ToolSet> = ({ steps }) => {
  const key = (call: { toolName: string; input: unknown }) => `${call.toolName}:${JSON.stringify(call.input)}`;
  const earlier = new Set(steps.slice(0, -1).flatMap((step) => step.toolCalls.map(key)));
  return steps.at(-1)?.toolCalls.some((call) => earlier.has(key(call))) ?? false;
};
```

As a `stopWhen`, it stops the run, which leaves an empty answer (section 2). The friendlier version uses the
same check in `prepareStep`: when the model repeats itself, take the tools away and let it explain:

```ts
prepareStep: ({ steps, stepNumber }) => {
  if (stepNumber === MAX_STEPS - 1 || sameCallTwice({ steps })) return { toolChoice: 'none' };
},
```

Its next answer is usually honest: "I tried to schedule it twice and the scheduler didn't respond."

**Similar, not identical:** loops often vary the input slightly (a date a week later each time). Exact
matching won't catch that. Count calls per tool instead (for example, more than 3 `listPosts` calls in one
run is suspicious), or compare only the fields that matter.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `stopWhen` | One stop condition or an array. Checked after each step that called tools; any `true` stops the loop. |
| `isStepCount(n)` | Stops after `n` steps. `ToolLoopAgent` default: 20. `generateText` default: 1. |
| `hasToolCall('name', ...)` | Stops right after the latest step called one of these tools |
| `isLoopFinished()` | Never stops; runs until the model answers. No safety net. |
| `StopCondition` | The type of a custom condition: `({ steps }) => boolean` (or a promise) |
| `prepareStep({ steps, stepNumber, ... })` | Before each step: return `activeTools`, `toolChoice`, `model`, `instructions` or `messages` for that step |
| `activeTools` | Which tools exist for a step |
| `toolChoice` | `'auto'`, `'none'`, `'required'`, or `{ type: 'tool', toolName }` |
| `timeout` | Milliseconds, or `{ totalMs, stepMs, toolMs, tools: { <name>Ms } }` |
| `abortSignal` | Cancel a run from outside (a closed browser request) |
| `step.usage` / `result.usage` | Tokens per step / for the whole run, for budgets |

---

## Build: stop a runaway loop three ways

Use a fake tool, not your real services, so a runaway loop costs a few cents and creates no posts.

1. **Write the broken tool:** `src/lessons/06-runaway-loop.ts`. A `checkPublishStatus` tool that always
   returns `{ status: 'processing', message: 'Not ready yet. Try again.' }`. A realistic trap: publishing
   really is slow, and "try again" invites the model to do exactly that.
2. **Watch it loop:** a `ToolLoopAgent` with only that tool, instructions like "Check whether the post has
   been published and tell the user", and `stopWhen: isStepCount(20)`. Log every step with `onStepEnd`.
   Note the steps, the tokens, and what `result.text` is at the end.
3. **Stop it three ways**, one at a time, and run each:
   - **Step limit:** `isStepCount(5)`.
   - **Rule:** the `sameCallTwice` condition from section 7.
   - **Budget:** `overTokenBudget(...)` from section 4, set low enough to trigger.
4. **Make the user always get an answer:** add the `prepareStep` from section 7 (last step or a repeat →
   `toolChoice: 'none'`) and the code fallback from section 2. Rerun all three; every run must end with
   sensible text.
5. **Fix the cause:** change the tool's result to something that doesn't invite a retry, like
   `{ status: 'processing', message: 'Publishing takes a few minutes. Tell the user to check the calendar later. Do not call this tool again in this conversation.' }`.
   Run step 2 again with no limits and see whether the loop is gone.

Record what you found:

| Version | Steps | Tokens | Final text (first few words) |
|---|---|---|---|
| No limit (20) | | | |
| `isStepCount(5)` | | | |
| `sameCallTwice` | | | |
| Token budget | | | |
| Any of the above + `prepareStep` | | | |
| Fixed tool result, no limit | | | |

**Optional, on the real agent:** add `stopWhen: isStepCount(10)`, the last-step `prepareStep`, and
`timeout: { totalMs: 110_000 }` to [postScheduler.agent.ts](../src/agents/postScheduler.agent.ts), then
check that your normal requests still finish well under the limit.

---

## Done when: self-check

- [ ] **Name three causes of runaway loops**, with an example of each from this project.
- [ ] **Stop an agent by steps, by a rule and by budget**, and show that the user gets a sensible answer
      every time.

Extra checks:

- Why is `result.text` empty when `isStepCount` stops a run, and what two things make sure the user still
  gets an answer?
- Why does `hasToolCall('postSchedular')` make a bad stop condition for your agent?
- Put your five timeouts in order (service request, tool, agent run, gateway, lock) and explain what
  breaks if the agent's limit is longer than the gateway's.
- Your agent called `listPosts` four times with different dates. Would `sameCallTwice` catch it? What
  would?
- Why is improving a tool's result usually better than adding another limit?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- AI SDK: [Loop control](https://ai-sdk.dev/docs/agents/loop-control),
  [ToolLoopAgent reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent),
  [Tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- Videos (third-party, not reviewed): [How Claude Code's Agent Loop (--max turns) Actually Works](https://www.youtube.com/watch?v=yEOacsVK0N8),
  [AI Agent Mastery: Is Your Agent Stuck in a Loop?](https://www.youtube.com/watch?v=M5it7vaEAP8),
  [Fix CrewAI Agents Retrying Forever (max_iter Trap)](https://www.youtube.com/watch?v=7_3ahdTqFAo)
- Articles: [Agent guardrails: loop limits, cost caps and human approval gates](https://dev.to/gabrielanhaia/agent-guardrails-loop-limits-cost-caps-and-human-approval-gates-56fn) (DEV Community),
  [When Agents Do Not Stop](https://arxiv.org/pdf/2607.01641) (arXiv)
