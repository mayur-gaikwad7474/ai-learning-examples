# Lesson 1: How LLMs work

Notes for lesson 1 of [LEARNING-PATH.md](../LEARNING-PATH.md). Model facts (prices, limits, cutoffs) were
checked against Anthropic's docs on 2026-10-25. They change, so recheck the links at the end before
relying on a number.

## Watch first

Watch in this order. The first two cover most of the lesson; the rest go deeper on specific items.

| # | Video | Length | Covers |
|---|---|---|---|
| 1 | [Large Language Models explained briefly](https://www.youtube.com/watch?v=LPZh9BOjkQs) (3Blue1Brown) | ~8 min | Next-token prediction, training, why outputs are probabilistic |
| 2 | [Intro to Large Language Models](https://www.youtube.com/watch?v=zjkBMFhNj_g) (Andrej Karpathy) | ~1 h | What a model is, pretraining vs fine-tuning, hallucination, tools, security |
| 3 | [Deep Dive into LLMs like ChatGPT](https://www.youtube.com/watch?v=7xTGNNLPyMI) (Andrej Karpathy) | ~3.5 h | Tokens, the full training pipeline, hallucination, reasoning models. Watch in parts. |
| 4 | [Let's build the GPT Tokenizer](https://www.youtube.com/watch?v=zduSFxRajkE) (Andrej Karpathy) | ~2 h | Optional. Exactly how text becomes tokens, and the odd behavior that causes. |
| 5 | [Transformers, the tech behind LLMs](https://www.youtube.com/watch?v=wjZofJX0v4M) (3Blue1Brown) | ~27 min | Optional. Inside the model; useful context, not needed to build apps. |

If you only have time for one: video 2. If you have a weekend: video 3, which covers every Learn item
below except model choice.

---

## The core idea

An LLM is a function that takes a sequence of tokens and returns a probability for every possible next
token. Generating text is a loop: pick a token from that distribution, append it, run the model again.

```
"The weather in Pune is"  →  model  →  { " sunny": 0.31, " hot": 0.22, " clear": 0.12, ... }
                                          pick " sunny", append, run again
```

Everything else in this lesson follows from that loop:

- It produces **plausible** text, not verified text → hallucination.
- It only knows what was in its training data → knowledge cutoff.
- It generates one token at a time → output tokens are slow and expensive.
- It has no memory between calls; you send everything every time → context windows and input tokens.

How a model is made, briefly:

1. **Pretraining**: predict the next token on a huge slice of the internet and books. The result is a
   document completer that knows a lot but doesn't follow instructions.
2. **Post-training** (fine-tuning, RLHF, RL on tasks): trains it to act as an assistant, follow
   instructions, use tools, refuse harmful requests and reason through problems.

---

## 1. Tokens, and how they drive cost and speed

A token is a chunk of text: often a word, part of a word, a space-plus-word, or punctuation. The model
never sees characters, only token IDs.

- Rough size on Claude's current tokenizer: **1M tokens ≈ 555k English words ≈ 2.5M characters**
  (from Anthropic's context window docs). Code, non-English text and unusual strings use more tokens.
- Tokenizers differ between model families, so the same text can be a different token count on another
  model. Count with the provider's API, not a generic library.
- Odd model behavior often traces back to tokens: miscounting letters in a word, struggling with
  reversed strings, or treating `" Pune"` and `"Pune"` differently.

**Why tokens are the unit that matters:** you're billed per token, limits are in tokens, and generation
speed is measured in tokens per second.

## 2. Context windows

The context window is the maximum number of tokens the model can handle in one call: **input and
output combined.**

- All current Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5): **1M-token context, 128K max output.**
- Everything you send counts: system prompt, tool definitions, message history, tool results, images.
- Bigger isn't free. You pay for every input token on every call, and quality drops in very long
  contexts ("context rot", lesson 10). A full context is usually a design smell.

**In this project:** the weather agent sends the instructions, the `getWeather` schema and the question.
In step 2 of the loop it sends all of that again, plus the tool call and the tool result. Input grows
with every step of an agent loop.

## 3. Input vs output tokens

| | Input tokens | Output tokens |
|---|---|---|
| What | Everything you send | Everything the model generates, **including thinking tokens** |
| How processed | All at once, in parallel ("prefill") | One at a time; each needs a full model pass ("decode") |
| Speed impact | Mostly affects time to first token | Dominates total response time |
| Price (Opus 5.5) | $4 per million | $20 per million (5× input) |

**Why output drives cost and latency:**

- *Latency:* input tokens are processed together in one pass. Output tokens are generated one after
  another, each waiting for the last. 1,000 output tokens means about 1,000 sequential steps.
- *Cost:* output costs 5× more per token on every current Claude model, because each one needs its own
  pass through the model.
- *Hidden output:* reasoning models "think" before answering, and **thinking tokens are billed as
  output** even if you never see them.

**Worked example** (made-up numbers, Opus 5.5 prices):

```
1,000 input tokens  × $4  / 1M = $0.0040
  300 output tokens × $20 / 1M = $0.0060   ← 23% of the tokens, 60% of the cost
                                 -------
                                 $0.0100 per question
```

Levers: shorter answers, lower effort, fewer agent steps, a smaller model, and caching for repeated
input (lesson 18).

## 4. Why models hallucinate

A hallucination is a confident, fluent answer that's wrong. The model is trained to produce *likely*
text, and a likely-sounding wrong answer scores fine on that objective.

Common causes:

- **Missing knowledge:** rare facts, private data, anything after the cutoff. The model fills the gap
  with plausible text.
- **Pressure to answer:** post-training rewards helpfulness. Unless told otherwise, the model prefers an
  answer to "I don't know".
- **Lossy memory:** facts are compressed into weights, not stored like a database. Similar facts blur
  together (dates, version numbers, citations, API names).
- **Long or messy context:** relevant information is present but missed or mixed up.

Ways to reduce it:

1. **Ground it with tools or retrieval.** Give it the real data and tell it to use only that. The
   weather agent's instructions already do this: *"Use the getWeather tool... Never guess the numbers."*
2. **Allow "I don't know".** Say explicitly that it's fine to say the answer isn't known or isn't in
   the data.
3. **Ask for quotes or citations** from the provided source, and check them in code where possible.
4. **Constrain the output** with structured output and validation (lesson 5).
5. **Measure it** with evals that check answers against tool results (lessons 3 and 17).

You can reduce hallucination but not eliminate it. Design for wrong answers (lessons 12, 13, 30).

## 5. Knowledge cutoff

The model knows nothing after its training data ends.

- Current Claude models (Opus 5.5, Sonnet 5.5, Haiku 5.5): **reliable knowledge cutoff June 2026.**
- Anything later (prices, releases, news, library versions, today's weather) must come from a tool,
  retrieval or the prompt.
- The model doesn't know today's date unless you tell it. Put the date in the system prompt when time
  matters.

This is why the weather agent needs `getWeather`: the model can't know current weather however good
it is.

## 6. Reasoning models and effort

A reasoning model generates hidden "thinking" tokens before its final answer: planning, checking and
backtracking. This substantially improves results on maths, coding, multi-step agent work and tricky
instructions.

How it works on current Claude models:

- **Adaptive thinking:** the model decides how much to think per request. On Opus 5.5 thinking is always
  on and can't be disabled.
- **Effort** steers how much it thinks and how thorough it is overall: `low`, `medium`, `high`, `xhigh`,
  `max`.

| Model | Default effort |
|---|---|
| Opus 5.5 | `medium` |
| Sonnet 5.5 | `high` |
| Haiku 5.5 | `medium` |

- Higher effort means more thinking tokens, so more cost and latency, and usually better answers on
  hard tasks.
- Lower effort suits chat, classification, extraction and simple tool calls, where extra thinking adds
  cost but little quality.
- Thinking tokens are billed as output tokens. The raw reasoning isn't returned by default, so check
  `usage.outputTokenDetails.reasoningTokens` to see the cost.
- The older "thinking budget" (`budget_tokens`) API is rejected on current models. Effort replaces it.

In the AI SDK, set effort through provider options on the agent (`agent.generate()` doesn't accept
them):

```ts
export const weatherAgent = new ToolLoopAgent({
  model,
  instructions: '...',
  tools: { getWeather },
  providerOptions: { anthropic: { effort: 'low' } },
});
```

## 7. Choosing a model by quality, speed and cost

| Model | Best for | Latency | Input / output per 1M tokens |
|---|---|---|---|
| Opus 5.5 (`claude-opus-5-5`) | Long-running agentic coding and knowledge work; the default starting point | Moderate | $4 / $20 |
| Sonnet 5.5 (`claude-sonnet-5-5`) | Best balance of speed and intelligence | Fast | $2 / $10 |
| Haiku 5.5 (`claude-haiku-5-5`) | High-volume, latency-sensitive work: classification, extraction, routing | Fastest | $0.10 / $0.50 (prompts up to 100K tokens; $0.50 / $2.50 beyond) |

Batch API requests are 50% off for work that doesn't need an immediate answer.

A process that works:

1. **Define "good" first:** a handful of real test cases with expected outcomes.
2. **Start with a capable model** to see what quality is possible.
3. **Try cheaper models or lower effort** on the same cases. Keep the cheapest one that still passes.
4. **Judge cost per completed task**, not per request. A cheap model that needs retries or extra agent
   steps may cost more.
5. **Decide per task, not per app.** A router or classifier can run on Haiku while the main agent runs
   on Opus.

Also try the strong model at lower effort before switching to a smaller model. It's often the better
trade-off.

---

## AI SDK: what to read from a result

| Field | What it tells you |
|---|---|
| `result.usage.inputTokens` / `outputTokens` / `totalTokens` | Tokens across **all** steps of the agent run |
| `result.usage.outputTokenDetails.reasoningTokens` | Thinking tokens (billed as output) |
| `result.usage.inputTokenDetails.cacheReadTokens` | Input served from cache (cheaper; lesson 18) |
| `result.finishReason` | Why the final step stopped: `'stop'`, `'length'`, `'tool-calls'`, `'content-filter'`, `'error'`, `'interrupted'`, `'other'` |
| `result.steps[i].usage` | Tokens for one step; watch input grow from step to step |
| `result.steps[i].performance.responseTimeMs` | Time spent waiting for the model in that step |
| `result.response.modelId` | Which model actually answered |

`finishReason: 'length'` means the output hit the token limit and was cut off. Treat it as a failure,
not an answer.

Note: [src/main.ts](../src/main.ts) prints `result.totalUsage`, which is deprecated in `ai@7`.
`result.usage` now holds the total across all steps.

---

## Build: compare three models

The exercise: run the weather agent on Opus, Sonnet and Haiku and compare tokens, time and answers.

1. Extend `main.ts` (or write `src/lessons/01-compare.ts`) to print the model ID, input tokens, output
   tokens, reasoning tokens, `finishReason`, total time and estimated cost.
2. Run the same question on each model:

   ```bash
   AI_MODEL=anthropic:claude-opus-5-5   npm start -- "What's the weather in Pune?"
   AI_MODEL=anthropic:claude-sonnet-5-5 npm start -- "What's the weather in Pune?"
   AI_MODEL=anthropic:claude-haiku-5-5  npm start -- "What's the weather in Pune?"
   ```

3. Repeat with a harder question, such as *"Compare the weather in Pune, Mumbai and Delhi and tell me
   where to go for a walk."* Then try `effort: 'low'` vs `'high'` on one model. Reading it from an
   environment variable, like `AI_MODEL`, saves editing code between runs.
4. Run each one 2–3 times. Answers and token counts vary between runs, so one run isn't a comparison.
5. Record the results below.

| Model | Effort | Question | Input | Output | Reasoning | Time | Cost | Answer OK? |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

---

## Done when: self-check

Answer these in your own words, out loud or written below, before ticking lesson 1.

- [ ] **Why do output tokens drive cost and latency?** Hint: sequential decode vs parallel prefill; 5×
      price; thinking counts as output.
- [ ] **What is hallucination, and two ways to reduce it?** Hint: plausible ≠ true; grounding with
      tools, allowing "I don't know", citations, evals.
- [ ] **Pick a model for a task and justify it.** For example: classifying 100k inbox messages a day vs
      planning a multi-step social media campaign. Use your comparison table as evidence.

Extra checks:

- Why does step 2 of the weather agent use more input tokens than step 1?
- What happens if you ask the agent about an event from August 2026 without a tool?
- What does `finishReason: 'length'` mean, and what would you do about it?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- Anthropic: [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview),
  [Choosing a model](https://platform.claude.com/docs/en/about-claude/models/choosing-a-model),
  [Pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- Anthropic: [Context windows](https://platform.claude.com/docs/en/build-with-claude/context-windows),
  [Token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting),
  [Effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- Anthropic: [Reduce hallucinations](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations)
- AI SDK: [Generating text](https://ai-sdk.dev/docs/ai-sdk-core/generating-text)
