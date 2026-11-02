# Lesson 5: Structured output

Notes for lesson 5 of [LEARNING-PATH.md](../LEARNING-PATH.md). The AI SDK details were checked against the
installed `ai@7` (7.0.153) and `@ai-sdk/anthropic` (4.0.88), and Claude's structured outputs against the
Claude Platform docs, on 2026-11-02.

## Watch and read first

| # | Resource | Type | Covers |
|---|---|---|---|
| 1 | [AI SDK: Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) | Read | `output` on `generateText`, the output types, streaming partial objects, errors. **Start here.** |
| 2 | [AI SDK: Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/output) | Read | Every option of `Output.object`, `Output.array`, `Output.choice`, `Output.json` and `Output.text` |
| 3 | [Claude: Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) (Claude Platform Docs) | Read | How Claude constrains its answer to a JSON schema, which schema features are supported, and strict tool use |
| 4 | [AI SDK: Generate Object cookbook](https://ai-sdk.dev/cookbook/node/generate-object) | Hands-on | Optional. A short, runnable example to copy from. |

If you only have time for one: resource 1, up to and including the error handling section.

---

## The core idea

**Code can't read a paragraph. It needs data.** When a person reads the answer, text is fine. When your
code reads the answer, to save it, branch on it or show it in a component, you need a shape you can
trust: fields with known names and types.

You've already seen both sides in this project:

- **The problem:** the assistant used to answer "show my accounts" with a markdown list, and the app
  could do nothing with it except print it.
- **Structured data you already use:** every tool call is structured output. When the model calls
  `postSchedular`, it writes JSON that must match `schedulePostInputSchema` (`accountId`, `caption`,
  `scheduledTime`…), and the SDK validates it with zod before `execute` runs.

This lesson is the same idea for the model's **answer**: instead of free text, ask for an object that
matches a schema, and get it back typed as `result.output`.

---

## 1. Why code needs data, not paragraphs

Compare two answers to "Classify this inbox message":

```
Text:   "This looks like a sales enquiry. They mention pricing for 20 seats, so I'd say
         it's quite likely a lead, maybe 80% sure."

Data:   { "category": "sales lead", "confidence": 0.8, "reason": "Asks for pricing for 20 seats" }
```

With the text you'd have to search for words like "sales", and hope the model phrases it the same way
next time. With the data you write `if (output.category === 'sales lead')`, and TypeScript knows the
field exists.

Structured output is the right tool when:

| Your code needs to… | Example in Creatosaurus |
|---|---|
| **Branch** on the answer | Route an inbox message to sales or support |
| **Save** fields | Store a label and a reason on each inbox thread |
| **Render** it | Show three post ideas as three cards |
| **Pass** it to the next step | A workflow step whose output is another step's input (lesson 4) |

When a person is the only reader, plain text is still the right choice. Your post agent's chat answers
stay text.

## 2. The output types

You pick the shape with the `output` option. Each one returns `result.output` with a matching type:

| Output | `result.output` | Use it for |
|---|---|---|
| `Output.text()` | `string` | The default: plain text, same as `result.text` |
| `Output.choice({ options: [...] })` | One of your strings | Classification into a fixed set: spam, question, praise… |
| `Output.object({ schema })` | An object matching the schema | One record with several fields |
| `Output.array({ element })` | An array of matching elements | A list: three post ideas, the tags for a post |
| `Output.json()` | Any JSON value, unchecked | When you can't define the shape in advance. You validate it yourself. |

```ts
import { generateText, Output } from 'ai';
import { z } from 'zod';

// Choice: the answer is exactly one of the options.
type Category = 'spam' | 'sales lead' | 'question' | 'praise';
const CATEGORIES: Category[] = ['spam', 'sales lead', 'question', 'praise'];

const { output: category } = await generateText({
  model,
  output: Output.choice({ options: CATEGORIES }),
  prompt: `Classify this inbox message:\n<message>${message}</message>`,
});
// category: Category

// Object: one record with typed fields.
const { output: label } = await generateText({
  model,
  output: Output.object({
    schema: z.object({
      category: z.enum(['spam', 'sales lead', 'question', 'praise']),
      reason: z.string(),
    }),
  }),
  prompt: `Classify this inbox message:\n<message>${message}</message>`,
});
// label: { category: 'spam' | 'sales lead' | 'question' | 'praise'; reason: string }

// Array: a list of elements. minItems / maxItems are checked too.
const { output: ideas } = await generateText({
  model,
  output: Output.array({
    element: z.object({ title: z.string(), hook: z.string() }),
    minItems: 3,
    maxItems: 3,
  }),
  prompt: 'Suggest three LinkedIn post ideas about scheduling posts with AI.',
});
```

**Watch out with `Output.choice`:** if you write the options inline,
`Output.choice({ options: ['spam', 'question'] })`, TypeScript widens them to `string[]`, so
`result.output` is typed as plain `string` and the compiler won't catch a typo like `'Spam'`. Pass a typed
array, as above, or the type argument (`Output.choice<Category>({ options: [...] })`) to keep the exact
values. The model is still limited to the options either way; this is only about what TypeScript knows.
(Checked with `tsc` against the installed `ai@7`.)

`generateObject` and `streamObject` still exist in `ai@7`, but they're deprecated: `generateText` with
`output` does the same and also works with tools (section 5).

**Choice or object?** Use `Output.choice` when the label is the whole answer. As soon as you also want a
reason, a score or extracted fields, use `Output.object` with a `z.enum(...)` field for the label.

## 3. Describing fields

The schema isn't only for checking the answer. It's sent to the model as part of the request, so **the
schema is part of the prompt**, exactly like a tool's input schema in lesson 3.

- **Names say what a field is.** `scheduledTime` beats `time`; `reason` beats `r`.
- **`.describe()` says how to fill it in**: the format, the unit, the rules.
- **Enums beat free strings.** `z.enum(['spam', 'question'])` can only produce those values;
  `z.string().describe('spam or question')` can produce "Spam", "spam?" or "probably spam".
- **Keep it shallow.** Every nesting level and optional field is something the model can get wrong.
  Ask for what your code actually reads.

```ts
const inboxLabelSchema = z.object({
  category: z
    .enum(['spam', 'sales lead', 'question', 'praise'])
    .describe('sales lead: they want to buy or ask about pricing. question: they need help using the product.'),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('How sure you are, from 0 to 1. Use below 0.5 when the message fits two categories.'),
  reason: z
    .string()
    .describe('One short sentence quoting the part of the message that decided the category.'),
});
```

**A warning about `confidence`.** The model makes this number up when it writes the answer; it isn't a
measured probability, and models are often confidently wrong. It's still useful for ordering ("review the
lowest-confidence labels first"), but check it against real labels (lesson 17) before using it to make
decisions on its own.

You can also give the output a `name` and `description` (`Output.object({ schema, name: 'inbox_label',
description: '...' })`). Some providers use them as extra guidance.

## 4. When the output doesn't validate

The SDK checks the answer against your schema. When it doesn't fit, reading `result.output` throws
instead of handing you bad data. These are the errors you'll meet, from the installed source:

| Error | When | Typical cause |
|---|---|---|
| `NoObjectGeneratedError` | The answer isn't valid JSON, or doesn't match the schema | A missing field, a wrong type, a value outside your enum, too few array items |
| `NoOutputGeneratedError` | There was no final answer to parse at all | The run ended on tool calls, for example at the `stopWhen` step limit (section 5) |

`NoObjectGeneratedError` carries what you need to debug it: `error.text` (what the model actually wrote),
`error.cause` (the parse or validation error), `error.finishReason` and `error.usage`.

```ts
import { generateText, NoObjectGeneratedError, Output } from 'ai';

try {
  const { output } = await generateText({ model, output: Output.object({ schema: inboxLabelSchema }), prompt });
  return output;
} catch (error) {
  if (NoObjectGeneratedError.isInstance(error)) {
    console.error('[classifier] bad output', {
      finishReason: error.finishReason, // 'length' means it ran out of output tokens mid-JSON
      text: error.text?.slice(0, 300),
      cause: error.cause instanceof Error ? error.cause.message : error.cause,
    });
    return { category: 'question', confidence: 0, reason: 'Could not classify automatically.' };
  }
  throw error;
}
```

What to do about it, in order:

1. **Look at `finishReason`.** `'length'` means the answer was cut off; raise `maxOutputTokens` or ask for
   less. That's a size problem, not a schema problem.
2. **Simplify the schema** if the same field keeps failing: fewer fields, enums instead of strings, less
   nesting.
3. **Retry once** if it's rare, then **fall back** to something safe your code can handle (like the
   "needs a human" label above), and log it. Don't retry forever.
