// RELAY-UP + MAC-DELEGATE, by behavior against an in-memory fake Hydra (no network, no real Claude Code, temp HOME).
// The fake checks every body with the web's own zod schemas (relayschema.mjs) and models the 0160/0191 server rules:
// inputs acknowledged by inputsSeen, a done held while unread inputs wait, sub-turns only a Mac claims, "Your Mac is
// offline." when no Mac is online, relay approvals the owner answers.
// - inputsSeen on every post, 0 on the first;
// - each addition pushed into the running session once, in seq order, with the ADDED prefix;
// - the done hold: a held done is answered in the same session, then done again; capped and said so;
// - ask_mac: happy path, Mac offline (at once), approval declined, a question too long refused (never cut);
// - scope: any entity slug, end to end; relayschema.mjs is the web file (stored hash). Run: npm test
import assert from 'node:assert/strict';
import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { ADDITIONS_UNANSWERED, HOLD_MAX, INPUT_PREFIX, TOO_MANY_ADDED, createRelay, isSubturn, relaySession, toolFilter, turnPrompt } from '../relay.mjs';
import { ADDED_PREFIX, relayApprovalSchema, relayBatchSchema, relayEventsAnswerSchema, relaySubturnSchema, subturnResultSchema } from '../relayschema.mjs';
import { ClaudeCodeAgent } from '../claudecode.mjs';
import { BRAIN_SYSTEM, MAC_OFFLINE_TEXT, MAC_UNSURE_TEXT, askMacTool, createBrainTurn } from '../brain-server.mjs';
import { showTool } from '../hydramcp.mjs';

assert.ok(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir())), 'runs with a temp HOME (test/run.mjs)');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (ok, ms = 5000) => { const end = Date.now() + ms; while (!ok() && Date.now() < end) await wait(2); assert.ok(ok(), 'timed out'); };
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body ?? null) });

