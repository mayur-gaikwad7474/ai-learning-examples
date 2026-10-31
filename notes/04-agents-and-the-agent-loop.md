# Lesson 4: Agents and the agent loop

Notes for lesson 4 of [LEARNING-PATH.md](../LEARNING-PATH.md). Agent guidance was checked against
Anthropic's engineering posts, and the AI SDK details against the installed `ai@7` (7.0.153), on
2026-10-29.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic Engineering) | Read | What an agent is, workflows vs agents, the five workflow patterns, when not to build an agent. **Start here.** |
| 2 | [How We Build Effective Agents](https://www.youtube.com/watch?v=D7_ipDqhtwk) (Barry Zhang, Anthropic, AI Engineer Summit) | Video | About 15 minutes. The talk version of resource 1: don't build agents for everything, keep them simple, and look at the task from the agent's point of view. |
| 3 | [Tips for building AI agents](https://www.youtube.com/watch?v=LP5OCa20Zpg) (Anthropic) | Video | A conversation between the authors of resource 1 about where agents work, where they don't, and common mistakes |
| 4 | [AI SDK: Agents overview](https://ai-sdk.dev/docs/agents/overview) and [Building agents](https://ai-sdk.dev/docs/agents/building-agents) | Read | `ToolLoopAgent`, and when the SDK suggests plain `generateText` workflows instead |
| 5 | [AI SDK: Loop control](https://ai-sdk.dev/docs/agents/loop-control) | Read | `stopWhen`, `prepareStep`, reading steps, writing the loop yourself |
| 6 | [AI SDK: Workflow patterns](https://ai-sdk.dev/docs/agents/workflows) | Read | Optional. The five patterns from resource 1 as TypeScript. Lesson 15 goes deeper. |
| 7 | [Claude cookbooks: agent patterns](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents) (GitHub) | Hands-on | Optional. Python notebooks implementing the workflows from resource 1. |

If you only have time for one: the first two sections of resource 1 ("What are agents?" and "When (and
when not) to use agents"), then video 2.

---

## The core idea

**An agent is a model calling tools in a loop until the job is done.** You've already built one: your
post scheduler agent in [postScheduler.agent.ts](../src/agents/postScheduler.agent.ts) is a
`ToolLoopAgent`. Lesson 3 was about the tools. This lesson is about the loop around them: who decides
what happens next, when it stops, and how you see what it did.

The key difference from ordinary code: **in an agent, the model decides the order of the steps.** You
write the tools and the instructions; the model decides which tool to call next based on what the last
one returned. That flexibility is the whole point, and also the whole risk.

---

## 1. The loop

`ToolLoopAgent` is roughly this `while` loop, written for you:

```ts
const messages = [...yourMessages]
while (true) {
  const response = await callModel({ instructions, tools, messages })   // one step
  messages.push(response)

  if (response.finishReason !== 'tool-calls') break        // the model answered: done
  const results = await runTools(response.toolCalls)        // your execute functions
  messages.push(results)

  if (stopWhen({ steps })) break                            // your safety limit
}
return { text: response.text, steps, responseMessages }
```

Think → call a tool → read the result → repeat → answer:

```
          ┌──────────────────────────────────────────────┐
          ▼                                              │
  model reads instructions + messages                    │
          │                                              │
   wants a tool? ── yes ──► your code runs execute ──► result added to messages
          │
          no
          ▼
     final answer
```

**When the loop stops** (from the `ai@7` source):

1. The model finishes for any reason other than `'tool-calls'`, usually `'stop'`: it wrote its answer.
2. The model calls a tool that has no `execute` function, so there's nothing to run.
3. A tool call needs approval (lesson 13).
4. A `stopWhen` condition returns `true`. It's only checked after a step that had tool results.

**The default limits differ, and it's an easy trap:**

| | Default `stopWhen` | What happens with tools |
|---|---|---|
| `new ToolLoopAgent(...)` | `isStepCount(20)` | Loops until the model answers, up to 20 steps |
| `generateText(...)` | `isStepCount(1)` | Runs **one** step. If the model calls a tool, the tool runs, then it stops, and `result.text` is empty because the model never got to answer. |

So `generateText` with tools needs an explicit `stopWhen: isStepCount(5)` (or similar) to behave like
an agent. Your agent relies on the default of 20. Lesson 6 covers choosing limits and stopping runaway
loops.

## 2. Steps

**A step is one model call**, plus the tools it asked for. Your "schedule Hello World on Instagram
tomorrow at 10am" request from the lesson 3 notes is four steps:

| Step | Model did | `finishReason` |
|---|---|---|
| 0 | Called `currentTimeTool` | `'tool-calls'` |
| 1 | Called `accountListTool` | `'tool-calls'` |
| 2 | Called `postSchedularTool` | `'tool-calls'` |
| 3 | Wrote "Done! Hello World is scheduled…" | `'stop'` |

Things worth knowing:

- **One step can call several tools.** If the model needs the time and the accounts, and neither depends
  on the other, it can ask for both in one step. The SDK runs them at the same time (set
  `toolCallConcurrency: 1` to run them one after another). That's one model call saved.
- **Every step resends everything before it.** Step 3 sends the instructions, the tool definitions, your
  message and all three tool calls and results. That's why input tokens grow each step (lesson 1).
- **The model can change plan between steps.** If `accountListTool` returns no Instagram account, step
  2 can be "tell the user" instead of scheduling. A fixed script can't do that.

### Reading `result.steps`

Everything the loop did is on the result. This prints a run step by step:

```ts
const result = await agent.generate({ prompt: 'Which accounts are connected, and what is scheduled this week?' })

result.steps.forEach((step, i) => {
  console.log(`step ${i}: ${step.finishReason}`)
  for (const call of step.toolCalls) console.log('  call  ', call.toolName, JSON.stringify(call.input))
  for (const r of step.toolResults) console.log('  result', r.toolName, JSON.stringify(r.output).slice(0, 120))
  console.log('  tokens in/out', step.usage.inputTokens, step.usage.outputTokens)
})
console.log('answer:', result.text)
console.log('total tokens:', result.usage)
```

That prompt only reads data, so it's safe to run against your real services. A scheduling prompt would
create a real post.

| Field | What it holds |
|---|---|
| `result.steps` | Every step, in order |
| `result.finalStep` | The last step (same as `steps.at(-1)`) |
| `result.text` | The text of the **final step only** |
| `result.usage` | Tokens for **all steps added together**. In `ai@7`, `totalUsage` is a deprecated alias for it. |
| `result.responseMessages` | All the assistant and tool messages the run added. Your server returns these so the next turn has the full history. |
| `step.toolCalls` / `step.toolResults` | What the model asked for in that step, and what your tools returned |
| `step.finishReason` | `'tool-calls'` (keep going), `'stop'` (answered), `'length'` (hit the output token limit), and a few others |

## 3. Workflow vs agent

Anthropic's definitions, from resource 1:

- **Workflow:** models and tools follow **predefined code paths**. Your code decides the order.
- **Agent:** the model **directs its own process** and decides which tools to use and when.

| | Workflow | Agent |
|---|---|---|
| Who decides the next step | Your code | The model |
| Predictable | Yes: same path every time | No: the path can differ between runs |
| Cost and speed | Usually fewer model calls | More calls; each step resends the history |
| Handles the unexpected | Only the cases you coded | Can adapt: ask a question, try another tool |
| Easy to test | Yes | Harder; you test behavior over many runs (lessons 3 and 17) |
| Good for | Well-defined tasks with known steps | Open-ended tasks where you can't list the steps in advance |

Anthropic's advice is to **start with the simplest thing that works**: often a single model call with
good context, then a workflow, and an agent only when the task really needs the model to decide the
path. Agents trade cost, speed and predictability for flexibility, and mistakes can compound over many
steps.

### Your scheduler, both ways

Your agent is an agent. The same task as a **workflow** could look like this (a sketch; `Output.object`
is lesson 5):

```ts
// Workflow: your code fixes the order. The model makes one call to fill in the blanks.
const accounts = await fetchConnectedAccounts(identity)
const { output } = await generateText({
  model,
  instructions: 'Extract the post details from the request. Use only the accounts listed.',
  prompt: `<now>${new Date().toISOString()}</now>
<accounts>${JSON.stringify(accounts.map((a) => ({ id: a._id, name: a.name, platform: a.accountType })))}</accounts>
<request>${userText}</request>`,
  output: Output.object({ schema: z.object({ accountId: z.string(), caption: z.string(), scheduledTime: z.iso.datetime({ offset: true }) }) }),
})
await createPost(identity, output)   // your code makes the call, not the model
```

Compare them:

- **Workflow:** one model call instead of four, always the same order, easy to test. But if the user
  says "schedule a post" with no caption, it can't ask; it either invents one or fails. And "what's
  scheduled this week?" needs a whole separate workflow.
- **Agent:** handles scheduling, listing, questions and missing details in one place, because the model
  picks the path. It costs more calls and needs evals to trust.

A chat where people can ask anything about their posts suits an agent. A "schedule from this form"
button suits a workflow. Being able to argue that difference is this lesson's main skill.

The five workflow patterns from resource 1, for reference; lesson 15 covers them properly:

| Pattern | In one line |
|---|---|
| Prompt chaining | Step A's output is step B's input, with checks in between |
| Routing | Classify the input, then send it to the right prompt or model |
| Parallelization | Run independent parts at once, or the same task several times and combine |
| Orchestrator-workers | One model splits the task and hands parts to others |
| Evaluator-optimizer | One model writes, another grades, repeat until good enough |

## 4. Instructions as the agent's job description

In a single call, the prompt is the task. In an agent, `instructions` are the **standing job
description** the model reads at every step. They should cover:

1. **The role:** what the agent is for.
2. **How to use the tools together:** the order and the rules between them. Tool descriptions say what
   each tool does; instructions say how they combine.
3. **What to do when information is missing:** ask, or use a default?
4. **What never to do:** with the reason, as in lesson 2.

Your agent's instructions do most of this:

```ts
const INSTRUCTIONS = [
  'You help people schedule social media posts in Creatosaurus.',                         // role
  'Use the current time tool before working out any date or time.',                       // tool order
  'Use the account list tool to find account IDs. Never guess an ID.',                    // tool order + rule
  'If a detail for a post is missing, ask for it instead of making it up.',               // missing info
  'When the user attaches images or videos, their message lists them under "Attached media" ...', // tool input source
].join('\n');
```

Things it doesn't say yet, which you could test adding:

- What to do when a tool returns an error. For example: don't retry the same input; explain the problem
  to the user.
- Whether to confirm before scheduling. Scheduling publishes to a real account; lesson 13 covers approval
  properly.

**Keep the instructions identical on every turn.** Your comment in the agent file says why: Claude's
thinking is tied to the exact system prompt, so instructions that change between turns (a timestamp,
the user's name) break the next turn. Anything that changes belongs in a tool result or the messages.
Stable instructions also make prompt caching work (lesson 18).

## 5. Watching and steering the loop

The agent takes hooks into the loop. These are the ones for this lesson:

| Option | Runs | Use it to |
|---|---|---|
| `onStepStart` | Before each model call | Log or time a step |
| `onToolExecutionStart` / `onToolExecutionEnd` | Around each `execute` | Log which tools ran and how long they took |
| `onStepEnd` | After each step | Log the step's tool calls, results and tokens |
| `prepareStep` | Before each step | **Change** the next step: the model, which tools are available, the messages |

Your [conversation.service.ts](../src/services/conversation.service.ts) logs steps with `onStepEnd`. In `ai@7`,
`onStepFinish` is a deprecated alias for it; it still works, but use `onStepEnd` in new code.

`prepareStep` receives the steps so far and can return overrides for the next step. For example, to
stop the model scheduling a second post after one succeeded:

```ts
prepareStep: ({ steps }) => {
  const scheduled = steps.some((step) =>
    step.toolResults.some((r) => !r.dynamic && r.toolName === 'postSchedularTool' && r.output.success),
  )
  if (scheduled) return { activeTools: ['currentTimeTool', 'accountListTool', 'listPostsTool'] }
},
```

`!r.dynamic` tells TypeScript this result came from one of your own tools, so it knows the shape of
`r.output`. Without it, `r.output.success` doesn't typecheck.

Notice the trade-off: this also blocks "schedule it on Instagram *and* LinkedIn", which legitimately
needs two calls. Steering the loop in code is powerful, but every rule you add is a rule about what the
agent can no longer do. Lesson 6 uses `prepareStep`, `activeTools` and `stopWhen` to stop runaway
loops; lesson 10 uses `prepareStep` to trim long histories.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `new ToolLoopAgent({ model, instructions, tools, stopWhen })` | Defines an agent. Create it once and reuse it, or once per request when it needs per-request context, as yours does. |
| `agent.generate({ prompt \| messages })` | Runs the loop to the end and returns the result |
| `agent.stream(...)` | Same loop, streamed as it runs (lesson 7) |
| `stopWhen` | `isStepCount(n)` (agent default 20), `hasToolCall('name')`, `isLoopFinished()`, a custom function, or an array where any one stops the loop |
| `result.steps`, `result.finalStep` | What happened, step by step |
| `result.text` | The final step's text |
| `result.usage` | Tokens across all steps (`totalUsage` is deprecated) |
| `result.responseMessages` | The messages this run added, for the next turn's history |
| `prepareStep` | Per-step overrides: `model`, `activeTools`, `toolChoice`, `instructions`, `messages` |
| `onStepStart`, `onStepEnd`, `onToolExecutionStart`, `onToolExecutionEnd` | Callbacks around steps and tools. `onStepFinish` is a deprecated alias for `onStepEnd`. |
| `toolCallConcurrency` | How many tool calls in one step run at once (default: all) |

---

## Build: post idea agent, then the same as a workflow

The exercise in `LEARNING-PATH.md` uses `getWeather`, but the weather tool is gone from this project. Use
your Creatosaurus tools instead; the lesson is the same.

1. **Read a real run first.** Use the `result.steps` snippet from section 2 with your post scheduler
   agent and the read-only prompt. Write down each step's tool calls and tokens, and check that
   `result.usage` equals the steps added together.
2. **Add a fake `getTrendingTopics` tool** in `src/tools/`. It returns a fixed list of 5–8 topics with a
   short description each; no network call.
3. **Build the agent:** `src/agents/postIdea.agent.ts`, a `ToolLoopAgent` with `currentTimeTool`,
   `listPostsTool` and `getTrendingTopics`. Its job: suggest three post ideas for this week that don't
   repeat what's already scheduled. Write its instructions using section 4.
4. **Build the same thing as a workflow:** `src/lessons/04-post-idea-workflow.ts`. Your code calls the
   time, the post list and the topics in a fixed order, then makes **one** `generateText` call with all
   of it in the prompt.
5. **Run both on the same 3 requests**, twice each. For example: "ideas for this week", "ideas for
   LinkedIn only", and "ideas about our new feature launch".
6. **Try to break the agent:** a request where the right move is to call no tools ("what makes a good
   hook?"), and one where it should ask a question first.

Record what you found:

| Request | Version | Steps / model calls | Tokens | Same path both runs? | Quality notes |
|---|---|---|---|---|---|
| Ideas for this week | Agent | | | | |
| Ideas for this week | Workflow | 1 | | Yes | |
| LinkedIn only | Agent | | | | |
| LinkedIn only | Workflow | 1 | | Yes | |

---

## Done when: self-check

- [ ] **Draw the agent loop** from memory: model call, tool calls, results back, repeat, answer. Include
      the four ways it stops.
- [ ] **Choose between a workflow and an agent for a task**, and justify it with your table above: when
      did the agent's flexibility pay for its extra steps, and when didn't it?
- [ ] **Read `result.steps` and explain what happened:** for one run, say why the model made each call,
      and where the tokens went.

Extra checks:

- Why does `generateText` with tools return empty `text` by default, while `ToolLoopAgent` doesn't?
- Your agent took 6 steps where 3 would do. How do you find out why, and which two places would you
  change first?
- Name one Creatosaurus feature that should be a workflow, and one that should be an agent.
- Why must the agent's instructions stay the same on every turn, and where should a changing value like
  today's date go instead?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- Talks: [How We Build Effective Agents](https://www.youtube.com/watch?v=D7_ipDqhtwk) (Barry Zhang),
  [Tips for building AI agents](https://www.youtube.com/watch?v=LP5OCa20Zpg) (Anthropic)
- AI SDK: [Agents overview](https://ai-sdk.dev/docs/agents/overview),
  [Building agents](https://ai-sdk.dev/docs/agents/building-agents),
  [Loop control](https://ai-sdk.dev/docs/agents/loop-control),
  [Workflow patterns](https://ai-sdk.dev/docs/agents/workflows)
- [Claude cookbooks: agent patterns](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents)
