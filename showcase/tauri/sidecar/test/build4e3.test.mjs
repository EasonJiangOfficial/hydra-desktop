// Desktop build 4 E3, compaction like a normal LLM chat (owner: "yeah you should compact the chat just like If I were
// talking to an actuall llm"). Every request sent ~775K tokens, ~650K of them a fixed floor (connector schemas) no fold
// can cut, and the fold gate compared that whole prompt to a chat budget, so it skipped on every request.
// - the fold gate is on the chat alone (Claude Code's getContextUsage 'messages' row), at 90K, never on the prompt;
// - planFold scales our estimate to the measured chat, keeps the last 2 requests and 20K verbatim, cuts at a request
//   never right after a question, and folds the oldest slice first past a cap;
// - connector schemas wait behind ToolSearch (sidecar and server brain), ours stay loaded;
// - jsonOf parses the first balanced object; the fixed floor is logged once per process.
// Run: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b4e3-'));
process.env.ROAMIES_DATA_DIR = TMP;
const S = await import('../store.mjs');
const { ClaudeCodeAgent, contextOf, renderTranscript, resumeId } = await import('../claudecode.mjs');
const { agentEvents } = await import('../agentstream.mjs');
const { parseBrain, parseSkill } = await import('../brain.mjs');
const { BUILTIN_TOOLS } = await import('../brain-server.mjs');
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
const brainSrc = fs.readFileSync(new URL('../brain-server.mjs', import.meta.url), 'utf8');