// ---- The fake Hydra: the relay routes as the web at 18e392b answers them.
function fakeHydra({ macOnline = true } = {}) {
  const turns = new Map(), approvals = new Map(), posts = [];
  const add = (t) => { const row = { status: 'queued', events: [], inputs: [], seen: 0, claimSeq: 0, claimId: null, by: null, ...t }; turns.set(row.id, row); return row; };
  const out = (t) => ({ id: t.id, claimId: t.claimId, threadId: t.threadId, input: t.input, surface: t.surface, context: t.context, history: [], ...(t.allowedTools ? { allowedTools: t.allowedTools } : {}), ...(t.parentTurnId ? { parentTurnId: t.parentTurnId } : {}) });
  const said = (t) => t.events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join('').trim();
  const api = (device, role) => ({
    req: async (p, o = {}) => {
      const url = new URL(p, 'https://h.invalid');
      if (url.pathname === '/api/agent/relay/next') {
        // 0121 + 0160: a Mac claims needs_mac turns (sub-turns); the brain claims the rest.
        const t = [...turns.values()].find((x) => x.status === 'queued' && (role === 'mac') === !!x.parentTurnId);
        if (!t) { await wait(5); return res(204); }
        Object.assign(t, { status: 'claimed', by: device, claimId: randomUUID(), claimSeq: 0 });
        return res(200, { turn: out(t) });
      }
      if (url.pathname === '/api/agent/relay/events') {
        const b = relayBatchSchema.parse(o.body);
        posts.push({ device, ...structuredClone(b) });
        const t = turns.get(b.turnId);
        if (!t) return res(404, { error: 'not_found' });
        if (t.claimId !== b.claimId || t.status !== 'claimed') return res(409, { error: 'stale_claim' });
        t.beforePost?.(t, b);
        if (b.inputsSeen !== undefined) t.seen = Math.max(t.seen, b.inputsSeen);
        const fresh = () => (b.inputsSeen === undefined ? [] : t.inputs.filter((i) => i.seq > t.seen));
        const skip = b.seq ? t.claimSeq - (b.seq - 1) : 0;
        const evs = b.events.slice(Math.max(skip, 0));
        t.claimSeq += evs.length;
        const last = evs.at(-1);
        const held = last?.type === 'done' && fresh().length > 0;
        for (const e of evs) if (!(held && e.type === 'done')) t.events.push(e);
        if (!held && (last?.type === 'done' || last?.type === 'error')) { t.status = last.type; return res(200, { ok: true, status: t.status, inputs: [] }); }
        return res(200, { ok: true, status: 'claimed', inputs: fresh() });
      }
      if (url.pathname === '/api/agent/relay/approval' && o.method === 'POST') {
        const b = relayApprovalSchema.parse(o.body);
        const t = turns.get(b.turnId);
        if (!t || t.claimId !== b.claimId || t.status !== 'claimed') return res(409, { error: 'stale_claim' });
        const id = randomUUID();
        approvals.set(id, { id, turnId: t.id, summary: b.summary, status: 'pending' });
        return res(201, { id });
      }
      if (url.pathname === '/api/agent/relay/subturn' && o.method === 'POST') {
        const b = relaySubturnSchema.parse(o.body);
        const parent = turns.get(b.turnId);
        if (!parent) return res(404, { error: 'not_found' });
        if (parent.claimId !== b.claimId || parent.status !== 'claimed') return res(409, { error: 'stale_claim' });
        if (role !== 'brain') return res(403, { error: 'not_brain' });
        if (parent.parentTurnId || !['web', 'phone'].includes(parent.surface)) return res(400, { error: 'not_live' });
        const sub = add({ id: randomUUID(), threadId: parent.threadId, surface: parent.surface, context: parent.context, input: { text: b.instruction.trim() }, allowedTools: ['mac'], parentTurnId: parent.id });
        if (!macOnline) Object.assign(sub, { status: 'error', events: [{ type: 'error', code: 'mac_offline', message: 'Your Mac is offline.' }] });
        return res(201, { subTurnId: sub.id });
      }
      if (url.pathname === '/api/agent/relay/subturn') {
        const sub = turns.get(url.searchParams.get('id'));
        if (!sub || turns.get(sub.parentTurnId)?.by !== device) return res(404, { error: 'not_found' });
        const err = sub.events.findLast((e) => e.type === 'error');
        const reason = sub.status === 'error' ? err?.message ?? '' : sub.status === 'expired' ? 'Your Mac took too long.' : '';
        return res(200, subturnResultSchema.parse({ status: sub.status, text: [said(sub), reason].filter(Boolean).join('\n') }));
      }
      return res(404, { error: 'not_found' });
    },
  });
  return { turns, approvals, posts, add, api, said };
}
// A web or phone turn the brain already holds (as /relay/next handed it out).
const heldParent = (hydra, surface = 'phone') => hydra.add({ id: randomUUID(), threadId: randomUUID(), surface, context: { path: '/', search: '', scope: 'all' }, input: { text: 'is Safari open on my Mac?' }, status: 'claimed', by: 'brain-1', claimId: randomUUID() });

// A fake Claude Code (the SDK query seam), as voicecontract.test.mjs: each user message the session takes is recorded.
const sdk = (script) => {
  const calls = { inputs: [] };
  const query = ({ prompt }) => {
    const it = prompt[Symbol.asyncIterator]();
    const ctx = { async next() { const x = await it.next(); if (!x.done) calls.inputs.push(x.value); return x.value; } };
    return Object.assign(script(ctx), { interrupt: async () => {}, close: () => {} });
  };
  return { query, calls };
};
const ev = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
const says = (text) => [ev({ type: 'message_start', message: { usage: {} } }), ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }), ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }), ev({ type: 'message_stop' })];
const result = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
const textOf = (m) => m.message.content.map((c) => c.text).join('');
const agentWith = (query) => new ClaudeCodeAgent({ model: 'm', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {} });
const sessionRunner = (query, out) => async (turn, h) => {
  const agent = agentWith(query);
  out.agent = agent;
  await relaySession({ agent, text: turnPrompt(turn).text, h, onEvent: (e) => { if (e.type === 'text_delta') h.emit({ type: 'text', delta: e.text }); } });
};
const relayOn = (api, runTurn, extra = {}) => createRelay({ api, runTurn, slots: ['live'], waitSecs: 1, minPollMs: 1, flushMs: 1, heartbeatMs: 60_000, inputBeatMs: 10, ...extra });
const turnFor = (hydra, extra = {}) => hydra.add({ id: randomUUID(), threadId: randomUUID(), surface: 'phone', context: { path: '/', search: '', scope: 'all' }, input: { text: 'what is on Thursday?' }, ...extra });

