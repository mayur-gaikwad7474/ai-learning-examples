# Lesson 2: Prompts and messages

Notes for lesson 2 of [LEARNING-PATH.md](../LEARNING-PATH.md). Prompting guidance was checked against
Anthropic's docs, and the AI SDK details against the installed `ai@7`, on 2026-10-26.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [Prompting 101](https://www.youtube.com/watch?v=ysPbXH0LpIE) (Anthropic, Code w/ Claude) | Video | Building a real prompt step by step: task, context, examples, output format. **Start here.** |
| 2 | [AI prompt engineering: A deep dive](https://www.youtube.com/watch?v=T9aRN5JkmL8) (Anthropic) | Video | Anthropic's prompt engineers on how they think about prompts: clarity, examples, iteration, honesty |
| 3 | [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices) (Anthropic docs) | Read | The reference for current Claude models. Read "General principles" and "Output and formatting". |
| 4 | [AI SDK: Prompts](https://ai-sdk.dev/docs/foundations/prompts) | Read | `instructions`, `prompt` vs `messages`, roles and content parts |
| 5 | [Prompt engineering interactive tutorial](https://github.com/anthropics/prompt-eng-interactive-tutorial) (Anthropic, GitHub) | Hands-on | Optional. Notebook exercises, one technique per chapter. |

If you only have time for one: video 1, then the "General principles" section of resource 3.

---

## The core idea

The model knows nothing about your task except what's in the request. A prompt is the whole briefing:
who it is, what to do, what good looks like, and the input to work on. Most bad output comes from a
briefing that was missing something, not from a weak model.

Anthropic's mental model: **treat Claude as a brilliant new employee who has no context on your
business.** The test: if a colleague with no background couldn't follow your prompt, the model won't
either.

---

## 1. Roles

Every message has a role. The roles tell the model who said what and how much authority it has.

| Role | Who writes it | What it's for | Example |
|---|---|---|---|
| **system** | You (the developer) | Standing instructions: role, rules, format, context. Highest authority. | "You write Instagram captions for small Indian brands." |
| **user** | The end user (or your code on their behalf) | The request or input for this turn | "Caption for a photo of our new mango cheesecake" |
| **assistant** | The model | Its previous replies, sent back as history | "Summer just got sweeter 🥭..." |
| **tool** | Your code | The result of a tool the model asked to run (lesson 3) | `{ "temperatureC": 26.3 }` |

Points worth knowing:

- **System content isn't a message in the Claude API.** It's a separate top-level `system` field. The AI
  SDK takes it as `instructions` and sends it there for you.
- **The Claude API only has `user` and `assistant` in `messages`.** Tool results travel inside a `user`
  message. The AI SDK's `tool` role is an abstraction that it converts for each provider.
- **Authority matters for security.** System instructions come from you; user content can come from
  anyone. Never put untrusted text in the system prompt (lessons 12 and 20). For the same reason, the AI
  SDK rejects `system` messages inside `messages` unless you set `allowSystemInMessages: true`.

## 2. Single prompt vs message history

The model is **stateless**: every call starts from zero. "Memory" is just you sending the earlier
messages again.

| | Single prompt | Message history |
|---|---|---|
| AI SDK | `prompt: '...'` | `messages: [...]` |
| Sends | One user message | The whole conversation so far |
| Use for | One-off tasks: write a caption, classify a message, summarize a post | Chat, follow-ups ("make it shorter"), agent loops |
| Cost | Fixed per call | Grows every turn, because every earlier message is resent as input |

```ts
// Single prompt: one task, no history
await generateText({ model, instructions, prompt: 'Caption for: mango cheesecake launch' });

// Message history: the model sees the earlier turns, so "shorter" makes sense
await generateText({
  model,
  instructions,
  messages: [
    { role: 'user', content: 'Caption for: mango cheesecake launch' },
    { role: 'assistant', content: 'Summer just got sweeter 🥭 Our new mango cheesecake...' },
    { role: 'user', content: 'Make it shorter and add a call to action' },
  ],
});
```

Connection to lesson 1: this is why input tokens grow in the weather agent's loop. Each step sends the
history again. Lesson 8 builds full conversation threads on top of this.

**No prefill on current models.** Older guides suggest ending `messages` with a partial `assistant`
message (for example `{`) to force a format. Current Claude models reject that with an error. Use clear
format instructions now, or structured output (lesson 5).

## 3. Writing clear instructions

The techniques that matter most, from Anthropic's best-practices guide:

1. **Be explicit about what you want.** Current models follow instructions precisely and don't guess at
   extras. If you want something beyond the minimum, ask for it.
   - Weak: `Write a caption for this product.`
   - Strong: `Write an Instagram caption for this product: a hook in the first line, 2–3 short lines
     about the benefit, a call to action, then 5 relevant hashtags.`
2. **Give the reason, not just the rule.** The model generalizes from the "why".
   - Weak: `NEVER use more than 5 hashtags.`
   - Strong: `Use at most 5 hashtags. More looks spammy to our audience and lowers engagement.`
3. **Say what to do, not what to avoid.** "Write in short, plain sentences" works better than "don't be
   wordy".
4. **Give context.** Who is the audience? What is the brand voice? Where will the output appear? The
   output can only be as specific as the context.
5. **Separate the parts with XML tags.** When a prompt mixes instructions, context, examples and input,
   wrap each in its own tag (`<brand>`, `<examples>`, `<post>`) so nothing gets mixed up. Tag names are
   up to you; just keep them consistent.
6. **Use numbered steps** when order or completeness matters.
7. **Give it a role.** Even one sentence of role in the system prompt focuses the tone and expertise.
8. **Match the prompt's style to the output you want.** A prompt full of markdown tends to get markdown
   back.

Avoid **shouting** (`MUST`, `NEVER`, all caps) as a habit. Current models already follow instructions
closely, and heavy emphasis can make them over-apply a rule. Use a calm sentence with a reason, and
emphasize only if testing shows a rule is being missed.

On current Claude models, sampling settings like `temperature` are rejected, so you can't turn
randomness down to get consistent output. Consistency comes from clear instructions, examples and
(lesson 5) structured output.

## 4. Few-shot examples

Examples are the most reliable way to control format, tone and length. Showing beats describing,
especially for "voice", which is hard to put into words.

Make examples:

- **Relevant:** close to the real inputs.
- **Diverse:** different products and lengths, plus an edge case. If all your examples start with an
  emoji, every output will too.
- **Clearly marked:** wrap each in `<example>`, and the set in `<examples>`, so they aren't mistaken for
  instructions or input.
- **3–5 of them** is Anthropic's recommended starting point.

```text
<examples>
<example>
<post>Photo of our cold brew in a glass bottle, morning light</post>
<caption>Your 7 a.m. self called. It wants this. ☕
Slow-steeped for 18 hours, smooth enough to skip the sugar.
Order on our site, link in bio.
#coldbrew #puneCafe #coffeelover #morningritual #smallbatch</caption>
</example>
...
</examples>
```

Two places examples can go:

- **In the system prompt** inside `<examples>`. This is the simplest option and works for most cases.
- **As fake history:** pairs of `user`/`assistant` messages before the real input. This is useful when
  you want the model to treat the examples as its own earlier replies.

Watch out: the model copies everything about your examples, including the quirks you didn't intend
(same length, same opening word, same emoji). Vary them on purpose.

## 5. Treating prompts like code

A prompt is part of your program's logic. Changing one word can change behavior as much as changing a
line of code.

- **Keep it in the repo**, in a named constant or file, not scattered through inline strings.
- **Separate the fixed template from variable input.** The instructions stay the same; the user's input
  goes in its own tagged slot. This makes prompts testable, cacheable (lesson 18) and safer against
  injection (lesson 12).
- **Version it**, for example `CAPTION_PROMPT_V3`. Commit each change with a note on why.
- **Test it on fixed inputs.** Keep 5–10 real inputs and run every version on the same set, so you're
  comparing prompts and not inputs.
- **Change one thing at a time**, so you know what caused the difference.
- **Read the outputs**, not just "it ran". Lesson 17 turns this into automated evals.

```ts
// src/lessons/02-first-call.ts (shape only)
const CAPTION_PROMPT_V2 = `You write Instagram captions for ...

<brand>
...
</brand>

<examples>
...
</examples>`;

const result = await generateText({
  model,
  instructions: CAPTION_PROMPT_V2,
  prompt: `<post>${postDescription}</post>`,
});
console.log(result.text);
```

---

## AI SDK in this lesson

| Option / field | What it does |
|---|---|
| `instructions` | The system prompt. In `ai@7`, `system` still works but is deprecated in favor of `instructions`. |
| `prompt` | A string (one user message) or a message array |
| `messages` | Full history as `ModelMessage[]`. Use either `prompt` or `messages`, not both. |
| `allowSystemInMessages` | Allows `system` messages inside `messages`. Off by default, because it's an injection risk. |
| `result.text` | The final text the model returned |

Note: `ToolLoopAgent` uses the same `instructions` name, as in
[weather-agent.ts](../src/agents/weather-agent.ts).

---

## Build: Instagram caption writer

The exercise: `src/lessons/02-first-call.ts`, an Instagram caption writer with no tools. Improve its
instructions three times and compare.

1. **Pick 5 fixed test inputs**: real-sounding post descriptions with different kinds of products. Add at
   least one tricky one (a vague description, a sensitive topic, or a non-English brand name).
2. **v0, the naive prompt:** `Write an Instagram caption for: ...`. Run all 5 and save the outputs.
3. **v1, clear instructions:** add a role, audience, structure (hook, body, call to action, hashtags),
   length and the reasons behind each rule.
4. **v2, add context and examples:** a short `<brand>` block (voice, words to use and avoid), plus 3
   varied `<example>` captions.
5. **v3, fix what you saw:** read the v2 outputs, find the most common problem, and fix only that.
6. **Run each version 2–3 times.** Outputs vary between runs; you're looking for consistency, not one
   lucky caption.

Record what you found:

| Version | What changed | Typical problem | Consistent across runs? | Output tokens |
|---|---|---|---|---|
| v0 | Naive prompt | | | |
| v1 | | | | |
| v2 | | | | |
| v3 | | | | |

Haiku 5.5 is a sensible model for this. Captions are short and simple, which makes it a good test of
whether your prompt carries the quality instead of the model.

---

## Done when: self-check

- [ ] **What is each role for?** Explain system, user, assistant and tool, and why system content needs
      more trust than user content.
- [ ] **Turn a vague prompt into one that gives consistent results.** Show your v0 and v3 side by side
      and explain which change made the biggest difference.

Extra checks:

- Why does a 10-turn chat cost more per turn than the first turn?
- When would you put examples in the system prompt, and when would you use fake message history?
- Your v3 prompt gives great captions, but every one starts with an emoji. What happened, and how do you
  fix it?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- Anthropic: [Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices),
  [Prompt engineering overview](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/overview),
  [System prompts](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/system-prompts),
  [Multishot prompting](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/multishot-prompting)
- Anthropic: [Prompt generator](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompt-generator),
  for a first draft of a prompt to then improve
- AI SDK: [Prompts](https://ai-sdk.dev/docs/foundations/prompts),
  [generateText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)