4. **Never trust a value just because it parsed.** A valid `category` can still be the wrong category.
   The schema checks the shape; evals (lesson 17) check the content.

**How Claude helps here.** Claude supports native structured outputs: the API constrains the answer to
your JSON schema while it's being generated, so the JSON shape itself is very reliable. The Anthropic
provider has a `structuredOutputMode` option (`'outputFormat'`, `'jsonTool'` or `'auto'`) for how the
schema is sent. Leave it alone unless you see problems; the error handling above is still needed,
because an answer can still be cut off, or be well-formed and wrong.

## 5. Tools plus structured output

You can use `output` and `tools` together, in `generateText` or on a `ToolLoopAgent`. The model uses tools
as usual, and **only its final answer** is parsed into `result.output`:

```
step 0  tool call   listPosts            (structured tool input)
step 1  tool call   getTrendingTopics    (structured tool input)
step 2  answer      [{ title, hook }, …]  ← parsed with your output schema → result.output
```

Two things to know, both from the installed source:

- **The output is only parsed when the last step is a real answer** (`finishReason` `'stop'`). If the
  loop stops on a tool call, for example because it hit the step limit, there's nothing to parse and
  reading `result.output` throws `NoOutputGeneratedError`. With `generateText`, set `stopWhen` (the
  default is one step), and leave room for the final answer step.