// ---- 1 + 2. inputsSeen from the first post; additions pushed once, in order, prefixed; acknowledged.
{
  assert.equal(INPUT_PREFIX, ADDED_PREFIX, 'the prefix is the web\'s');
  const hydra = fakeHydra();
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    yield* says('Thursday: dentist.');
    await ctx.next(); await wait(60); await ctx.next(); // several heartbeats come back with the same inputs meanwhile
    yield* says('Friday free, Saturday gym.');
    yield result;
  });
  const t = turnFor(hydra);
  const out = {};
  const relay = relayOn(hydra.api('brain-1', 'brain'), sessionRunner(query, out));
  relay.start();
  await until(() => hydra.posts.length >= 1);
  assert.equal(hydra.posts[0].inputsSeen, 0, 'the first post says inputsSeen 0: this device reads additions');
  // Two additions arrive out of order; the server repeats them until they are acknowledged.
  t.inputs.push({ seq: 2, text: 'and Saturday' }, { seq: 1, text: 'also Friday' });
  await until(() => t.status === 'done');
  await relay.stop();
  assert.deepEqual(calls.inputs.map(textOf).slice(1), [`${ADDED_PREFIX}also Friday`, `${ADDED_PREFIX}and Saturday`], 'once each, in seq order, prefixed');
  assert.ok(hydra.posts.every((b) => Number.isInteger(b.inputsSeen)), 'every post carries inputsSeen');
  const firstAck = hydra.posts.findIndex((b) => b.inputsSeen === 2);
  assert.ok(firstAck > 0 && hydra.posts.slice(firstAck).every((b) => b.inputsSeen === 2), 'then the highest pushed seq, never less');
  assert.equal(hydra.said(t), 'Thursday: dentist.Friday free, Saturday gym.');
  assert.equal(t.events.filter((e) => e.type === 'done').length, 1);
}

