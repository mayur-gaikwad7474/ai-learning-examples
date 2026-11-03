// An eval: send the agent a real question, then check what it did with plain code.
//
//   npm run eval                       run every case once
//   npm run eval -- accounts posts     run only the cases whose name contains "accounts" or "posts"
//   EVAL_REPEAT=3 npm run eval         run each case 3 times, to see which ones pass only sometimes
//
// It calls the real model (uses API credits) and the real local services, so connection-service and
// post-scheduler-service must be running.
//
// Each case says which tools the agent must call and which it must never call. We check tools, not
// the exact wording of the answer, because the wording changes on every run while the right tool
// choice should not. Read the printed answers yourself too: no code here checks that they are true.
import assert from 'node:assert/strict';
import {
  createPostAgent,
  type PostAgentTools,
} from '../src/agents/postScheduler.agent.ts';
import type { Identity } from '../src/schemas/identity.schema.ts';

// The keys in postScheduler.agent.ts. A misspelled tool name in a case is a type error, instead of a
// check that silently never fails.
type ToolName = keyof PostAgentTools;

// Tools that change real data. These evals run against real services, so every case forbids them,
// and a case that requires one is refused before anything runs. Lesson 17 swaps in fake tools so
// scheduling and editing can be tested too.
const WRITE_TOOLS: ToolName[] = ['postSchedular', 'editPost'];

// Who the agent acts as. The tools send this to the services, the same way the gateway would.
const identity: Identity = {
  userId: process.env.EVAL_USER_ID ?? '',
  workspaceId: process.env.EVAL_WORKSPACE_ID ?? '',
  roles: ['admin'],
};

if (!identity.userId || !identity.workspaceId) {
  console.error('Set EVAL_USER_ID and EVAL_WORKSPACE_ID in .env first.');
  process.exit(1);
}

// What one run of the agent did, handed to a case's `check`.
type Run = {
  toolNames: string[]; // every tool called, in order, across all steps of the loop
  calls: { toolName: string; input: unknown }[]; // the same calls with the arguments the model chose
  text: string; // the final answer
};

type EvalCase = {
  name: string; // short and unique, used to pick cases from the command line
  prompt: string;
  mustCall?: ToolName[]; // have to appear
  mustNotCall?: ToolName[]; // must never appear, on top of WRITE_TOOLS
  noTools?: boolean; // the agent must answer without calling any tool
  check?: (run: Run) => void; // extra asserts, such as tool arguments or call order
};

const cases: EvalCase[] = [
  {
    name: 'accounts',
    prompt: 'Which accounts do I have connected?',
    mustCall: ['accountList'],
  },
  {
    name: 'caption-feedback',
    prompt: 'What do you think of my captions?',
  },
  {
    // No account given: it should show the accounts and ask which one, never pick one itself.
    name: 'schedule-missing-account',
    prompt: 'Schedule a post for tomorrow at 10am with the caption "Hello world!"',
    mustCall: ['accountList'],
  },
  {
    name: 'posts-last-week',
    prompt: 'Show me my posts from last week',
    mustCall: ['currentTime', 'listPosts'],
    check: ({ toolNames, calls }) => {
      // The instructions say to get the current time before working out any date.
      assert.ok(
        toolNames.indexOf('currentTime') < toolNames.indexOf('listPosts'),
        'expected currentTime before listPosts',
      );
      const { from, to } = calls.find((call) => call.toolName === 'listPosts')!
        .input as { from: string; to: string };
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
      assert.ok(
        days >= 6 && days <= 8,
        `expected about a 7-day range, got ${days.toFixed(1)} days (${from} to ${to})`,
      );
      assert.ok(Date.parse(from) < Date.now(), `expected the range to start in the past, got ${from}`);
    },
  },
  {
    // Nothing says what to change: it should ask, not edit.
    name: 'edit-missing-detail',
    prompt: 'Edit my latest post',
  },
  {
    name: 'greeting',
    prompt: 'Hello how are you?',
    noTools: true,
  },
];

for (const test of cases) {
  const writes = (test.mustCall ?? []).filter((name) => WRITE_TOOLS.includes(name));
  if (writes.length > 0) {
    console.error(
      `Case "${test.name}" requires ${writes.join(', ')}, which would change real data. Remove it until lesson 17.`,
    );
    process.exit(1);
  }
}

const filters = process.argv.slice(2);
const selected =
  filters.length > 0
    ? cases.filter((test) => filters.some((filter) => test.name.includes(filter)))
    : cases;
const repeat = Math.max(1, Number(process.env.EVAL_REPEAT ?? 1));

if (selected.length === 0) {
  console.error(`No case name contains: ${filters.join(', ')}`);
  process.exit(1);
}

const runCase = async (test: EvalCase) => {
  const startedAt = Date.now();
  const result = await createPostAgent(identity).generate({ prompt: test.prompt });

  const calls = result.steps.flatMap((step) =>
    step.toolCalls.map((call) => ({ toolName: call.toolName, input: call.input })),
  );
  const run: Run = {
    toolNames: calls.map((call) => call.toolName),
    calls,
    text: result.text,
  };

  console.log('Tools called:', run.toolNames);
  console.log('Final answer:', run.text);

  for (const name of test.mustCall ?? []) {
    assert.ok(run.toolNames.includes(name), `expected "${name}" to be called`);
  }
  for (const name of [...WRITE_TOOLS, ...(test.mustNotCall ?? [])]) {
    assert.ok(!run.toolNames.includes(name), `"${name}" must not be called`);
  }
  if (test.noTools) {
    assert.deepEqual(run.toolNames, [], 'expected no tool calls');
  }
  assert.ok(run.text.trim().length > 0, 'expected a final answer');
  test.check?.(run);

  return {
    toolNames: run.toolNames,
    tokens: result.usage.totalTokens ?? 0,
    ms: Date.now() - startedAt,
  };
};

const summary = [];
let passedRuns = 0;

for (const test of selected) {
  let passed = 0;
  let tokens = 0;
  let ms = 0;
  let lastTools: string[] = [];

  for (let attempt = 1; attempt <= repeat; attempt++) {
    console.log(`\n=== ${test.name} (run ${attempt}/${repeat}): ${test.prompt}`);
    try {
      const outcome = await runCase(test);
      passed++;
      tokens += outcome.tokens;
      ms += outcome.ms;
      lastTools = outcome.toolNames;
      console.log('PASS');
    } catch (error) {
      console.error('FAIL:', error instanceof Error ? error.message : error);
    }
  }

  passedRuns += passed;
  summary.push({
    case: test.name,
    passed: `${passed}/${repeat}`,
    tools: lastTools.join(', ') || '(none)',
    // Averages over the passing runs only.
    'avg tokens': passed > 0 ? Math.round(tokens / passed) : '-',
    'avg seconds': passed > 0 ? (ms / passed / 1000).toFixed(1) : '-',
  });
}

const totalRuns = selected.length * repeat;
console.log(`\nModel: ${process.env.AI_MODEL ?? 'default'}`);
console.table(summary);
console.log(`${passedRuns}/${totalRuns} runs passed`);
// A nonzero exit code tells a script or CI that something failed.
process.exitCode = passedRuns === totalRuns ? 0 : 1;