- **Tool results aren't part of the output.** If your code needs the data a tool returned, read it from
  `result.steps` (as `displayParts.ts` does) rather than asking the model to copy it into the output.
  Copying costs tokens and can introduce mistakes.

```ts
const ideaAgent = new ToolLoopAgent({
  model,
  instructions: 'Suggest post ideas for this week that do not repeat what is already scheduled.',
  tools: { currentTime, listPosts },
  toolsContext: { listPosts: identity },
  output: Output.array({
    element: z.object({ title: z.string(), hook: z.string(), why: z.string() }),
    minItems: 3,
    maxItems: 3,
  }),
});

const result = await ideaAgent.generate({ prompt: 'Ideas for this week' });
result.output; // [{ title, hook, why }, …] — typed
```

**Streaming** structured output is covered in lesson 7: `streamText` with `output` gives you
`partialOutputStream` (the object filling in as it arrives) and, for arrays, `elementStream` (each
element once it's complete).

---

## AI SDK in this lesson

| API | What it does |
|---|---|
| `generateText({ output })` | Asks for a structured answer; the result is typed |
| `Output.choice({ options })` | Exactly one of the given strings |
| `Output.object({ schema, name?, description? })` | One object matching the schema |
| `Output.array({ element, minItems?, maxItems? })` | An array of matching elements, with optional length limits |
| `Output.json()` | Any JSON, not checked against a schema |
| `Output.text()` | Plain text, the default |
| `result.output` | The parsed, typed answer. Throws if there isn't one. |
| `NoObjectGeneratedError` | The answer didn't parse or didn't match the schema. Has `text`, `cause`, `finishReason`, `usage`. |
| `NoOutputGeneratedError` | No final answer to parse, for example the run ended on a tool call |
| `new ToolLoopAgent({ ..., output })` | An agent whose final answer is structured |
| `partialOutputStream`, `elementStream` | Streaming versions (lesson 7) |
| `generateObject`, `streamObject` | Deprecated. Use `generateText` / `streamText` with `output`. |

---

## Build: inbox message classifier

Creatosaurus has an inbox, so this exercise is real: sort incoming comments and messages so people see
sales leads and questions first. Use made-up messages for now; don't copy customer messages into files.

1. **Write 12 test messages** in `src/lessons/05-inbox-messages.ts`, each with the label you expect: three
   per category, plus a few hard ones (a complaint that's also a question, praise with a pricing question,
   a link-only spam comment, a message in Hindi).
2. **Version 1, choice:** `src/lessons/05-classify.ts` classifies every message with
   `Output.choice(['spam', 'sales lead', 'question', 'praise'])` and prints expected vs actual.
3. **Version 2, object:** switch to `Output.object` returning `{ category, confidence, reason }` with the
   descriptions from section 3. Print the reason next to each wrong answer.
4. **Break it on purpose:** set `maxOutputTokens: 10` and see the error you get. Then add the
   `NoObjectGeneratedError` handling from section 4 with a safe fallback.
5. **Batch version (optional):** classify all 12 in one call with `Output.array`, and compare the tokens
   and accuracy with 12 separate calls.

Record what you found:

| Version | Correct / 12 | Tokens (total) | Notes |
|---|---|---|---|
| Choice | | | |
| Object | | | Did the reasons explain the mistakes? |
| Object, batch of 12 | | | |

Was a wrong answer's `confidence` lower than a right answer's? Write down what you saw; that's your first
look at whether the number means anything.

---

## Done when: self-check

- [ ] **Choose the right output type for a task:** for each of these, say which one and why: "is this
      comment spam?", "extract the date and platform from this request", "suggest 5 hashtags", "summarize
      this thread for a person".
- [ ] **Know what to do when output fails validation:** name the two errors, what each means, and your
      order of fixes (finish reason, schema, retry, fallback).

Extra checks:

- Why is a zod schema with `.describe()` part of the prompt, and not just a check after the answer?
- Your agent has tools and `Output.object`, and `result.output` throws `NoOutputGeneratedError`. What
  probably happened, and how do you confirm it from `result.steps`?
- Why not ask the model to copy a tool's result into the structured output, and what do you do instead?
- When is `Output.json()` the right choice, and what must your code do that `Output.object` would have
  done for you?
- The classifier says `confidence: 0.95` and is wrong. What does that tell you about the field?

## My notes

<!-- Your own notes, questions and suggestions for improving these notes. -->

---

## References

- AI SDK: [Generating Structured Data](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data),
  [Output reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/output),
  [Generate Object cookbook](https://ai-sdk.dev/cookbook/node/generate-object)
- Claude: [Structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