// ---- 3. The done hold: Hydra holds the done for words that came at the very end; they are answered, then done again.
{
  const hydra = fakeHydra();
  let round = 0;
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    // The first prompt, then the same session resumed with the held words.
    yield* says(round++ === 0 ? 'You have $5.' : 'And $3 in savings.');
    yield result;
  });
  const t = turnFor(hydra, { input: { text: 'balance?' } });
  // The owner adds words while the done is on its way: Hydra has them when the done arrives, so it holds it.
  t.beforePost = (row, b) => { if (b.events.at(-1)?.type === 'done' && !row.inputs.length) row.inputs.push({ seq: 1, text: 'and savings?' }); };
  const relay = relayOn(hydra.api('brain-1', 'brain'), sessionRunner(query, {}), { inputBeatMs: 60_000 });
  relay.start();
  await until(() => t.status === 'done');
  await relay.stop();
  const dones = hydra.posts.filter((b) => b.events.at(-1)?.type === 'done');
  assert.equal(dones.length, 2, 'done, held, answered, done again');
  assert.equal(dones[0].inputsSeen, 0);
  assert.equal(dones[1].inputsSeen, 1, 'the second done acknowledges the held words');
  assert.equal(calls.inputs.at(-1).message.content.at(-1).text, `${ADDED_PREFIX}and savings?`, 'the held words are the session\'s next user message, prefixed');
  assert.equal(hydra.said(t), 'You have $5.And $3 in savings.');
  assert.equal(t.events.filter((e) => e.type === 'done').length, 1, 'one done stored');
}
{
  // Never a loop: a server that keeps holding gets HOLD_MAX answers, then the turn ends with an error that says so.
  const hydra = fakeHydra();
  let n = 0;
  const t = turnFor(hydra);
  const agent = { prompts: [], prompt(text) { this.prompts.push(text); const s = (async function* () { yield { type: 'text_delta', text: 'ok. ' }; yield { type: 'agent_done', totalUsage: { inputTokens: 1 } }; })(); s.then = (a, b) => Promise.resolve().then(a, b); return s; }, addInput: () => false };
  const relay = relayOn(hydra.api('brain-1', 'brain'), async (turn, h) => relaySession({
    agent, text: 'go', onEvent: (e) => { if (e.type === 'text_delta') h.emit({ type: 'text', delta: e.text }); },
    h: { ...h, done: async (x) => { t.inputs.push({ seq: ++n, text: `more ${n}` }); return h.done(x); } },
  }), { inputBeatMs: 60_000 });
  relay.start();
  await until(() => t.status === 'error');
  await relay.stop();
  assert.equal(agent.prompts.length, HOLD_MAX + 1, `the first prompt and ${HOLD_MAX} held rounds`);
  assert.ok(agent.prompts.slice(1).every((p) => p.startsWith(ADDED_PREFIX)));
  assert.deepEqual(t.events.at(-1), TOO_MANY_ADDED, 'it says so and ends');
  assert.match(hydra.said(t), /stopped there\. Say the rest again\./);
  assert.ok(hydra.posts.filter((b) => b.events.at(-1)?.type === 'done').length <= HOLD_MAX + 1);
}