// ---- 1. A 108-message session shaped like the owner's (20261121-192052-1c0ccd.json): a summary, 24 requests, ~36K
// estimated tokens, five small requests, one huge one (big tool results), then eighteen middling ones.
let n = 0;
const request = (userChars, results, answer = 'Done.', lead = false) => {
  const i = ++n, out = [{ role: 'user', content: `[Sun 22 Nov] r${i} ${'u'.repeat(userChars)}` }];
  if (lead) out.push({ role: 'assistant', content: [{ type: 'text', text: 'Checking.' }] });
  results.forEach((chars, j) => {
    out.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}_${j}`, name: 'read_window', args: { app: 'Safari' } }] });
    out.push({ role: 'tool', content: [{ type: 'tool_result', toolCallId: `c${i}_${j}`, content: 'w'.repeat(chars) }] });
  });
  out.push({ role: 'assistant', content: [{ type: 'text', text: `${answer} (r${i})` }] });
  return out;
};
const summary = { role: 'user', content: `${S.SUMMARY_HEAD}\nThey opened ui.elevenlabs.io and asked for a screenshot of the orbs.` };
const owner = [
  summary,
  ...Array.from({ length: 5 }, () => request(200, [1000])).flat(),
  ...request(300, [14_000, 14_000, 14_000, 14_000]),
  ...Array.from({ length: 18 }, (_, i) => request(400, [3000], 'Done.', i < 5)).flat(),
];
const reqIdx = owner.map((m, i) => (m.role === 'user' && !S.isSummary(m) ? i : -1)).filter((i) => i >= 0);
assert.equal(owner.length, 108, 'the fixture has the owner\'s 108 messages');
assert.equal(owner.filter((m) => m.role === 'user').length, 25, '25 user messages');
assert.equal(reqIdx.length, 24, '24 requests');
const est = S.approxTokens(owner);
assert.ok(est > 34_000 && est < 38_000, `about 36K estimated tokens (${est})`);
{
  // Today's skip, without scale: the cut lands after the five small requests, too little to fold.
  const p = S.planFold(owner, { trigger: 90_000 });
  assert.deepEqual([p.ok, p.reason], [false, 'too little to fold yet'], 'unscaled: the same skip as on the owner\'s Mac');
  // Measured like Claude Code counts it (~120K chat): it folds.
  const scale = 120_685 / est;
  assert.ok(scale > 3.2 && scale < 3.6, `scale about 3.4 (${scale.toFixed(2)})`);
  const f = S.planFold(owner, { trigger: 90_000, scale, foldCap: 40_000 });
  assert.ok(f.ok, f.reason);
  assert.equal(f.start, 1, 'the earlier summary is merged, not folded as a turn');
  assert.match(f.summary, /ui\.elevenlabs\.io/);
  assert.equal(owner[f.end].role, 'user', 'cut at a user request');
  const kept = owner.slice(f.end);
  assert.ok(kept.filter((m) => m.role === 'user').length >= 2, 'the last two requests stay word for word');
  assert.ok(f.end <= reqIdx.at(-2), 'the cut is never after the second-to-last request');
  assert.ok(S.approxTokens(kept) * scale >= 20_000, 'at least 20K measured chat tokens stay');
  assert.ok(f.tokens >= 8_000, 'enough to fold, in measured tokens');
  const ids = new Set(kept.flatMap((m) => (m.role === 'assistant' && Array.isArray(m.content) ? m.content.map((p) => p.id) : [])));
  for (const m of kept.filter((x) => x.role === 'tool')) for (const r of m.content) assert.ok(ids.has(r.toolCallId), 'tool calls stay paired');

  // Fold then a new session: the history no longer matches Claude Code's, so it is seeded from the summary and the
  // last two requests, word for word.
  const next = S.applyFold(owner, f, 'They asked about the orbs page and Hydra opened it.');
  assert.ok(next && S.isSummary(next[0]), 'one summary message first');
  const state = { sessionId: 'old', count: owner.length, anchor: 'x' };
  assert.equal(resumeId(state, [...next, { role: 'user', content: 'and now?' }]), undefined, 'a fold starts a new Claude Code session');
  const seed = renderTranscript(next, 400_000);
  const body = seed.slice(seed.indexOf('oldest first.'));
  assert.ok(body.indexOf(S.SUMMARY_HEAD) < body.indexOf('User: [Sun 22 Nov]'), 'the seed starts with the summary');
  for (const i of reqIdx.slice(-2)) assert.ok(seed.includes(owner[i].content), `request ${i} is in the seed word for word`);
  assert.ok(seed.includes(`Done. (r${n - 1})`) && seed.includes(`Done. (r${n})`), 'their answers too');
}
{
  // Never right after a question: that request is its answer, so the cut moves to an earlier request.
  const scale = 120_685 / est;
  const plain = S.planFold(owner, { trigger: 90_000, scale });
  const q = owner.map((m) => ({ ...m }));
  q[plain.end - 1] = { role: 'assistant', content: [{ type: 'text', text: 'Should I open it in Safari or Chrome?' }] };
  const p = S.planFold(q, { trigger: 90_000, scale });
  assert.ok(p.ok && p.end < plain.end && q[p.end].role === 'user', 'the question and its answer stay together');
  // Past the cap, the oldest slice folds first (the next request folds more).
  const capped = S.planFold(owner, { trigger: 90_000, scale, foldCap: 20_000 });
  assert.ok(capped.ok && capped.end < plain.end && S.approxTokens(capped.folded) <= 20_000, 'the oldest slice first');
  assert.ok(S.approxTokens(S.planFold(owner, { trigger: 90_000, scale, foldCap: 40_000 }).folded) <= 40_000, 'the fold input stays under 40K');
}

// ---- 2. The gate, on the owner's numbers: the chat decides, never the whole prompt.
{
  const trigger = S.compactTrigger(120_000, undefined);
  assert.equal(trigger, 90_000, '75 % of 120K');
  const at1835 = { total: 778_713, fixed: 658_028, chat: 120_685 };
  assert.equal(S.foldWhy({ ...at1835, trigger }), null, 'chat 120,685 of a 778,713 prompt: fold');
  assert.equal(S.foldWhy({ total: 775_000, chat: 20_000, trigger }), 'chat under trigger', 'a 775K prompt with a 20K chat: no fold');
  assert.equal(S.foldWhy({ chat: 89_999, trigger }), 'chat under trigger', 'just under 90K: no fold');
  assert.equal(S.foldWhy({ chat: 90_000, trigger }), null, '90K: fold');
  assert.equal(S.foldWhy({ chat: 95_000, trigger, fails: 2, failedAt: 90_000 }), 'waiting after two failed folds');
  assert.equal(S.foldWhy({ chat: 98_000, trigger, fails: 2, failedAt: 90_000 }), null, '8K more after two failures: try again');
  assert.equal(S.foldWhy({ chat: 95_000, trigger, fails: 1, failedAt: 90_000 }), null, 'one failure retries after the next request');
  // sidekick wiring: the gate takes the measured chat, and planFold the scale and the cap.
  const mc = side.slice(side.indexOf('function maybeCompact()'), side.indexOf('function applyPendingFold()'));
  assert.match(mc, /const chat = li\?\.chat \?\? 0/, 'maybeCompact reads the chat');
  assert.match(mc, /foldWhy\(\{ chat, trigger, fails: foldFails, failedAt \}\)/, 'the gate is on the chat');
  assert.match(mc, /planFold\(session\.messages, \{ trigger, scale: li\?\.measured && est \? chat \/ est : 1, foldCap: FOLD_CAP \}\)/);
  assert.match(mc, /logLine\('compact_check', \{ session: session\.id, chat, fixed: li\?\.fixed \?\? null, total: li\?\.total \?\? null/, 'compact_check shows chat, fixed and total');
  assert.ok(!/tokens/.test(mc.split('\n').find((l) => l.includes('const chat')) ?? ''), 'not the whole prompt');
  assert.match(side, /else if \(e\.type === 'context_usage'\) \{\n\s+lastInput = \{ session: session\?\.id, chat: e\.chat, fixed: e\.fixed, total: lastSeen \|\| e\.chat \+ e\.fixed, measured: true \};/, 'Claude Code\'s count sets the chat');
  assert.match(side, /if \(!lastInput && session\) \{ const chat = approxTokens\(session\.messages\); lastInput = \{ session: session\.id, chat, fixed: null,/, 'no count: our estimate, unmeasured');
  assert.ok(!/lastInput = \{ session: session\?\.id, tokens: seen/.test(side), 'a call\'s whole prompt is never the chat');
  assert.match(side, /if \(!floorLogged\) \{ floorLogged = true; logLine\('context_floor'/, 'the fixed floor is logged once per process');
  assert.match(side, /if \(retrying\) retryInfo = null;\n[\s\S]{0,300}const fold = foldFirst\(\);\n  if \(fold\) \{[\s\S]{0,900}\n  \}\n  const notReady = await readyAgent\(\);/, 'a chat past the whole budget waits for the fold under way, before the agent is built');
  assert.match(side, /const foldFirst = \(\) => \(compacting && lastInput\?\.session === session\?\.id && \(lastInput\?\.chat \?\? 0\) >= BUDGET_CAP \? compacting : null\);/);
  assert.match(mc, /if \(compacting \|\| intro \|\| busy \|\| queued/, 'never mid-run');
}

// ---- 3. Claude Code: the chat is measured after the run; connectors' schemas wait behind ToolSearch.
const SESSION = 'sess-e3';
const ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION });
const usage775 = {
  categories: [
    { id: 'system_prompt', name: 'System prompt', tokens: 9_000, kind: 'used' },
    { id: 'mcp_tools', name: 'MCP tools', tokens: 596_000, kind: 'used' },
    { id: 'mcp_instructions', name: 'MCP instructions', tokens: 2_000, kind: 'used' },
    { id: 'messages', name: 'Messages', tokens: 120_685, kind: 'used' },
    { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 50_000, kind: 'deferred', isDeferred: true },
    { id: 'autocompact_buffer', name: 'Autocompact buffer', tokens: 33_000, kind: 'buffer' },
    { id: 'free_space', name: 'Free space', tokens: 10_000, kind: 'free' },
  ],
  mcpTools: [
    { name: 'mcp__claude_ai_Ahrefs__a', serverName: 'claude_ai_Ahrefs', tokens: 90_000 },
    { name: 'mcp__gg__draw', serverName: 'gg', tokens: 3_000 },
    ...Array.from({ length: 6 }, (_, i) => ({ name: `mcp__claude_ai_X__t${i}`, serverName: 'claude_ai_X', tokens: 1_000 * (i + 1) })),
  ],
};
function fake(getContextUsage) {
  const calls = { options: null, contextAsks: [] };
  const query = ({ prompt, options }) => {
    calls.options = options;
    const inputs = prompt[Symbol.asyncIterator]();
    async function* run() {
      await inputs.next();
      yield { type: 'system', subtype: 'init', session_id: SESSION };
      yield ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5, cache_read_input_tokens: 776_712 } } });
      yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here.' } });
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here.' }] } };
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 2, cache_read_input_tokens: 776_712 } });
      yield ev({ type: 'message_stop' });
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Here.', session_id: SESSION };
    }
    const q = run();
    q.interrupt = async () => {}; q.close = () => {};
    if (getContextUsage) q.getContextUsage = (o) => { calls.contextAsks.push(o); return getContextUsage(); };
    return q;
  };
  return { query, calls };
}
const readFile = { name: 'read_file', description: 'Read a file', parameters: z.object({ path: z.string() }), execute: async () => 'x' };
const runOnce = async (f, extra = {}) => {
  const a = new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [readFile], executable: '/bin/claude', cwd: '/', env: {}, query: f.query, onRateLimit: () => {}, ...extra });
  const out = [];
  for await (const e of agentEvents(a.prompt('show me the orbs'))) out.push(e);
  return out;
};
{
  const f = fake(async () => usage775);
  const events = await runOnce(f, { connectors: true, gate: async () => false });
  const cu = events.filter((e) => e.type === 'context_usage');
  assert.equal(cu.length, 1, 'one context_usage event per run');
  assert.equal(cu[0].chat, 120_685, 'chat: the messages row');
  assert.equal(cu[0].fixed, 9_000 + 596_000 + 2_000, 'fixed: every other used row (no buffer, no free space)');
  assert.ok(cu[0].fixed >= 596_000);
  assert.equal(cu[0].deferred, 50_000, 'deferred rows apart');
  assert.deepEqual(cu[0].top.map((t) => t.name), ['mcp__claude_ai_Ahrefs__a', 'mcp__claude_ai_X__t5', 'mcp__claude_ai_X__t4', 'mcp__claude_ai_X__t3', 'mcp__gg__draw'], 'the 5 biggest MCP tools');
  assert.deepEqual(f.calls.contextAsks, [{ detail: 'summary' }], "asked once, 'summary' (no extra token-count calls)");
  assert.equal(events.at(-1).type, 'agent_done', 'then the run ends as usual');
  const o = f.calls.options;
  assert.deepEqual(o.tools, ['ToolSearch'], 'with connectors: ToolSearch, so their schemas are deferred');
  assert.equal((await o.canUseTool('ToolSearch', { query: 'gmail' }, {})).behavior, 'allow', 'ToolSearch may run');
  assert.equal((await o.canUseTool('Bash', {}, {})).behavior, 'deny', 'no other built-in');
  assert.equal((await o.canUseTool('mcp__claude_ai_Gmail__send_message', {}, {})).behavior, 'deny', 'a connector call still meets the gate');
  // Ours stay loaded in the prompt.
  const waiting = new Map();
  const transport = { onmessage: undefined, async send(m) { waiting.get(m.id)?.(m); } };
  await o.mcpServers.gg.instance.connect(transport);
  const listed = await new Promise((r) => { waiting.set(1, r); transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }); });
  assert.ok(listed.result.tools.every((t) => t._meta['anthropic/alwaysLoad'] === true), 'Hydra\'s tools keep alwaysLoad');
}
{
  // Without connectors: no built-in at all, ToolSearch denied.
  const f = fake(async () => usage775);
  await runOnce(f);
  assert.deepEqual(f.calls.options.tools, []);
  assert.equal((await f.calls.options.canUseTool('ToolSearch', {}, {})).behavior, 'deny');
}
{
  // A rejecting getContextUsage, a CLI without it, or one that never answers: no event, a normal end.
  for (const g of [async () => { throw new Error('unsupported'); }, null, async () => ({ categories: [{ id: 'system_prompt', tokens: 1, kind: 'used' }] })]) {
    const events = await runOnce(fake(g), { connectors: true });
    assert.ok(!events.some((e) => e.type === 'context_usage'), 'no count, no event');
    assert.deepEqual(events.slice(-2).map((e) => e.type), ['turn_end', 'agent_done']);
  }
  const t0 = Date.now();
  const events = await runOnce(fake(() => new Promise(() => {})), { connectors: true });
  assert.ok(!events.some((e) => e.type === 'context_usage') && Date.now() - t0 < 6_000, 'a hung count never holds the turn');
  assert.equal(contextOf(null), null);
}
// The server brain: ToolSearch is the one built-in not disallowed, and its floor is logged once per process.
assert.ok(!BUILTIN_TOOLS.includes('ToolSearch'), 'brain-server lets ToolSearch run');
for (const t of ['Bash', 'Read', 'Write', 'WebFetch', 'Task']) assert.ok(BUILTIN_TOOLS.includes(t));
assert.match(brainSrc, /else if \(e\.type === 'context_usage' && !floorLogged\) \{ floorLogged = true; log\('context_floor'/);

// ---- 4. jsonOf: the first balanced object (log 584: "Unexpected non-whitespace character after JSON").
{
  const A = 'They opened the orbs page and took a screenshot.';
  const two = `{"summary":"${A}","facts":[]}\n{"x":1}`;
  assert.equal(parseBrain(two, { wantSummary: true }).summary, A, 'two objects: the first one');
  assert.equal(parseBrain('Sure.\n```json\n{"summary":"They asked about {braces} and \\" quotes }","facts":[]}\n```\nAnything else?', { wantSummary: true }).summary, 'They asked about {braces} and " quotes }', 'braces and quotes inside strings');
  assert.equal(parseBrain(`{"summary":"${A}","facts":[{"text":"Eason likes the orbs page."}]} trailing }`, { wantSummary: true }).facts.length, 1);
  assert.throws(() => parseBrain('no json here'), /no JSON/);
  assert.throws(() => parseBrain('{"summary": "cut off'), /no JSON/);
  assert.equal(parseSkill('{"skill":null}\n{"skill":{"x":1}}'), null, 'the skill parser reads the first object too');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('build 4 E3 (compaction like a chat): passed');
