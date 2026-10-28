# ai-service (learning project)

A small project to learn AI agents step by step with the Vercel AI SDK, using Claude.
The lessons are in [LEARNING-PATH.md](LEARNING-PATH.md).

## Setup

```bash
npm install
cp .env.example .env      # paste your ANTHROPIC_API_KEY
npm start -- "What's the weather in Pune?"
```

## Switching models

Change `AI_MODEL` in `.env`, written as `provider:model`:

```
AI_MODEL=anthropic:claude-opus-5-5     # most capable
AI_MODEL=anthropic:claude-sonnet-5-5   # balanced
AI_MODEL=anthropic:claude-haiku-5-5    # fastest, cheapest
```

Or try a model for one run:

```bash
AI_MODEL=anthropic:claude-haiku-5-5 npm start -- "Weather in Paris?"
```

To add another company (OpenAI, Google and others), install its provider package, add it in `src/model.ts`,
put its key in `.env`, and use `AI_MODEL=<provider>:<model>`.

## Read the files in this order

| Step | File | Concept |
|---|---|---|
| 1 | `src/model.ts` | The model: which AI we talk to |
| 2 | `src/tools/weather.ts` | A tool: a function the AI can call |
| 3 | `src/agents/weather-agent.ts` | An agent: model + instructions + tools in a loop |
| 4 | `src/main.ts` | Running the agent and watching each step |

## Things to try

- `npm start -- "Weather in Paris?"`: one tool call, then an answer
- `npm start -- "Compare Mumbai and Delhi"`: two tool calls
- `npm start -- "Is it hot today?"`: no city, so the agent should ask
- `npm start -- "Weather in Xyzzy?"`: the tool returns an error and the agent explains it
- Run the same question with Opus, Sonnet and Haiku and compare the answers
- Change the instructions in `weather-agent.ts` and see how the answers change
# ai-learning-examples