// ---- 4. ask_mac: the brain asks the owner's Mac; the Mac claims the sub-turn and answers under the owner rule.
// The Mac's side: the relay's sub-turn as sidekick.mjs runs it (Mac tools only; every ask a relay approval).
const macRunner = (seen) => async (turn, h) => {
  seen.push(turn);
  const may = toolFilter(turn.allowedTools);
  assert.ok(isSubturn(turn), 'a sub-turn names its parent');
  assert.ok(may('mac', 'open') && !may('hydra', 'hydra_list_transactions') && !may('gmail', 'send'), 'Mac tools only');
  assert.match(turnPrompt(turn).text, /Hydra's server asks this Mac[\s\S]*Hydra asks this Mac:\nopen Safari and tell me the front tab/);
  const answer = await h.approve({ summary: turn.input.text.includes('long') ? `Open: ${'/Users/owner/Documents/'.repeat(40)}` : 'Open app: /Applications/Safari.app', danger: true });
  h.emit({ type: 'text', delta: answer === 'approved' ? 'Safari is open; the front tab is Hydra.' : 'You said no on your phone, so I did not open Safari.' });
  await h.done();
};
const askMac = (hydra, parent, o = {}) => askMacTool({ api: hydra.api('brain-1', 'brain'), turn: { id: parent.id, claimId: parent.claimId, surface: parent.surface }, pollMs: 5, ...o });
{
  // Happy path: the owner approves on his phone; ask_mac returns the Mac's words; its own turn kept alive meanwhile.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  const seen = [];
  const owner = setInterval(() => { for (const a of hydra.approvals.values()) if (a.status === 'pending') a.status = 'approved'; }, 5);
  const mac = relayOn(hydra.api('mac-1', 'mac'), macRunner(seen), { waitFor: async (id) => { await until(() => hydra.approvals.get(id).status !== 'pending'); return hydra.approvals.get(id).status; } });
  mac.start();
  let beats = 0;
  const text = await askMac(hydra, parent, { beatMs: 1, alive: async () => { beats++; return true; } }).execute({ instruction: 'open Safari and tell me the front tab' });
  clearInterval(owner);
  await mac.stop();
  assert.equal(text, 'Safari is open; the front tab is Hydra.');
  assert.equal(seen.length, 1, 'the Mac claimed the sub-turn once');
  assert.equal(seen[0].parentTurnId, parent.id);
  assert.deepEqual([...hydra.approvals.values()].map((a) => a.summary), ['Open app: /Applications/Safari.app'], 'one relay approval with the full target');
  assert.ok(beats >= 1, 'the brain renewed its own turn while it waited');
  assert.equal(hydra.posts.filter((b) => b.turnId === parent.id).length, 0, 'nothing of the sub-turn was posted to the parent');
  // R11-7: a sub-turn never says inputsSeen, so Hydra takes no additions for it.
  const subPosts = hydra.posts.filter((b) => b.device === 'mac-1');
  assert.ok(subPosts.length > 0 && subPosts.every((b) => b.inputsSeen === undefined), 'no inputsSeen on a sub-turn');
}
{
  // Approval declined: nothing done; ask_mac returns what the Mac said.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  const owner = setInterval(() => { for (const a of hydra.approvals.values()) if (a.status === 'pending') a.status = 'declined'; }, 5);
  const mac = relayOn(hydra.api('mac-1', 'mac'), macRunner([]), { waitFor: async (id) => { await until(() => hydra.approvals.get(id).status !== 'pending'); return hydra.approvals.get(id).status; } });
  mac.start();
  const text = await askMac(hydra, parent).execute({ instruction: 'open Safari and tell me the front tab' });
  clearInterval(owner);
  await mac.stop();
  assert.equal(text, 'You said no on your phone, so I did not open Safari.');
}
{
  // A question longer than the server shows is refused, never cut: no approval is made, the Mac says why.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  const mac = relayOn(hydra.api('mac-1', 'mac'), async (turn, h) => macRunner([])({ ...turn, input: { text: `${turn.input.text} long` } }, h));
  mac.start();
  const text = await askMac(hydra, parent).execute({ instruction: 'open Safari and tell me the front tab' });
  await mac.stop();
  assert.equal(hydra.approvals.size, 0, 'never asked a cut question');
  assert.match(text, /more than I can show here, so I didn't do it[\s\S]*You said no/);
}
{
  // Mac offline: "Your Mac is offline." at once, no hang (the first poll answers).
  const hydra = fakeHydra({ macOnline: false });
  const parent = heldParent(hydra);
  const t0 = Date.now();
  const text = await askMac(hydra, parent, { pollMs: 10_000 }).execute({ instruction: 'take a screenshot' });
  assert.equal(text, MAC_OFFLINE_TEXT);
  assert.ok(Date.now() - t0 < 1000, 'at once');
}
{
  // The turn ended while it waited (the heartbeat lost the claim): it stops waiting; a stale claim never makes one.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  await assert.rejects(askMac(hydra, parent, { beatMs: 1, alive: async () => false }).execute({ instruction: 'take a screenshot' }), /This turn is over/);
  parent.status = 'done';
  await assert.rejects(askMac(hydra, parent).execute({ instruction: 'take a screenshot' }), /This turn is over, so your Mac was not asked/);
}
{
  // The brain gets ask_mac only in a web or phone turn it holds, and its system prompt says when to use it.
  assert.match(BRAIN_SYSTEM, /needs the owner's Mac \(its apps, files, folders, windows, screen or a screenshot\), use ask_mac/);
  assert.match(BRAIN_SYSTEM, /Never use ask_mac for Hydra's data/);
  const names = [];
  const query = ({ options }) => { names.push(options.allowedTools); return Object.assign((async function* () { yield result; })(), { interrupt: async () => {}, close: () => {} }); };
  const brain = createBrainTurn({ hydraTools: { tools: () => [] }, api: fakeHydra().api('b', 'brain'), executable: '/x/claude', cwd: os.tmpdir(), query });
  for (const surface of ['phone', 'routine']) {
    await brain({ id: randomUUID(), claimId: randomUUID(), surface, input: { text: 'hi' }, context: {} }, { emit: () => {}, signal: new AbortController().signal, approve: async () => 'declined' });
  }
  assert.ok(names[0].includes('mcp__gg__ask_mac'), 'a phone turn has ask_mac');
  assert.ok(!names[1].includes('mcp__gg__ask_mac'), 'a routine does not');
}

// ---- 5. Scope: any entity slug, end to end (prompt, hydra_show, the posted batch the server validates).
{
  const hydra = fakeHydra();
  const t = turnFor(hydra, { context: { path: '/reports', search: '', scope: 'acme-llc' } });
  const bad = turnFor(hydra, { context: { path: '/', search: '', scope: 'Acme LLC' } });
  const prompts = [];
  const relay = relayOn(hydra.api('brain-1', 'brain'), async (turn, h) => {
    prompts.push(turnPrompt(turn).text);
    const show = showTool({ onUi: (action) => h.emit({ type: 'ui', action }) });
    await show.execute({ kind: 'setScope', scope: turn.id === t.id ? 'acme-llc' : 'Acme LLC' }).catch(() => {});
    await h.done();
  });
  relay.start();
  await until(() => t.status === 'done' && bad.status === 'done');
  await relay.stop();
  assert.ok(prompts.some((p) => p.includes('scope acme-llc.')), 'the slug reaches the model');
  assert.ok(prompts.some((p) => p.includes('scope all.')), 'a bad scope reads as all');
  assert.deepEqual(t.events.filter((e) => e.type === 'ui'), [{ type: 'ui', action: { kind: 'setScope', scope: 'acme-llc' } }], 'the server took the slug');
  assert.deepEqual(bad.events.filter((e) => e.type === 'ui'), [], 'never a scope the server refuses');
}

// ---- 6. relayschema.mjs is the web's src/lib/agent/relay-schema.ts at 18e392b, byte for byte.
// The hash was taken from `git show 18e392b:src/lib/agent/relay-schema.ts | shasum -a 256` (Hydra repo, ship/wave-6b).
{
  const WEB_SHA256 = '16f9984a482215cef9bab835993ec50435664ef8f19b75d6d5fdddf5728322d2';
  const mine = fs.readFileSync(new URL('../relayschema.mjs', import.meta.url));
  assert.equal(crypto.createHash('sha256').update(mine).digest('hex'), WEB_SHA256, 'relayschema.mjs differs from the web\'s relay-schema.ts: copy it again and update the hash');
  assert.ok(relayEventsAnswerSchema.safeParse({ ok: true, status: 'claimed', inputs: [{ seq: 1, text: 'x' }] }).success);
}
// ---- 7. Round 11.
{
  // R11-2: an addition the session took, then max turns before it was answered: answered in a next round, then done.
  const hydra = fakeHydra();
  let round = 0;
  const { query, calls } = sdk(async function* (ctx) {
    await ctx.next();
    if (round++ === 0) {
      yield* says('Thursday: dentist.');
      await ctx.next(); // the owner's addition is taken (addInput true, so Hydra counts it seen)
      yield { type: 'result', subtype: 'error_max_turns' };
      return;
    }
    yield* says(' Friday: free.');
    yield result;
  });
  const t = turnFor(hydra);
  const relay = relayOn(hydra.api('brain-1', 'brain'), sessionRunner(query, {}));
  relay.start();
  await until(() => hydra.posts.length >= 1);
  t.inputs.push({ seq: 1, text: 'and Friday?' });
  await until(() => t.status === 'done' || t.status === 'error');
  await relay.stop();
  assert.equal(t.status, 'done');
  assert.equal(calls.inputs.at(-1).message.content.at(-1).text, `${ADDED_PREFIX}and Friday?`, 'the unanswered addition is prompted again');
  assert.equal(hydra.said(t), 'Thursday: dentist. Friday: free.', 'and answered before the done');
}
{
  // R11-2: the session fails after it took an addition: the error says his words were not answered.
  const hydra = fakeHydra();
  const { query } = sdk(async function* (ctx) {
    await ctx.next();
    yield* says('Working.');
    await ctx.next();
    yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'] };
  });
  const t = turnFor(hydra);
  const relay = relayOn(hydra.api('brain-1', 'brain'), sessionRunner(query, {}));
  relay.start();
  await until(() => hydra.posts.length >= 1);
  t.inputs.push({ seq: 1, text: 'and Friday?' });
  await until(() => t.status === 'error');
  await relay.stop();
  assert.match(t.events.at(-1).message, /boom What you added while I worked was not answered\. Say it again\./);
}
{
  // R11-8: held words with no one to answer them end with their own code (the web rewrites a brain's mac_failed).
  const hydra = fakeHydra();
  const t = turnFor(hydra);
  t.beforePost = (row, b) => { if (b.events.at(-1)?.type === 'done' && !row.inputs.length) row.inputs.push({ seq: 1, text: 'and savings?' }); };
  const relay = relayOn(hydra.api('brain-1', 'brain'), async (turn, h) => { h.emit({ type: 'text', delta: 'You have $5.' }); }, { inputBeatMs: 60_000 });
  relay.start();
  await until(() => t.status === 'error');
  await relay.stop();
  assert.deepEqual(t.events.at(-1), ADDITIONS_UNANSWERED);
  assert.notEqual(ADDITIONS_UNANSWERED.code, 'mac_failed');
}
{
  // R11-3: the POST /subturn fails after Hydra made it (a timeout): never sent again in this turn; the model is told.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  const real = hydra.api('brain-1', 'brain');
  let posts = 0;
  const api = { req: async (p, o = {}) => {
    if (p === '/api/agent/relay/subturn' && o.method === 'POST') { posts++; await real.req(p, o); throw new Error('timed out'); }
    return real.req(p, o);
  } };
  const tool = askMacTool({ api, turn: { id: parent.id, claimId: parent.claimId, surface: 'phone' }, pollMs: 5 });
  assert.equal(await tool.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT);
  assert.equal(await tool.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT, 'asked again: not sent again');
  assert.equal(posts, 1);
  assert.equal([...hydra.turns.values()].filter((x) => x.parentTurnId === parent.id).length, 1, 'one sub-turn, so the Mac runs it once');
  // A 5xx the same way.
  const five = askMacTool({ api: { req: async () => res(503, { error: 'unavailable' }) }, turn: { id: parent.id, claimId: parent.claimId, surface: 'phone' } });
  assert.equal(await five.execute({ instruction: 'open Safari' }), MAC_UNSURE_TEXT);
}
{
  // R11-4: ask_mac stops waiting before the turn's deadline (less a margin), with what the Mac said so far.
  const hydra = fakeHydra();
  const parent = heldParent(hydra);
  const t0 = Date.now();
  const tool = askMac(hydra, parent, { deadline: t0 + 30_000 + 80, marginMs: 30_000 });
  const text = await Promise.race([tool.execute({ instruction: 'take a screenshot' }), wait(3000).then(() => 'still waiting')]);
  assert.equal(text, 'Your Mac took too long.', 'answered before the turn ends, not after 240 s');
  assert.ok(Date.now() - t0 < 1500);
  const late = askMac(hydra, parent, { deadline: Date.now() + 1000, marginMs: 30_000 });
  assert.match(await late.execute({ instruction: 'take a screenshot' }), /no time left/);
  // The relay hands the runner its deadline: when Hydra ends a live turn.
  const h2 = fakeHydra();
  turnFor(h2);
  let got = null;
  const before = Date.now();
  const relay = relayOn(h2.api('brain-1', 'brain'), async (turn, h) => { got = h.deadline; await h.done(); }, { liveCapMs: 280_000 });
  relay.start();
  await until(() => got !== null);
  await relay.stop();
  assert.ok(got >= before + 280_000 && got <= Date.now() + 280_000, `deadline ${got - before} ms after the start`);
}
console.log('relay up + mac delegate: passed');
