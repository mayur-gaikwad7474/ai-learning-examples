# Lesson 15: Multi-agent design patterns

Notes for lesson 15 of [LEARNING-PATH.md](../LEARNING-PATH.md). The patterns follow Anthropic's engineering
posts, and the AI SDK details were checked against the installed `ai@7` (7.0.153) source and its bundled
docs (`node_modules/ai/docs/03-agents/03-workflows.mdx` and `06-subagents.mdx`), on 2026-11-04.

> **Words you'll see elsewhere:** "routing", "router" and "intent classification" all mean section 3.
> "Supervisor", "orchestrator" and "manager agent" mean section 5. "Subagent" and "agents as tools" mean
> an agent that another agent calls through a tool. "Handoff" (OpenAI Agents SDK, LangGraph) is a router
> that passes the whole conversation to another agent; the AI SDK has no special API for it, because it's
> just routing in your own code.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (Anthropic Engineering) | Read | Re-read the "Workflow" section: prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer, each with when to use it. **Start here.** |
| 2 | [AI SDK: Workflow patterns](https://ai-sdk.dev/docs/agents/workflows) | Read | The same five patterns as TypeScript with `generateText`, `Output` and `Promise.all` |
| 3 | [AI SDK: Subagents](https://ai-sdk.dev/docs/agents/subagents) | Read | Agents as tools: a tool whose `execute` runs another agent, `toModelOutput`, cancelling, and the caveats |
| 4 | [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) (Anthropic Engineering) | Read | A real orchestrator with parallel workers: when it pays off, what it costs, and how they prompted it |
| 5 | [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents) (Cognition) | Read | The case against: agents that can't see each other's context make conflicting decisions. Read it right after resource 4. |
| 6 | [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working) (Cognition, 2026) | Read | Optional. The same team a year later: which multi-agent setups now work for them, and which still don't |
| 7 | [Building with Subagents: Design Decisions](https://www.youtube.com/watch?v=A3DKwLORVe4) | Video | Implementation choices for subagents and why they matter for quality |
| 8 | [Choosing the Right Multi-Agent Architecture](https://www.youtube.com/watch?v=fqvbxkgU6vE) | Video | When you need more than one agent, and four architectures compared |
| 9 | [Claude cookbooks: agent patterns](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents) (GitHub) | Hands-on | Optional. Python notebooks for the five workflow patterns |

The videos (7 and 8) are third-party and were chosen by title and description; I couldn't watch them. If
you only have time for one thing: resource 1's workflow section, then resources 4 and 5 back to back,
because they disagree and you need both sides.

---

## The core idea

**A "multi-agent system" is mostly ordinary code calling the model more than once.** Each pattern in this
lesson is a different answer to one question: *who decides what happens next, and with what context?*

```
one agent          the model decides every step, with one shared history
workflow patterns  your code decides the order; each model call gets only what it needs   (sections 2–6)
agents as tools    one agent decides when to call another, which starts with a fresh history (section 5)
```

You already know the two ends from lesson 4: a workflow (your code decides) and an agent (the model
decides). This lesson is everything in between, and the main skill is the same as lesson 4: **pick the
simplest one that works**, and be able to say why the extra calls are worth it.

Your post agent is one agent with six tools. That's the right starting point, and for its current job
it's probably still the right answer. Everything below is for when it stops being enough.

---

## 1. Start with one agent

Before splitting anything, ask what's actually wrong with the single agent. The usual real reasons are:

| Symptom | What it looks like | Try first, before a second agent |
|---|---|---|
| Too many tools | It picks the wrong tool between similar ones | Better tool descriptions (lesson 3), `activeTools` per step (lesson 6) |
| Instructions pulling two ways | "Be playful in captions" fights "be precise about times" | Split the *instructions* by task, in one place (section 7) |
| Context too big | Long tool results crowd out the conversation | Return less from tools, pass IDs (section 8), context engineering (lesson 10) |
| Quality not good enough | Captions are bland | A check and one rewrite (section 6), a better model for that step |
| Too slow | Steps that don't depend on each other run one after another | Run them at the same time (section 4) |

Only the last three really need more than one model call, and none of them needs a second *agent*.
A second agent earns its place when one task needs a **different job description, different tools and
a fresh context** at the same time.

Two rules of thumb from resources 1, 4 and 5:

- **Reading splits well, writing doesn't.** Several agents that look things up and report back are easy
  to combine. Several agents that each *make changes* (schedule, edit, delete) make decisions the others
  can't see, and they conflict. Keep write actions in one agent.
- **Each agent knows only what you pass it.** A subagent doesn't see the conversation unless you send it.
  Most multi-agent bugs are a missing piece of context.

## 2. Prompt chaining

**Step A's output is step B's input, with a check in your code between them.** Use it when a task
breaks into fixed steps, and each step is easier for the model than the whole task.

```
idea  →  caption  →  [code check: length, no banned words]  →  hashtags
                       ↓ fails
                     stop, or rewrite once
```

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

const LIMITS = { x: 280, linkedin: 3000, instagram: 2200 } as const;

export const writePost = async (topic: string, platform: keyof typeof LIMITS) => {
  // Step 1: pick an angle.
  const { output: idea } = await generateText({
    model,
    instructions: 'You suggest one angle for a social media post.',
    output: Output.object({ schema: z.object({ angle: z.string(), hook: z.string() }) }),
    prompt: `Topic: ${topic}\nPlatform: ${platform}`,
  });

  // Step 2: write the caption from that angle only.
  const { text: caption } = await generateText({
    model,
    instructions: `You write ${platform} captions. Use the hook as the first line.`,
    prompt: `<angle>${idea.angle}</angle>\n<hook>${idea.hook}</hook>`,
  });

  // The gate: plain code, no model. Cheap, exact, and it never "kind of" passes.
  if (caption.length > LIMITS[platform]) {
    throw new Error(`Caption is ${caption.length} characters; ${platform} allows ${LIMITS[platform]}.`);
  }

  return { idea, caption };
};
```

What makes it work:

- **The gate is code whenever it can be.** Length, required words, a valid date: check them with code.
  Use a model to check only what code can't (tone, accuracy), and that's section 6.
- **Each step gets a smaller prompt**, so it's easier to get right and easier to debug: when the caption
  is bad, you can see whether the angle was already bad.
- **The cost is latency.** Three calls in a row take three times as long. Chain only where splitting
  improves the result.

## 3. Routing

**Classify the input first, then send it to the prompt, model or agent built for that kind of input.**
This is the answer to "I have two agents; how does a request reach the right one?"

```
request → router (one cheap model call, Output.choice) → caption agent
                                                        → post idea agent
                                                        → "other": a fixed reply, or ask a question
```

```ts
type Route = 'caption' | 'ideas' | 'other';
const ROUTES: Route[] = ['caption', 'ideas', 'other'];

const route = async (request: string): Promise<Route> => {
  const { output } = await generateText({
    model,
    instructions: [
      'Pick who should handle a Creatosaurus user request.',
      'caption: they want a caption written or improved for a post they already have in mind.',
      'ideas: they want suggestions for what to post about.',
      'other: anything else, or you cannot tell.',
    ].join('\n'),
    output: Output.choice({ options: ROUTES }),
    prompt: `<request>${request}</request>`,
  });
  return output;
};

const handlers: Record<Route, (request: string) => Promise<string>> = {
  caption: async (request) => (await captionAgent.generate({ prompt: request })).text,
  ideas: async (request) => (await ideaAgent.generate({ prompt: request })).text,
  other: async () => 'I can write captions and suggest post ideas. What would you like?',
};

const answer = await handlers[await route(request)](request);
```

(`ROUTES` is a typed array so TypeScript keeps the exact options, as in lesson 5, section 2.)

### Four ways to route

| Router | How | Good for | Watch out |
|---|---|---|---|
| **Code** | The app already knows: which button, which page, which endpoint | Anything the UI can decide | Nothing; use it whenever you can |
| **Classifier** | One model call with `Output.choice` (above) | Free text where the categories are clear | One extra call before the answer starts |
| **Embeddings** | Compare the request to example requests for each route (lesson 11) | High volume, many routes, no extra model call | Needs good examples for every route |
| **Model picks a tool** | Give one agent each specialist as a tool (section 5) | When a request may need several specialists | The model may call none, or the wrong one |

**Always have a way out.** An `other` option, or a confidence field with `Output.object`, so a request
that fits nothing gets a question back instead of being forced into the closest wrong route.

**Route with a smaller model.** The router answers with a single word, so the fastest, cheapest model is
usually enough; save the stronger model for the agent that does the work. Measure it with evals before
assuming.

### Routing in a chat

In your chat, a route is chosen per **message**, but the history belongs to the **conversation**. If
message 1 goes to the caption agent and message 2 to the idea agent, the idea agent sees the caption
agent's tool calls in its history, from tools it doesn't have. Two simple options:

- **Route once per conversation** and save the route on the conversation document. The router runs on
  the first message only. This is the simplest and the most predictable.
- **Route every message, but give every agent the same history rules**: only text from earlier turns, or
  a short summary (lesson 10).

Routing happens *before* `pipeAgentUIStreamToResponse` in
[conversation.service.ts](../src/services/conversation.service.ts): it decides which `agent` you pass in.
Nothing else in the streaming code changes.

## 4. Parallel work

**Run independent calls at the same time with `Promise.all`.** There are two kinds:

| Kind | What | Creatosaurus example |
|---|---|---|
| **Sectioning** | Different parts of one task, at once | One caption each for LinkedIn, Instagram and X |
| **Voting** | The same task several times, then combine | Ask three times "is this comment spam?" and take the majority |

```ts
const PLATFORMS = ['linkedin', 'instagram', 'x'] as const;

const captions = await Promise.all(
  PLATFORMS.map(async (platform) => {
    const { text } = await generateText({
      model,
      instructions: `You write ${platform} captions.`,
      prompt: `<topic>${topic}</topic>`,
      abortSignal,
    });
    return { platform, caption: text };
  }),
);
```

What to know:

- **It's faster, not cheaper.** Three calls cost three calls; they just finish in the time of the slowest.
- **One failure fails `Promise.all`.** If two captions are fine and one errors, `Promise.all` throws and
  you lose all three. Use `Promise.allSettled` when partial results are useful, and show which one failed.
- **Rate limits.** Ten parallel calls can hit the provider's per-minute limit at once (lesson 19). Keep
  the number small, or limit how many run together.
- **Pass the same `abortSignal` to every call**, so the Stop button stops all of them (lesson 7).
- **Voting needs disagreement to be useful.** Three identical answers tell you nothing new; voting helps
  on borderline cases, and costs three times as much on every case.

## 5. Orchestrator and workers

**One model works out the subtasks, then hands each to a worker.** It looks like parallel work, but the
difference is that **the list of subtasks isn't known in advance**: the orchestrator decides it per
request.

```
"Plan next week: 4 posts, LinkedIn and Instagram"
        ↓
orchestrator → [ {day: Mon, platform: linkedin, angle: …}, {day: Tue, …}, … ]   (Output.array)
        ↓
workers (Promise.all) → one caption each
        ↓
your code (or one more call) puts them together
```

There are two ways to build it, and the difference is who drives:

### A. Code drives (a workflow)

The orchestrator is one `generateText` call that returns a plan; your code runs the workers. This is
predictable and easy to test, and it's the version in resource 2.

```ts
const { output: plan } = await generateText({
  model,
  instructions: 'You plan a week of social media posts. Do not write the captions.',
  output: Output.array({
    element: z.object({
      day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
      platform: z.enum(['linkedin', 'instagram', 'x']),
      angle: z.string().describe('One sentence: what this post is about and why it fits that day.'),
    }),
    maxItems: 7,
  }),
  prompt: request,
});

const posts = await Promise.all(plan.map((item) => writeCaption(item, abortSignal)));
```

### B. The model drives (agents as tools)

The orchestrator is an agent, and each worker is a **tool whose `execute` runs another agent**. The model
decides when to call a worker, how many times, and what to do with the answer. This is how the AI SDK
does subagents (resource 3):

```ts
import { tool, ToolLoopAgent } from 'ai';
import { z } from 'zod';
import { identitySchema } from '../schemas/identity.schema.ts';
import type { Identity } from '../schemas/identity.schema.ts';

// A read-only specialist: it can look things up, never change them.
const createCalendarReader = (identity: Identity) =>
  new ToolLoopAgent({
    model,
    instructions:
      'You look up connected accounts and scheduled posts in Creatosaurus. ' +
      'End with a short summary of what you found: it is all the caller will see.',
    tools: { currentTime, accountList: listAccounts, listPosts },
    toolsContext: { accountList: identity, listPosts: identity },
  });

// The worker, as a tool. The identity comes from our code through context, never from the model.
const askCalendar = tool({
  description: 'Ask about the connected accounts and scheduled posts. Read-only. Returns a short summary.',
  inputSchema: z.object({
    question: z.string().describe('A complete question, with every detail the reader needs.'),
  }),
  contextSchema: identitySchema,
  execute: async ({ question }, { context, abortSignal }) => {
    const result = await createCalendarReader(context).generate({ prompt: question, abortSignal });
    return result.text;
  },
});
```

The orchestrator then lists `askCalendar` in its `tools` and passes the identity in `toolsContext`,
exactly like your other tools.

Things that matter here, from the installed docs and types:

- **The worker starts with an empty history.** It sees only `question`. That's the point (its long tool
  results stay out of the orchestrator's context), and also the main risk: if the orchestrator writes a
  vague question, the worker can't ask what was meant. That's why the `describe()` above asks for "every
  detail". `execute` also receives `messages` if a worker really needs the conversation; use it sparingly.
- **Pass `abortSignal` through**, or Stop won't stop the worker.
- **No approvals inside a worker.** The docs say subagent tools can't use `toolApproval`. Your `deletePost`
  needs approval, so it must stay on the agent the user talks to. This matches the "keep write actions in
  one agent" rule from section 1.
- **`toModelOutput` controls what the orchestrator sees.** If a worker returns a big object, you can show
  all of it in the UI and send the model only a summary.
- **Workers can stream progress** with an `async function*` `execute` that yields as it goes (resource 3).
  Start without it.

**A or B?** Use A when you can describe the plan's shape in a schema. Use B when the orchestrator needs to
react to what workers find (ask a follow-up, skip a step). B is more flexible and much harder to predict.

## 6. Evaluator and optimizer

**One call writes, another grades it against clear criteria, and the writer tries again with the
feedback.** Use it when you can say what "good" means, and a second attempt with feedback really does
improve the result.

```ts
const gradeSchema = z.object({
  score: z.number().min(1).max(10),
  hasHookInFirstLine: z.boolean(),
  fitsPlatform: z.boolean(),
  fix: z.string().describe('The single most important change. Empty if the caption is good.'),
});

let caption = await writeCaption(request);

for (let attempt = 0; attempt < 1; attempt++) {
  const { output: grade } = await generateText({
    model,
    instructions: 'You review social media captions. Be strict and specific.',
    output: Output.object({ schema: gradeSchema }),
    prompt: `<platform>${platform}</platform>\n<caption>${caption}</caption>`,
  });

  if (grade.score >= 7 && grade.hasHookInFirstLine && grade.fitsPlatform) break;
  caption = await rewriteCaption(caption, grade.fix);
}
```

What makes it work:

- **A hard limit on rounds.** This is lesson 6's runaway loop in another form: a strict grader and a
  writer that can't satisfy it will go on forever. One rewrite is often enough; measure before allowing
  more.
- **Booleans and specific checks beat one score.** "Has a hook in the first line" is easier to judge
  consistently than "7 out of 10". The score is a made-up number, like `confidence` in lesson 5.
- **Feedback must be something the writer can act on.** "Make it better" changes nothing; "the first
  line is a question about pricing, open with the result instead" does.
- **A model grading its own kind of output is biased** toward liking it. Use explicit criteria, and check
  the grader itself against your own judgement on a few examples (lesson 17).
- **The user waits for every round.** Grade in the background, or only for things that are worth the wait.

## 7. Specialists as configurations

A "specialist agent" isn't a separate service or a special class. It's a **configuration**:

```
specialist = model + instructions + tools + output shape
```

So a caption writer and a post idea agent are two `ToolLoopAgent`s built from two settings objects, in the
same process, sharing the same tools file:

```ts
const SPECIALISTS = {
  caption: {
    instructions: 'You write and improve social media captions. Ask for the platform if it is missing.',
    tools: {},
  },
  ideas: {
    instructions: 'You suggest post ideas that do not repeat what is already scheduled.',
    tools: { currentTime, listPosts },
  },
} as const;
```

What follows from that:

- **Splitting is cheap to try and cheap to undo.** If two specialists turn out to need each other's
  tools, merge them back into one agent.
- **Each specialist can use a different model.** The router and simple specialists can use the cheapest
  model; the one whose output people read can use the best.
- **Keep each specialist's instructions identical on every turn** (lesson 4), so give each specialist one
  fixed set of instructions, not one built per request.
- **The AI SDK can also change a single agent per call.** `callOptionsSchema` with `prepareCall` lets one
  `ToolLoopAgent` pick its model, instructions or `activeTools` from options you pass at runtime
  (resource: `node_modules/ai/docs/03-agents/05-configuring-call-options.mdx`). That's often all the
  "multi-agent" a product needs.

## 8. Passing IDs instead of long text

When one agent hands work to another, **send a reference, not a copy.**

```
Bad:   orchestrator → worker: "Rewrite this post: { …the whole post JSON, 40 lines… }"
Good:  orchestrator → worker: "Rewrite the caption of post 6731…; keep the same tone"
       worker → listPosts / its own tool → reads the post itself
```

Why:

- **Every copy costs tokens twice:** once when the orchestrator writes it into the tool call, and again
  when the worker reads it.
- **Copies drift.** The model may shorten, "fix" or reformat the text while copying it. An ID can't
  change in transit, and if the model invents one, the service rejects it.
- **The same goes for answers.** A worker that saved something should return `{ postId, status }`, not
  the whole post. The UI can show the full post from the tool result; the model only needs the ID.

You've already used this pattern: `mediaIds` in [posts.tools.ts](../src/tools/posts.tools.ts) (see lesson
3, "Media in `postSchedularTool`"). The image never goes through the model; a short ID does, and
post-scheduler checks it belongs to the workspace.

## 9. The extra cost

Every pattern here trades money, time or predictability for quality or flexibility. Be ready to say
which you're paying for each one:

| Pattern | Extra model calls | Extra time | Main risk |
|---|---|---|---|
| Prompt chaining | One per step | Adds up: steps run one after another | A bad early step spoils the rest |
| Routing | One (the router) | One short call before the answer starts | Wrong route, wrong answer |
| Parallel | One per branch | Little: the slowest branch | Rate limits; partial failures |
| Orchestrator and workers | Plan + one per worker (+ combine) | Plan time + slowest worker | Workers missing context; hard to predict |
| Evaluator and optimizer | Two per round | Every round | Never satisfied; biased grader |

Numbers worth knowing, from resource 4: Anthropic measured agents using about **4× the tokens** of a chat,
and multi-agent systems about **15×**. They found it worth it for broad research questions that split into
independent parts, and not worth it for tasks where every agent needs the same context or where the work
depends on each step before it, which describes most coding and most writing.

Costs that don't show up on the bill:

- **Your usage numbers are incomplete.** When a tool runs a subagent, the subagent's tokens are in *its*
  result, not in the orchestrator's `result.usage`. Add them up yourself, or your cost tracking
  undercounts (lesson 16).
- **Debugging spans several runs.** A bad answer could come from the router, the orchestrator's question,
  the worker, or the combine step. Log each one with the same request ID.
- **Evals multiply.** Test the router on its own (did it pick the right route?) as well as the end result.

**When not to use multiple agents:** the task is small; every part needs the whole context; the parts make
changes that must agree with each other; or one agent with better instructions and tools hasn't been
tried yet.

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `generateText({ instructions, prompt, output })` | One step of a chain, a router, a worker or a grader |
| `Output.choice({ options })` | The router's answer: exactly one route |
| `Output.object({ schema })` | A grade, or a route with a reason and confidence |
| `Output.array({ element, maxItems })` | An orchestrator's plan |
| `Promise.all` / `Promise.allSettled` | Parallel branches and workers; `allSettled` keeps partial results |
| `tool({ execute })` where `execute` calls `agent.generate()` | Agents as tools: a subagent |
| `execute(input, { context, abortSignal, messages })` | What a worker tool gets: your context, the cancel signal, and the conversation if needed |
| `toModelOutput` | What the calling model sees of a tool's output, for example a summary |
| `async function*` `execute` | A tool that yields progress, for streaming a subagent's work |
| `callOptionsSchema` + `prepareCall` | One agent that changes model, instructions or tools per call |
| `activeTools` | Limit which tools a step may use (lesson 6) |

---

## Build: route, write, grade

The exercise from `LEARNING-PATH.md`: a router that picks a "caption writer" or "post idea" agent, then an
evaluator that scores the result and asks for one rewrite if the score is low. If you skipped lesson 5's
inbox classifier, this is where `Output.choice` and `Output.object` get used for real.

1. **Write the specialists** in `src/agents/caption.agent.ts` and `src/agents/postIdea.agent.ts`, as in
   section 7. The caption agent needs no tools. The idea agent gets `currentTime` and `listPosts`, so it
   needs the identity; reuse `TEST_USER_ID` and `TEST_WORKSPACE_ID` from lesson 7.
2. **Write the router** in `src/lessons/15-router.ts` with `Output.choice(['caption', 'ideas', 'other'])`,
   and a fixed reply for `other`.
3. **Test the router alone first.** Write 12 requests with the route you expect: four for each route, and
   a few hard ones ("ideas for a caption about our launch", "hi", "schedule this for tomorrow", a request
   in Hindi). Print expected vs actual. Then try the cheapest model for the router and compare.
4. **Add the evaluator** from section 6 for the caption route: booleans plus a score and one `fix`, at most
   one rewrite. Print the caption before and after, and the grade.
5. **Count the cost.** For three requests, add up the tokens of every call (router, specialist, grader,
   rewrite) and compare with sending the same request straight to one agent with both jobs in its
   instructions.
6. **Optional, agents as tools:** give your post agent a read-only `askCalendar` worker (section 5) and
   ask "what's scheduled this week, and is anything missing on LinkedIn?". Compare its `result.usage`
   with the worker's, and see what the post agent's history looks like afterwards.

Record what you found:

| Version | Router correct / 12 | Tokens (3 requests) | Time to answer | Notes |
|---|---|---|---|---|
| Router + specialists | | | | Which requests went to the wrong route? |
| Router on the cheapest model | | — | | Same accuracy? |
| + evaluator, one rewrite | — | | | Was the rewrite actually better? |
| One agent, both jobs | — | | | Was the split worth it? |

From lesson 3 on, every lesson adds eval cases. The router is easy to test with plain code (the expected
route is a single word), so put the 12 requests in an eval file, for example `evals/router.eval.ts`,
following the style of `evals/agent.eval.ts`.

---

## Done when: self-check

- [ ] **Explain the five patterns and when each fits:** prompt chaining, routing, parallel work,
      orchestrator and workers, evaluator and optimizer. For each, give one Creatosaurus example and the
      cost from section 9.
- [ ] **Explain when not to use multiple agents**, with at least three reasons, and what you'd try first
      with a single agent.

Extra checks:

- You have two agents and a chat. Name two ways to route a message, and why routing once per conversation
  is simpler than routing every message.
- What's the difference between parallel work and orchestrator-workers?
- Why can't `deletePost` live inside a subagent, and why is that a good rule anyway?
- A worker agent gives a vague answer. Name two places the problem could be, before blaming the worker's
  model.
- Your orchestrator's `result.usage` says 3,000 tokens, but the bill says much more. Where did the rest go?
- Your evaluator loop sometimes runs five rounds. What's wrong, and what are the two fixes?
- Why pass a post ID to a worker instead of the post?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- Anthropic: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents),
  [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
- AI SDK: [Workflow patterns](https://ai-sdk.dev/docs/agents/workflows),
  [Subagents](https://ai-sdk.dev/docs/agents/subagents),
  [Configuring call options](https://ai-sdk.dev/docs/agents/configuring-call-options)
- Cognition: [Don't Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents),
  [Multi-Agents: What's Actually Working](https://cognition.com/blog/multi-agents-working)
- Claude cookbooks: [agent patterns](https://github.com/anthropics/claude-cookbooks/tree/main/patterns/agents)
- Videos (third-party, not reviewed): [Building with Subagents: Design Decisions](https://www.youtube.com/watch?v=A3DKwLORVe4),
  [Choosing the Right Multi-Agent Architecture](https://www.youtube.com/watch?v=fqvbxkgU6vE)
