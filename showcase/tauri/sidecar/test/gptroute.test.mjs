import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { test } from 'node:test';
import { AUTH_PROVIDERS } from '@kenkaiiii/gg-core';
import { agentEvents, stallWatch } from '../agentstream.mjs';
import { brainFor, gptRoute } from '../agentsettings.mjs';
import { createBrainTurn } from '../brain-server.mjs';
import { createHydraTools } from '../hydramcp.mjs';
import { ClaudeCodeAgent, connectorTool } from '../claudecode.mjs';
import { credentialTurn } from '../hardlimits-core.mjs';
import { createLimits, firstFree, limitFrom, untilWords } from '../limits.mjs';
import { cleanEvent, connectorGroup, connectorLevel, createLocalSync, createRelay, INPUT_PREFIX, isSubturn, moneyTools, moneyTurn, relaySession, routineCallIdentity, toolFilter, turnPrompt } from '../relay.mjs';
import { relayBatchSchema } from '../relayschema.mjs';
import { EchoFilter, FinalText, ReplyStream } from '../reply.mjs';
import { CueFilter, SpeechText } from '../speech.mjs';
import { SAFE, credentialArgs } from '../safety.mjs';
import * as voiceTurn from '../voiceturn.mjs';
import { createViewGate } from '../viewgate.mjs';
import { oneYesNoAtATime } from '../tools.mjs';

assert.ok(fs.realpathSync(os.homedir()).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), 'run with a temp HOME');
const model = 'gpt-6.2-sol';
const labels = Object.fromEntries(AUTH_PROVIDERS.map((p) => [p.value, p.label]));
const busyLine = "The model's busy, trying again.";
const stopLine = (provider, reason) => `${labels[provider]} isn't answering right now (${reason}). Try again in a minute, or pick another model.`;
const side = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
function source(signature, close = '\n}') {
  const from = side.indexOf(signature), end = side.indexOf(`${close}\n`, from);
  assert.ok(from >= 0 && end > from, signature);
  return side.slice(from, end + close.length);
}
// Run the production functions with the same source harness as imageturn. I/O is replaced at the model,
// speaker and relay boundaries. No provider, Mac helper or server is contacted.
const noop = () => {};
const outside = new Proxy(function () {}, {
  get: (_, key) => key === 'then' ? undefined : key === Symbol.toPrimitive ? () => '' : outside,
  apply: () => outside,
});
function sidekick(stubs) {
  const scope = new Proxy(stubs, {
    has: (_, key) => typeof key === 'string' && (key in stubs || !(key in globalThis)),
    get: (s, key) => key === Symbol.unscopables ? undefined : key in s ? s[key] : outside,
  });
  const signatures = ['function makeAgent', 'async function prompt', 'function sayAside', 'async function relayTurn', 'async function connectorGate', 'async function onSpoken', 'function enqueue', 'function addOn', 'async function pairHere', 'function onVoice', 'function discardVoiceArea', 'function storePairing', 'function revokePairing', 'async function onGuide', 'async function introTurn', 'function endIntro', 'async function memoryPass', 'function startSpeech'];
  const names = signatures.map((s) => s.split(' ').at(-1));
  const body = [...signatures.map((s) => source(`${s}(`)), source('const ui = (msg) =>', '\n};')].join('\n');
  const real = new Function('scope', `with (scope) { ${body}; return { ${names.join(', ')}, emitUi: ui }; }`)(scope);
  const memory = ['async function memoryYes', 'function ask', 'function showAsk'].map((s) => source(`${s}(`)).join('\n');
  real.memoryYes = new Function('scope', `with (scope) { ${memory}; return memoryYes; }`)(scope);
  return real;
}

const retry = (attempt, delayMs, reason = 'rate_limit', silent = false) => ({ type: 'retry', reason, attempt, maxAttempts: 10, delayMs, ...(silent ? { silent } : {}) });
const four = (reason) => [2000, 4000, 8000, 16000].map((ms, i) => retry(i + 1, ms, reason));
function* reply(...chunks) {
  for (const text of chunks) yield { type: 'text_delta', text };
  yield { type: 'turn_end', stopReason: 'end_turn', usage: {} };
  yield { type: 'agent_done', totalUsage: {} };
}
function fakeAgent(script, runs) {
  return class Agent {
    constructor(options) { this.options = options; this.messages = []; }
    setSignal(signal) { this.options.signal = signal; }
    getMessages() { return this.messages; }
    prompt(text) {
      this.messages.push({ role: 'user', content: text });
      const run = { signal: this.options.signal, provider: this.options.provider, model: this.options.model, tools: this.options.tools, text, finished: false };
      runs.push(run);
      const stream = (async function* () { try { yield* script(run, runs.length); } finally { run.finished = true; } })();
      stream.then = (ok, bad) => Promise.resolve().then(ok, bad);
      return stream;
    }
  };
}
async function retrySleep(signal) {
  // A local deadline lets the pre-fix regression reach assertions. The production cap must abort this sleep.
  await wait(100, null, { signal });
}
function clock() {
  let now = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) { const handle = {}; timers.set(handle, { fn, at: now + ms }); return handle; },
    clearTimer: (handle) => timers.delete(handle),
    get pending() { return timers.size; },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const [handle, timer] = [...timers].sort(([, a], [, b]) => a.at - b.at)[0] ?? [];
        if (!timer || timer.at > end) break;
        now = timer.at;
        timers.delete(handle);
        timer.fn();
      }
      now = end;
    },
  };
}
function fixture({ script, provider = 'openai', chatgpt = true, Claude = ClaudeCodeAgent, config = {} }) {
  const logs = [], ui = [], sent = [], spoken = [], runs = [], lifecycle = [], stopSignals = [];
  const time = clock();
  const viewGate = createViewGate();
  const viewTurn = viewGate.turn;
  viewGate.turn = (signal) => {
    const turn = viewTurn(signal);
    stopSignals.push(turn.signal);
    return turn;
  };
  let speechId = 0;
  const st = {
    ...voiceTurn, SpeechText, CueFilter, ReplyStream, EchoFilter, FinalText, agentEvents, stallWatch,
    brainFor, gptRoute, relaySession, routineCallIdentity, toolFilter, turnPrompt, isSubturn, moneyTools, moneyTurn,
    relayAsk: new AsyncLocalStorage(), localRequestPair: new AsyncLocalStorage(), connectorTool, connectorGroup, connectorLevel, credentialArgs, credentialTurn, SAFE,
    notePairing: () => null, problem: (_where, err) => err.message, aloud: (line) => line,
    pairingLife: new AbortController(), pairingChanges: Promise.resolve(), changingPairing: false, voicePairing: null, voiceResetPending: null,
    path, os, randomUUID,
    limits: createLimits(), limitFrom, firstFree, untilWords, PROVIDER_LABELS: labels, viewGate,
    config: { provider, model, ...config }, agentSettings: { current: { model, effortLive: 'low' } },
    Agent: fakeAgent(script, runs), ClaudeCodeAgent: Claude, tools: [], hydraLink: { tools: () => [] },
    leanTools: (t) => t, localHydraTools: () => [], hydraTools: { tools: () => [] },
    oauthOn: new Map([['openai', chatgpt]]), refreshAuth: noop, claudeCodeRoute: async () => ({}),
    relayAsker: noop, noteSync: { turnEnded: (turn) => lifecycle.push(['turnEnded', turn]) },
    system: () => '', getModel: () => ({}), forProvider: () => [], thinkingFor: () => 'low',
    intro: null, retryInfo: null, retryNext: null, session: null, hydraKey: null, skillsUsed: new Set(),
    heardSleepWord: () => false, takeAt: null, addOnTake: false, takeSnap: () => null, queued: 0, running: Promise.resolve(),
    routeForTurn: () => null, foldFirst: () => null, frontWithin: async () => '', briefNote: () => null,
    interruptedAfter: '', takeQuizNote: () => '', ink: { listNote: () => '' }, desk: { along: () => '', started: noop },
    delegateNote: () => '', wantsAgent: () => false, foldImages: null, yesNoOpen: new Map(),
    activity: { asked: noop, stopped: () => [] }, logLine: (kind, fields) => logs.push({ kind, ...fields }),
    nextTurn: () => 1, heardTrack: voiceTurn.createSpokenTrack(),
    send: (packet) => { sent.push(packet); if (packet.type === 'ui' && packet.msg.kind === 'agent') ui.push(packet.msg.e); },
    busy: false, voiceMuted: false, voiceBusy: false, approvalOpen: 0, autoListenOn: () => false, shouldLearn: () => false,
    VOICE_ON: () => true, STALL_MS: 120_000,
    speech: { stop: noop, start: () => {
      const id = ++speechId;
      return {
        id, say: (line) => spoken.push(line), end: () => lifecycle.push(['end', id]), abort: () => lifecycle.push(['abort', id]),
        beat: () => spoken.push('filler'), progress: (line) => { spoken.push(line); return true; },
      };
    } },
    setTimeout: time.setTimer, clearTimeout: time.clearTimer,
    startProgress: (opts) => voiceTurn.startProgress({ ...opts, now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer }),
  };
  const real = sidekick(st);
  st.readyAgent = async () => { if (!st.agent) real.makeAgent(provider === 'anthropic' ? { env: {} } : null); return null; };
  return { ...real, logs, ui, sent, spoken, runs, lifecycle, stopSignals, time, viewGate, st };
}
const request = 'What is on Thursday?';

async function relayRun(f, { inputs = [], runTurn = f.relayTurn, turnFields = {} } = {}) {
  const turn = { id: randomUUID(), claimId: randomUUID(), surface: 'phone', input: { text: request }, history: [], ...turnFields };
  const events = [];
  let offered = false, status = 'claimed', sourceSignal, onRelayDone;
  const ended = new Promise((resolve) => { onRelayDone = resolve; });
  const response = (body) => ({ ok: true, status: 200, json: async () => body });
  const api = { req: async (url, opts) => {
    if (url.startsWith('/api/agent/relay/next')) {
      if (!offered) { offered = true; return response({ turn }); }
      await wait(1);
      return { status: 204 };
    }
    assert.equal(url, '/api/agent/relay/events');
    const b = relayBatchSchema.parse(opts.body);
    const unread = inputs.filter((i) => i.seq > b.inputsSeen);
    for (const e of b.events) {
      if (e.type === 'done' && unread.length) continue;
      events.push(e);
      if (e.type === 'done' || e.type === 'error') status = e.type;
    }
    return response({ status, inputs: unread });
  } };
  const relay = createRelay({
    api, slots: ['live'], flushMs: 1, minPollMs: 1, inputBeatMs: 2,
    runTurn: (t, h) => { sourceSignal = h.signal; return runTurn(t, h); },
    log: (kind, fields) => { f.logs.push({ ...fields, kind }); if (kind === 'relay_done') onRelayDone(); },
  });
  relay.start();
  try { await ended; } finally { await relay.stop(); }
  return { events, turn, sourceSignal };
}
const logsOf = (f, kind) => f.logs.filter((l) => l.kind === kind);
const eventsOf = (ui, type) => ui.filter((e) => e.type === type);
const textOf = (ui, field = 'text') => eventsOf(ui, 'text').map((e) => e[field]).join('');
const toolsOf = (events) => eventsOf(events, 'tool').map(({ name, status, summary }) => [name, status, summary]);
const modelStart = (words) => ['model', 'start', `Model busy (${words}), retrying`];

test('Desktop links routine tool events to MCP only when the server advertises support', async () => {
  for (const enabled of [false, true]) {
    const approvalId = randomUUID();
    const calls = [];
    const api = { async req(url, { body }) {
      if (url.startsWith('/api/agent/relay/approval?')) return Response.json({ status: 'approved' });
      const result = body.method === 'tools/list' ? { tools: [{ name: 'remember' }] } : (() => {
        calls.push(body.params);
        return body.params.arguments.approvalId
          ? { content: [{ type: 'text', text: 'Saved' }] }
          : { structuredContent: { needsApproval: true, approvalId, summary: 'Save a note', danger: false } };
      })();
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    } };
    const f = fixture({ script: async function* ({ tools, signal }) {
      const tool = tools.find(({ name }) => name === 'hydra_remember');
      const toolCallId = 'provider-tool-id';
      yield { type: 'tool_call_start', name: tool.name, toolCallId };
      const result = await tool.execute({ note: 'Fixture' }, { toolCallId, signal });
      yield { type: 'tool_call_end', toolCallId, result, isError: false };
      yield* reply('Saved.');
    } });
    f.st.hydraTools = createHydraTools({ api });
    await f.st.hydraTools.refresh();
    const { events, turn } = await relayRun(f, { turnFields: { surface: 'routine', ...(enabled && { routineCallEvidence: true }) } });
    const toolEvents = events.filter((e) => e.type === 'tool' || e.type === 'confirm');
    assert.deepEqual(toolEvents.map((e) => e.status ?? e.type), ['start', 'confirm', 'done']);
    const origin = calls[0]._meta?.['hydra/routine-call'];
    assert.equal(calls[1].arguments.approvalId, approvalId);
    if (enabled) {
      assert.match(origin.callId, /^[0-9a-f-]{36}$/);
      assert.deepEqual(origin, { turnId: turn.id, claimId: turn.claimId, callId: toolEvents[0].callId });
      assert.deepEqual(toolEvents.map((e) => e.callId), Array(3).fill(origin.callId));
      assert.deepEqual(calls[1]._meta, calls[0]._meta);
    } else {
      assert.ok(calls.every((call) => !('_meta' in call)));
      assert.ok(toolEvents.every((event) => !('callId' in event)));
    }
  }
});

test('Desktop Claude reports one receipt when its SDK echoes a fallback-ID Mac job', async () => {
  const jobId = randomUUID();
  const args = { instruction: 'Open Notes', risky: false, hard: 'none' };
  const calls = [];
  const api = { async req(url, { body }) {
    assert.equal(url, '/api/mcp/agent');
    const list = body.method === 'tools/list';
    if (!list) calls.push(body.params);
    const result = list ? { tools: [{ name: 'mac_do' }] }
      : { content: [{ type: 'text', text: JSON.stringify({ jobId, status: 'queued' }) }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } };
  const query = ({ prompt, options }) => Object.assign((async function* () {
    await prompt[Symbol.asyncIterator]().next();
    const toolUseId = 'sdk-job-id';
    yield {
      type: 'assistant', message: { id: 'sdk-job-message', model: 'claude-opus-5-5', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: toolUseId, name: 'mcp__gg__hydra_mac_do', input: args }] },
    };
    const response = Promise.withResolvers();
    const transport = { onmessage: undefined, async send(reply) { response.resolve(reply); } };
    await options.mcpServers.gg.instance.connect(transport);
    transport.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'hydra_mac_do', arguments: args } });
    const { result } = await response.promise;
    assert.equal(JSON.parse(result.content[0].text).jobId, jobId);
    yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: result.content }] } };
    yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
    yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Queued' };
  })(), { interrupt: async () => {}, close: () => {} });
  class Claude extends ClaudeCodeAgent {
    constructor(options) { super({ ...options, keepWarm: false, query }); }
  }
  const f = fixture({ provider: 'anthropic', chatgpt: false, Claude });
  f.st.agentSettings.current.model = 'claude-opus-5-5';
  f.st.hydraTools = createHydraTools({ api });
  await f.st.hydraTools.refresh();
  const { events, turn } = await relayRun(f, { turnFields: { surface: 'routine', routineCallEvidence: true } });
  assert.equal(events.at(-1).type, 'done');
  assert.equal(calls.length, 1);
  const [{ _meta, arguments: sent }] = calls;
  assert.deepEqual(sent, args);
  const origin = _meta['hydra/routine-call'];
  assert.deepEqual([origin.turnId, origin.claimId], [turn.id, turn.claimId]);
  assert.deepEqual(eventsOf(events, 'tool').map((event) => [event.name, event.status, event.callId]), [
    ['hydra_mac_do', 'start', origin.callId],
    ['hydra_mac_do', 'done', origin.callId],
  ]);
});

test('relay follows up once and in order when the gg Agent has no addInput', async () => {
  const f = fixture({ script: async function* (_, round) {
    if (round === 1) await wait(18);
    yield* reply(round === 1 ? 'Dentist.' : 'Gym.');
  } });
  const { events } = await relayRun(f, { inputs: [{ seq: 2, text: 'and Saturday?' }, { seq: 1, text: 'and Friday?' }] });
  assert.deepEqual(logsOf(f, 'relay_input').filter((l) => l.error), [], 'follow-ups never log a missing-method error');
  assert.deepEqual(logsOf(f, 'relay_input').map((l) => [l.seq, l.at]), [[1, 'done'], [2, 'done']]);
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs[0].text.endsWith(request));
  assert.equal(f.runs[1].text, `${INPUT_PREFIX}and Friday?\n\n${INPUT_PREFIX}and Saturday?`);
  assert.equal(textOf(events, 'delta'), 'Dentist. Gym.');
  assert.equal(events.at(-1).type, 'done');
});

test('closed-panel voice on the OpenAI route speaks a normal answer in full and finishes', async () => {
  const f = fixture({ script: async function* () { yield* reply('The first item is a dentist visit. ', 'The second is dinner at six.'); } });
  await f.onSpoken(request, null);
  assert.ok(f.sent.every(({ type }) => type !== 'panel'), 'voice can answer through the overlay without opening the panel');
  assert.deepEqual(f.runs.map(({ provider, model: id }) => [provider, id]), [['openai', model]]);
  assert.deepEqual(f.spoken, ['The first item is a dentist visit.', 'The second is dinner at six.']);
  assert.equal(textOf(f.ui), f.spoken.join(' '));
  assert.deepEqual(f.lifecycle, [['end', 1], ['turnEnded', 1]]);
  assert.equal(f.ui.at(-1).type, 'done');
  assert.equal(f.st.busy, false);
});

test('a terminal SDK error closes the relay without a success event', async () => {
  const f = fixture({ script: async function* () {
    yield retry(1, 2000, 'overloaded');
    yield { type: 'error', error: new Error('Fixture model error') };
    yield { type: 'agent_done' };
  } });
  const { events } = await relayRun(f);
  assert.deepEqual(eventsOf(events, 'done'), []);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).message, /Fixture model error/);
  assert.equal(toolsOf(events).at(-1)?.[1], 'done', 'the retry indicator closes on an error');
  assert.equal(f.runs[0].finished, true);
});

test('a terminal SDK error ends spoken progress and reports the failure', async () => {
  let f;
  f = fixture({ script: async function* () {
    f.time.advance(1600);
    yield { type: 'error', error: new Error('Fixture model error') };
  } });
  await f.prompt(request, null, '', true);
  const before = [...f.spoken];
  f.time.advance(30_000);
  assert.deepEqual(f.spoken, before, 'filler cannot fire after the error');
  assert.deepEqual(eventsOf(f.ui, 'done'), []);
  assert.deepEqual(eventsOf(f.ui, 'error').map(({ message }) => message), ['Fixture model error']);
});

test('a queued request with its area stays with the pairing that accepted it', async () => {
  const f = fixture({ script: async function* () { yield* reply('Current request answered.'); } });
  let pair = 'device-a';
  f.st.notePairing = () => pair;
  let release;
  f.st.running = new Promise((resolve) => { release = resolve; });
  const queued = f.enqueue('First owner fixture', { image: { type: 'image', data: 'inert fixture' } });
  pair = 'device-b';
  release();
  await queued;
  assert.equal(f.runs.length, 0, 'old text and area did not reach a model');
  assert.deepEqual(eventsOf(f.ui, 'error').map((e) => e.message), ['The device pairing changed. Ask again.']);
  await f.enqueue('Second owner fixture');
  assert.equal(f.runs.length, 1, 'the new pairing can submit its own request');
});

test('a queued local thread record cannot retry under a different pairing', async () => {
  let pair = 'device-a';
  const calls = [];
  const sync = createLocalSync({ pairing: () => pair, sleep: async () => { pair = 'device-b'; }, api: { req: async (_url, options) => {
    calls.push(options);
    return calls.length === 1 ? { status: 503 } : { ok: true, json: async () => ({ threadId: randomUUID() }) };
  } } });
  await sync.record({ user: 'first owner fixture' });
  await sync.record({ user: 'second owner fixture' });
  assert.deepEqual(calls.map(({ body, pairBinding }) => [body.user, pairBinding]), [['first owner fixture', 'device-a'], ['second owner fixture', 'device-b']]);
});

test('a spoken area request keeps its pairing through asynchronous image preparation', async () => {
  const f = fixture({ script: async function* () { yield* reply('Unexpected answer.'); } });
  let pair = 'device-a', finishImage;
  f.st.notePairing = () => pair;
  f.st.fitImage = () => new Promise((resolve) => { finishImage = resolve; });
  f.st.imageBlock = async () => ({ type: 'image', data: 'inert fixture' });
  const spoken = f.onSpoken('First owner fixture', { file: 'unused-fixture.png' });
  pair = 'device-b';
  finishImage();
  await spoken;
  await f.st.running;
  assert.equal(f.runs.length, 0);
  assert.deepEqual(eventsOf(f.ui, 'error').map((e) => e.message), ['The device pairing changed. Ask again.']);
});

test('spoken additions join only a running turn from the same pairing', async () => {
  const f = fixture({ script: async function* () { yield* reply('Next request answered.'); } });
  const added = [];
  f.st.busy = true;
  f.st.requestPair = 'device-a';
  f.st.notePairing = () => 'device-a';
  f.st.agent = { addInput: (text) => { added.push(text); return true; } };
  f.st.turnWords = 'First request';
  f.st.turnIntent = f.st.turnWords;
  f.st.addOnTake = true;
  await f.onSpoken('First addition');
  assert.deepEqual(added, [INPUT_PREFIX + 'First addition']);

  let endOldTurn;
  f.st.running = new Promise((resolve) => { endOldTurn = resolve; });
  f.st.notePairing = () => 'device-b';
  f.st.addOnTake = true;
  const next = f.onSpoken('Next request');
  assert.deepEqual(added, [INPUT_PREFIX + 'First addition']);
  assert.equal(f.st.turnWords, 'First request\nFirst addition');
  assert.equal(f.st.queued, 1);
  f.st.agent = null;
  f.st.busy = false;
  endOldTurn();
  await next;
  assert.equal(f.runs.length, 1);
  assert.match(JSON.stringify(f.runs[0].text), /Next request/);
});

test('a queued generic-model addition belongs to its own thread record', async () => {
  const f = fixture({ script: async function* () { yield* reply('Answer.'); } });
  const thread = [];
  f.st.notePairing = () => 'first-pairing';
  f.st.localSync = { record: (r) => thread.push(r.user) };
  f.st.hydraKey = 'inert pairing';
  let ready, endReply;
  const firstStarted = new Promise((resolve) => { ready = resolve; });
  const hold = new Promise((resolve) => { endReply = resolve; });
  f.st.Agent = class extends f.st.Agent {
    prompt(text) {
      const result = super.prompt(text);
      if (f.runs.length > 1) return result;
      ready();
      const stream = (async function* () { await hold; yield* result; })();
      stream.then = result.then;
      return stream;
    }
  };
  const first = f.enqueue('Original request');
  await firstStarted;
  f.st.addOnTake = true;
  await f.onSpoken('Queued follow-up');
  endReply();
  await first;
  await f.st.running;
  assert.deepEqual(thread, ['Original request', 'Queued follow-up']);
});

test('successful pairing replacement closes the old view and relay before starting new work', async () => {
  const f = fixture({ script: async function* () {} });
  const events = [];
  f.st.hydraKey = 'first-pairing';
  f.st.hydraRevoked = false;
  f.st.pairDevice = async () => ({ ok: true, key: 'second-pairing' });
  f.st.secrets = { set: async () => events.push('stored') };
  f.st.remoteView = { stop: () => events.push(['view stop', f.st.hydraKey]) };
  f.st.relay = { stop: async () => events.push(['relay stop', f.st.hydraKey]) };
  f.st.hydraLink = { setKey: () => {} };
  f.st.hydraTools.clear = () => {};
  f.st.agentSettings.stop = () => {};
  f.st.hydraOnline = () => events.push(['start', f.st.hydraKey]);
  f.st.MAC = true;
  f.st.voiceHelperUp = true;
  f.st.resetLostTake = () => {};
  const previous = f.st.pairingLife.signal;
  assert.equal((await f.pairHere('fixture')).ok, true);
  assert.deepEqual(events, ['stored', ['view stop', 'first-pairing'], ['relay stop', 'first-pairing'], ['start', 'second-pairing']]);
  assert.equal(previous.aborted, true);
  assert.equal(f.st.pairingLife.signal.aborted, false);
  const reset = f.sent.find((message) => message.type === 'listen_cancel').pairingReset;
  f.onVoice({ type: 'voice_take_started', take: 'earlier' });
  f.onVoice({ type: 'voice_ready' });
  f.onVoice({ type: 'voice_take_reset', reset: 'earlier-reset' });
  assert.equal(f.st.voicePairing, null);
  assert.equal(f.st.voiceResetPending, reset);
  f.onVoice({ type: 'voice_take_reset', reset });
  assert.equal(f.st.voiceResetPending, null);
  f.st.secrets.set = async () => {};
  f.st.pairDevice = async () => ({ ok: true, key: 'second-pairing' });
  const same = f.st.pairingLife.signal;
  assert.equal((await f.pairHere('fixture')).ok, true);
  assert.equal(same.aborted, false);
  assert.equal(f.sent.filter((message) => message.type === 'listen_cancel').length, 1);
});

test('transcription from a previous pairing cannot reach the model or an ask', async () => {
  const f = fixture({ script: async function* () { yield* reply('Unexpected answer.'); } });
  let pair = 'first-pairing';
  f.st.notePairing = () => pair;
  f.st.power = { asleep: false, talked: () => {}, busy: () => {} };
  f.st.voiceBusy = false;
  f.st.cutTake = false;
  f.st.wakeTake = null;
  f.st.pendingWake = null;
  f.st.onSpoken = f.onSpoken;
  f.st.speech.stop = () => {};
  f.st.speech.prewarm = () => {};
  const published = [];
  const dropped = [], oldArea = path.join(os.tmpdir(), 'sidekick-marked-100.png');
  f.st.fs = { unlink: async (file) => dropped.push(file) };
  f.st.pushWeb = (m) => published.push(m.heard.text);
  f.onVoice({ type: 'voice_take_started', take: 'one' });
  f.onVoice({ type: 'voice_state', state: 'listening', mode: 'hold', take: 'one' });
  pair = 'second-pairing';
  f.onVoice({ type: 'voice_partial', take: 'one', text: 'First-pairing draft' });
  f.onVoice({ type: 'voice_take_started', take: 'two' });
  f.onVoice({ type: 'voice_state', state: 'listening', mode: 'hold', take: 'two' });
  f.onVoice({ type: 'voice', take: 'one', text: 'First-pairing words', area: { file: oldArea } });
  f.onVoice({ type: 'voice_state', state: 'idle', take: 'one' });
  await f.st.running;
  assert.equal(f.runs.length, 0);
  assert.equal(f.st.queued, 0);
  assert.deepEqual(published, []);
  assert.deepEqual(dropped, [oldArea]);
  f.onVoice({ type: 'voice', take: 'two', text: 'Second-pairing words' });
  await f.st.running;
  assert.equal(f.runs.length, 1);
  assert.deepEqual(published, ['Second-pairing words']);
});

test('guide and legacy voice publish only after a fresh take in the current pairing', async () => {
  const f = fixture({ script: async function* () { yield* reply('Answer.'); } });
  let pair = 'fixture-first';
  f.st.notePairing = () => pair;
  f.st.power = { asleep: false, talked: () => {}, busy: () => {} };
  f.st.speech.stop = () => {};
  f.st.speech.prewarm = () => {};
  f.st.wakeTake = null;
  f.st.pendingWake = null;
  f.st.cutTake = false;
  f.st.onSpoken = f.onSpoken;
  const overlay = [], web = [], guide = [];
  f.st.send = (packet) => { if (packet.msg?.kind === 'voice' && packet.msg.text) overlay.push(packet.msg.text); };
  f.st.pushWeb = ({ heard }) => { if (heard?.text) web.push(heard.text); };
  f.st.ob = (packet) => { if (packet.text) guide.push(packet.text); };
  f.onVoice({ type: 'voice_take_started', take: 'old', onboarding: true });
  f.st.pairingLife.abort();
  f.st.pairingLife = new AbortController();
  pair = 'fixture-second';
  f.st.voiceResetPending = 'reset';
  f.onVoice({ type: 'voice_partial', take: 'old', onboarding: true, text: 'Old draft' });
  f.onVoice({ type: 'voice', take: 'old', onboarding: true, text: 'Old words' });
  f.onVoice({ type: 'voice_take_reset', reset: 'reset' });
  f.onVoice({ type: 'voice', onboarding: true, text: 'Orphaned legacy final' });
  assert.deepEqual([overlay, web, guide], [[], [], []]);
  f.onVoice({ type: 'voice_state', state: 'listening', onboarding: true });
  f.onVoice({ type: 'voice_partial', onboarding: true, text: 'Guide draft' });
  f.onVoice({ type: 'voice', onboarding: false, text: 'Guide result after closing' });
  assert.deepEqual([overlay, web, guide], [[], [], ['Guide draft']]);
  f.onVoice({ type: 'voice_state', state: 'listening', onboarding: true });
  f.onVoice({ type: 'voice', onboarding: true, text: 'Guide final' });
  f.onVoice({ type: 'voice_state', state: 'idle', onboarding: true });
  assert.deepEqual(guide, ['Guide draft', 'Guide final']);
  assert.equal(f.runs.length, 0);
  f.onVoice({ type: 'voice_state', state: 'listening' });
  f.onVoice({ type: 'voice_partial', text: 'Fresh draft' });
  f.onVoice({ type: 'voice', text: 'Fresh final' });
  await f.st.running;
  assert.deepEqual(overlay, ['Fresh draft', 'Fresh final']);
  assert.deepEqual(web, overlay);
  assert.equal(f.runs.length, 1);
});

test('guide rejects a late draft submission from a retired pairing', async () => {
  const f = fixture({ script: async function* () {} });
  const accepted = [];
  f.st.introAnswer = (text) => accepted.push(text);
  f.st.guideEpoch = 'current-fixture';
  await f.onGuide({ type: 'chat_answer', guideEpoch: 'old-fixture', text: 'Earlier editable draft' });
  f.st.changingPairing = true;
  await f.onGuide({ type: 'chat_answer', guideEpoch: 'current-fixture', text: 'While replacing the pairing' });
  f.st.changingPairing = false;
  await f.onGuide({ type: 'chat_answer', guideEpoch: 'current-fixture', text: 'Fresh draft' });
  assert.deepEqual(accepted, ['Fresh draft']);
});

test('the guide drops a finished earlier reply and facts when pairing changes during memory', async () => {
  const f = fixture({ script: async function* () {} });
  const published = [], old = f.st.pairingLife;
  let finishMemory;
  f.st.intro = { n: 4, signal: old.signal };
  f.st.QUESTIONS = 4;
  f.st.lastFailed = false;
  f.st.lastReply = 'Previous pairing final reply';
  f.st.plain = (value) => value;
  f.st.introFacts = () => [{ id: 'old', text: 'Previous pairing fact' }];
  f.st.ob = (packet) => published.push(packet);
  f.st.freshSession = (why) => {
    assert.equal(why, 'intro');
    return new Promise((resolve) => { finishMemory = (facts) => resolve(facts); });
  };
  const end = f.introTurn(old.signal);
  assert.equal(typeof finishMemory, 'function');
  old.abort();
  f.st.pairingLife = new AbortController();
  f.st.guideEpoch = 'replacement-fixture';
  finishMemory([{ id: 'old', text: 'Previous pairing fact' }]);
  await end;
  assert.deepEqual(published, [], 'neither earlier reply nor learned facts reach the current guide');
  assert.equal(f.st.config.introDone, undefined, 'the discarded reply does not complete the guide');
});

test('a retired guide stream cannot reach either the guide or desktop after it detaches', () => {
  const f = fixture({ script: async function* () {} });
  const oldGuide = { n: 1 }, currentGuide = { n: 0 };
  const previous = new AbortController(), current = new AbortController();
  const publish = (guide, pairingSignal, text) => f.st.localRequestPair.run({ guide, pairingSignal }, () => {
    f.emitUi({ kind: 'agent', e: { type: 'text', text } });
  });
  const guideMessages = [];
  f.st.ob = (packet) => guideMessages.push(packet);
  previous.abort();
  f.st.intro = null;
  publish(oldGuide, previous.signal, 'Earlier desktop fragment');
  f.st.intro = currentGuide;
  publish(oldGuide, previous.signal, 'Earlier guide fragment');
  publish(currentGuide, current.signal, 'Current guide fragment');
  assert.deepEqual(f.ui, []);
  assert.deepEqual(guideMessages, [{ kind: 'chat', e: { type: 'text', text: 'Current guide fragment' } }]);
});

test('repair stops the speech producer and rejects late guide packets even after the text turn ends', () => {
  const f = fixture({ script: async function* () {} });
  let stops = 0;
  f.st.guideEpoch = 'pair-a';
  f.st.remoteView = { stop: noop };
  f.st.hydraLink.setKey = noop;
  f.st.hydraTools.clear = noop;
  f.st.agentSettings.stop = noop;
  f.st.MAC = false;
  f.st.speech = { stop: () => stops++, start: (opts) => opts };
  const guide = { n: 4 };
  f.st.intro = guide;
  const request = { guide, pairingSignal: f.st.pairingLife.signal };
  const original = f.st.localRequestPair.run(request, () => f.startSpeech());
  f.st.intro = null;
  f.emitUi({ kind: 'speech', id: 'old', ...original, pcm: 'AA==' });
  assert.deepEqual(f.sent.at(-1), { type: 'onboard', msg: { kind: 'speech', id: 'old', guideEpoch: 'pair-a', pcm: 'AA==' } });
  f.revokePairing();
  assert.equal(stops, 1);
  assert.equal(f.st.localRequestPair.run(request, () => f.startSpeech()), null, 'a delayed old aside cannot open a synthesizer');
  const count = f.sent.length;
  for (const event of [{ pcm: 'AA==' }, { end: true }, { mark: 'old-mark' }, { feel: 'happy' }]) {
    f.emitUi({ kind: 'speech', id: 'old', guideEpoch: 'pair-a', ...event });
  }
  assert.equal(f.sent.length, count, 'nothing reaches the guide, desktop overlay, or native player');
  const fresh = f.startSpeech(true);
  f.emitUi({ kind: 'speech', id: 'fresh', ...fresh, pcm: 'AA==' });
  assert.equal(f.sent.at(-1).type, 'onboard');
  assert.equal(f.sent.at(-1).msg.guideEpoch, f.st.guideEpoch);
});

test('guide memory consent requires an explicit answer and expires or cancels with the guide', async () => {
  const f = fixture({ script: async function* () {} });
  const published = [];
  let onShown;
  Object.assign(f.st, {
    onboarding: true, guideWindow: new AbortController(), guideEpoch: 'pair-a', autoYes: () => true,
    askSeq: 0, askQueued: null, oneYesNoAtATime, pending: new Map(), askTake: null,
    ob: (packet) => { published.push(packet); if (packet.kind === 'ask') onShown(packet); },
    trackAsk: (opts) => voiceTurn.trackAsk({ ...opts, now: f.time.now, setTimer: f.time.setTimer, clearTimer: f.time.clearTimer }),
    isYes: (answer) => answer === 'yes', ASK_DEADLINE_MS: voiceTurn.ASK_DEADLINE_MS,
    power: { busy: noop }, stopShowcase: noop, tourPending: null,
  });
  const propose = () => {
    const shown = new Promise((resolve) => { onShown = resolve; });
    const origin = AbortSignal.any([f.st.pairingLife.signal, f.st.guideWindow.signal]);
    return [shown, f.memoryYes('Remember this?\n- A fixture fact.', origin)];
  };
  const [shown, allowed] = propose();
  const first = await shown;
  assert.equal(first.guideEpoch, 'pair-a');
  assert.deepEqual(first.choices, ['Remember', "Don't remember"]);
  assert.equal(first.placeholder, 'Remember this?\n- A fixture fact.');
  f.st.pending.get(first.id)('yes');
  assert.equal(await allowed, true);

  const [timed, expired] = propose();
  const second = await timed;
  f.time.advance(voiceTurn.ASK_DEADLINE_MS);
  assert.equal(await expired, false);
  assert.deepEqual(published.at(-1), { kind: 'cancel_ask', id: second.id });

  const [closing, closed] = propose();
  const third = await closing;
  await f.onGuide({ type: 'ob_closed' });
  assert.equal(await closed, false);
  assert.deepEqual(published.at(-1), { kind: 'cancel_ask', id: third.id });
  assert.equal(f.st.pending.size, 0);
});

for (const reopen of [false, true]) {
  test(`the closed guide's delayed memory is discarded ${reopen ? 'after reopening the same pairing' : 'while the desktop is visible'}`, async () => {
    const f = fixture({ script: async function* () {} });
    const windowLife = new AbortController(), messages = [], attempts = [];
    const origin = AbortSignal.any([f.st.pairingLife.signal, windowLife.signal]);
    const session = { id: 'earlier-guide', messages: [] };
    let completeModel, beginModel;
    const began = new Promise((resolve) => { beginModel = resolve; });
    Object.assign(f.st, {
      onboarding: true, guideWindow: windowLife, guideEpoch: 'same-pair',
      intro: { n: 4, signal: origin }, QUESTIONS: 4, lastFailed: false, lastReply: 'Earlier fixture reply',
      plain: (text) => text, transcript: () => 'Earlier fixture answer', liveFacts: () => [],
      sideRoute: async () => ({}), stopShowcase: noop, tourPending: null,
      voiceKeysLoaded: Promise.resolve(), obState: noop,
      ob: (packet) => messages.push(packet),
      freshSession: (why, signal) => why === 'intro' ? f.memoryPass(session, why, signal) : Promise.resolve([]),
      oneShot: ({ signal }) => {
        beginModel(signal);
        return new Promise((resolve) => { completeModel = resolve; });
      },
      parseBrain: () => ({ facts: [{ text: 'Earlier fixture fact' }] }),
      learnFacts: async (facts) => { attempts.push(facts); return facts; },
    });
    const finished = f.introTurn(f.st.pairingLife.signal);
    const modelSignal = await began;
    await f.onGuide({ type: 'ob_closed' });
    if (reopen) await f.onGuide({ type: 'ob_hello' });
    assert.equal(f.st.pairingLife.signal.aborted, false, 'the credential and pairing did not change');
    completeModel({ model, text: 'A delayed fixture memory completion' });
    await finished;
    assert.deepEqual(attempts, [], 'the earlier memory never reaches the approval route');
    assert.deepEqual(messages, [], 'an earlier prompt or reply is never shown');
    assert.equal(modelSignal.aborted, true, 'the original guide lifetime cancels provider work');
    assert.equal(f.st.config.introDone, undefined);
  });
}

test('pairing retirement drops a still-running guide without starting its memory pass', async () => {
  const f = fixture({ script: async function* () {} });
  const retired = { n: 1, signal: f.st.pairingLife.signal }, originalSession = { id: 'original' }, resets = [];
  let finish;
  f.st.intro = retired;
  f.st.beforeIntro = originalSession;
  f.st.running = new Promise((resolve) => { finish = resolve; });
  f.st.remoteView = { stop: noop };
  f.st.hydraLink.setKey = noop;
  f.st.hydraTools.clear = noop;
  f.st.agentSettings.stop = noop;
  f.st.MAC = false;
  f.st.freshSession = (why) => { resets.push(why); return Promise.resolve([]); };
  f.revokePairing();
  assert.equal(retired.retired, true);
  assert.deepEqual(resets, [], 'the earlier stream drains before the guide session is detached');
  finish();
  await f.st.guideIntroReset;
  assert.equal(f.st.intro, null);
  assert.strictEqual(f.st.session, originalSession);
  assert.deepEqual(resets, [null], 'retired answers never reach the memory model or consent surface');
});

test('the guide memory pass carries pairing cancellation and does not ask about a late result', async () => {
  const f = fixture({ script: async function* () {} });
  const old = new AbortController();
  let complete, started;
  const modelStarted = new Promise((resolve) => { started = resolve; });
  f.st.transcript = () => 'Earlier fixture answer';
  f.st.liveFacts = () => [];
  f.st.sideRoute = async () => ({});
  f.st.oneShot = ({ signal }) => {
    started(signal);
    return new Promise((resolve) => { complete = resolve; });
  };
  let consent = 0;
  f.st.parseBrain = () => ({ facts: [{ text: 'Earlier fixture fact' }] });
  f.st.learnFacts = async (facts) => { consent++; return facts; };
  const memory = f.memoryPass({ id: 'earlier', messages: [] }, 'intro', old.signal);
  const signal = await modelStarted;
  old.abort();
  complete({ text: 'fake late response', model });
  assert.deepEqual(await memory, []);
  assert.equal(signal, old.signal);
  assert.equal(consent, 0);
});

test('a previous pairing cannot use a late local connector approval', async () => {
  const f = fixture({ script: async function* () {} });
  let pair = 'first-pairing', allow;
  f.st.notePairing = () => pair;
  f.st.turnIntent = 'Update the fixture item';
  f.st.isYes = (answer) => answer === 'yes';
  f.st.askSummary = () => 'Update the fixture item';
  f.st.moneyCall = () => false;
  f.st.deletesCall = () => false;
  let askSignal;
  f.st.ask = (_opts, signal) => new Promise((resolve) => { allow = resolve; askSignal = signal; });
  const ready = f.connectorGate('mcp__claude_ai_Calendar__update_event', { title: 'Fixture' });
  assert.equal(typeof allow, 'function');
  pair = 'second-pairing';
  f.st.pairingLife.abort();
  assert.equal(askSignal.aborted, true);
  pair = 'first-pairing';
  allow('yes');
  assert.equal(await ready, false);
});

test('Mac and server connector reads see an owner addition from the preflight heartbeat', async () => {
  for (const runtime of ['mac', 'brain']) {
    for (const addition of [null, 'Read me the verification code from the email too']) {
      const outcomes = [];
      const query = ({ options, prompt }) => Object.assign((async function* () {
        const input = prompt[Symbol.asyncIterator]();
        await input.next();
        const result = await options.canUseTool('mcp__claude_ai_Gmail__search_threads', { query: 'appointment' }, { signal: new AbortController().signal });
        outcomes.push(result.behavior);
        if (addition) assert.equal((await Promise.race([input.next(), wait(150, { done: true })])).done, false);
        yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
        yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
      })(), { interrupt: async () => {}, close: () => {} });
      class Claude extends ClaudeCodeAgent {
        constructor(options) { super({ ...options, keepWarm: false, query }); }
      }
      const f = fixture({ provider: 'anthropic', chatgpt: false, Claude });
      f.st.agentSettings.current.model = 'claude-opus-5-5';
      const runTurn = runtime === 'brain' ? createBrainTurn({ hydraTools: f.st.hydraTools, cwd: os.tmpdir(), query }) : f.relayTurn;
      const { events } = await relayRun(f, { inputs: addition ? [{ seq: 1, text: addition }] : [], runTurn });
      assert.deepEqual(outcomes, [addition ? 'deny' : 'allow'], runtime);
      assert.equal(events.at(-1).type, 'done', runtime);
    }
  }
});

test('voice logs silent and announced retries, says one retry notice, and aborts on the fourth delay', async () => {
  let f;
  const silent = retry(1, 30000, 'stream_rule', true);
  const retries = four('rate_limit');
  f = fixture({ script: async function* ({ signal }) {
    yield silent;
    yield* retries.slice(0, 3);
    await Promise.resolve();
    f.time.advance(14_000);
    yield retries[3];
    await retrySleep(signal);
  } });
  await f.prompt(request, null, '', true);
  assert.deepEqual(logsOf(f, 'model_retry'), [silent, ...retries].map(({ reason, attempt, maxAttempts: max, delayMs }) => ({ kind: 'model_retry', turn: 1, reason, attempt, max, delayMs })));
  assert.equal(f.runs[0].signal.aborted, true);
  assert.equal(f.runs[0].finished, true);
  const line = stopLine('openai', 'rate limit');
  assert.deepEqual(f.spoken, [busyLine, line]);
  assert.deepEqual(eventsOf(f.ui, 'thinking').map((e) => e.text.trim()), [busyLine]);
  assert.deepEqual(eventsOf(f.ui, 'error').map((e) => e.message), [line]);
  assert.deepEqual(eventsOf(f.ui, 'done'), [], 'error path has no done chime');
  assert.deepEqual(logsOf(f, 'turn_note'), [{ kind: 'turn_note', turn: 1, how: 'retry' }]);
  assert.deepEqual(f.lifecycle, [['abort', 1], ['end', 2], ['turnEnded', 1]]);
  f.time.advance(14_000);
  assert.deepEqual(f.spoken, [busyLine, line], 'no progress after giving up');
  assert.equal(f.st.busy, false);
  assert.equal(f.viewGate.busy(), false);
});

test('voice resumes its full answer after retries, with no retry words in the reply', async () => {
  const f = fixture({ script: async function* () {
    yield retry(1, 30000, 'stream_rule', true);
    yield* four('overloaded').slice(0, 2);
    yield* reply('A short ', 'answer.');
  } });
  await f.prompt(request, null, '', true);
  assert.deepEqual(f.spoken, [busyLine, 'A short answer.']);
  assert.equal(textOf(f.ui), 'A short answer.');
  assert.equal(f.ui.at(-1).type, 'done');
  assert.equal(f.runs[0].signal.aborted, false);
});

test('relay logs and sends the actual model as a schema event', async () => {
  const f = fixture({ script: async function* () { yield* reply('Dentist.'); } });
  const { events, turn } = await relayRun(f);
  assert.deepEqual(logsOf(f, 'relay_drop'), [], 'the model event survives relay validation');
  assert.deepEqual(logsOf(f, 'relay_model'), [{ kind: 'relay_model', id: turn.id, model, effort: 'low', fallback: null }]);
  assert.deepEqual(events, [{ type: 'model', model, effort: 'low' }, { type: 'text', delta: 'Dentist.' }, { type: 'done' }]);
  assert.deepEqual(cleanEvent({ type: 'model', model, effort: 'ultra' }), []);
  assert.deepEqual(cleanEvent({ type: 'model', model, effort: 'low', fallback: 'unknown' }), []);
  const event = { type: 'model', model, effort: 'high' };
  const clean = cleanEvent(event);
  event.effort = 'ultra';
  assert.deepEqual(clean, [{ type: 'model', model, effort: 'high' }]);
});

test('a signed-in GPT relay does not need a Claude account', async () => {
  let claudeLookups = 0;
  const f = fixture({ script: async function* () { yield* reply('Dentist.'); } });
  f.st.claudeCodeRoute = async () => { claudeLookups++; return null; };
  const { events } = await relayRun(f);
  assert.equal(claudeLookups, 0);
  assert.equal(f.runs[0]?.provider, 'openai');
  assert.equal(textOf(events, 'delta'), 'Dentist.');
  assert.equal(events.at(-1).type, 'done');
});

test('a Claude relay still refuses a missing Claude account', async () => {
  let claudeLookups = 0;
  const f = fixture({ script: async function* () { yield* reply('Unexpected model.'); } });
  f.st.agentSettings.current.model = 'claude-opus-5-5';
  f.st.claudeCodeRoute = async (provider) => { assert.equal(provider, 'anthropic'); claudeLookups++; return null; };
  const { events } = await relayRun(f);
  assert.equal(claudeLookups, 1);
  assert.deepEqual(f.runs, []);
  assert.deepEqual(events, [{ type: 'error', code: 'mac_signed_out', message: 'Hydra Desktop is not signed in with Claude.' }]);
});

test('relay logs retries, closes the model tool, and emits the cap error without aborting the turn signal', async () => {
  const retries = [retry(1, 30000, 'context_overflow', true), ...four('provider_error')];
  const f = fixture({ script: async function* ({ signal }) { yield* retries; await retrySleep(signal); } });
  const { events, turn, sourceSignal } = await relayRun(f);
  assert.equal(f.runs[0].signal.aborted, true, 'the fourth retry cancels the running model');
  assert.deepEqual(logsOf(f, 'relay_retry'), retries.map(({ reason, attempt, delayMs }) => ({ kind: 'relay_retry', id: turn.id, reason, attempt, delayMs })));
  assert.deepEqual(toolsOf(events).map(([name, status]) => [name, status]), [['model', 'start'], ['model', 'done']]);
  assert.deepEqual(toolsOf(events)[0], modelStart('provider error'));
  assert.deepEqual(events.at(-1), { type: 'error', message: stopLine('openai', 'provider error') });
  assert.equal(f.runs[0].finished, true);
  assert.equal(sourceSignal.aborted, false);
  assert.equal(f.stopSignals[0].aborted, false);
  assert.equal(f.viewGate.busy(), false);
});

test('relay starts a fresh retry budget for the follow-up and closes each model tool before text', async () => {
  const f = fixture({ script: async function* (_, round) {
    yield retry(1, 16000, 'overloaded');
    if (round === 1) await wait(18);
    yield* reply(round === 1 ? 'Dentist.' : 'Gym.');
  } });
  const { events } = await relayRun(f, { inputs: [{ seq: 1, text: 'and Friday?' }] });
  assert.deepEqual(events.map((e) => e.type === 'tool' ? e.status : e.type), ['model', 'start', 'done', 'text', 'start', 'done', 'text', 'done']);
  assert.deepEqual(toolsOf(events).filter(([, status]) => status === 'start'), [modelStart('overloaded'), modelStart('overloaded')]);
  assert.equal(textOf(events, 'delta'), 'Dentist. Gym.');
  assert.equal(f.runs.length, 2);
  assert.ok(f.runs.every((r) => !r.signal.aborted && r.finished));
});

test('relay names an acknowledged follow-up that remains unanswered at the retry cap', async () => {
  const f = fixture({ script: async function* ({ signal }, round) {
    if (round === 1) {
      yield* reply('Dentist.');
      return;
    }
    yield* four('rate_limit');
    await retrySleep(signal);
  } });
  const { events } = await relayRun(f, { inputs: [{ seq: 1, text: 'and Friday?' }] });
  assert.deepEqual(f.runs.map((run) => run.signal.aborted), [false, true]);
  assert.ok(f.runs.every((run) => run.finished));
  assert.equal(f.runs[1].text, `${INPUT_PREFIX}and Friday?`);
  assert.equal(textOf(events, 'delta'), 'Dentist.');
  assert.deepEqual(events.at(-1), {
    type: 'error',
    message: `${stopLine('openai', 'rate limit')} What you added while I worked was not answered. Say it again.`,
  });
});

for (const route of ['voice', 'relay']) {
  test(`${route} logs an internal retry without announcing it`, async () => {
    const f = fixture({ script: async function* () {
      yield retry(1, 30000, 'stream_rule', true);
      yield* reply('Dentist.');
    } });
    const events = route === 'voice' ? (await f.prompt(request, null, '', true), f.ui) : (await relayRun(f)).events;
    assert.deepEqual(logsOf(f, route === 'voice' ? 'model_retry' : 'relay_retry').map((l) => l.reason), ['stream_rule']);
    assert.deepEqual(f.spoken, route === 'voice' ? ['Dentist.'] : []);
    assert.deepEqual(eventsOf(events, route === 'voice' ? 'thinking' : 'tool'), []);
    assert.equal(events.at(-1).type, 'done');
  });

  test(`${route} Stop wins when two retry events race with it`, async () => {
    let f;
    f = fixture({ script: async function* ({ signal }) {
      yield retry(1, 2000);
      yield retry(2, 4000);
      const sleep = retrySleep(signal);
      queueMicrotask(() => f.viewGate.stop());
      try { await sleep; } finally { yield retry(3, 30000); }
    } });
    const events = route === 'voice' ? (await f.prompt(request, null, '', true), f.ui) : (await relayRun(f)).events;
    assert.equal(logsOf(f, route === 'voice' ? 'model_retry' : 'relay_retry').length, 3, 'observed retries are logged even as Stop wins');
    assert.deepEqual(eventsOf(events, 'error').map((e) => e.message), [route === 'voice' ? 'Okay, stopping.' : 'Stopped.']);
    assert.ok(f.runs[0].signal.aborted && f.runs[0].finished);
    assert.equal(f.stopSignals[0].aborted, true);
    assert.deepEqual(f.spoken, route === 'voice' ? [busyLine] : []);
    if (route === 'relay') assert.deepEqual(toolsOf(events).map(([, status]) => status), ['start', 'done']);
    assert.equal(f.viewGate.busy(), false);
  });
}

for (const route of ['voice', 'relay']) {
  test(`${route} caps Claude Code SDK retries and closes the query`, async () => {
    const interruptions = [];
    const Claude = class extends ClaudeCodeAgent {
      constructor(options) {
        super({ ...options, keepWarm: false, query: ({ prompt }) => {
          const sdk = new AbortController();
          const stream = (async function* () {
            await prompt[Symbol.asyncIterator]().next();
            for (const { attempt, delayMs } of four('overloaded')) {
              yield { type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: delayMs, error_status: 529 };
            }
            await retrySleep(sdk.signal).catch(() => {});
          })();
          return Object.assign(stream, {
            interrupt: async () => { interruptions.push('interrupt'); sdk.abort(); },
            close: () => { interruptions.push('close'); sdk.abort(); },
          });
        } });
      }
    };
    const f = fixture({ provider: 'anthropic', chatgpt: false, Claude });
    const events = route === 'voice' ? (await f.prompt(request, null, '', true), f.ui) : (await relayRun(f)).events;
    assert.deepEqual(interruptions, ['interrupt', 'close']);
    assert.deepEqual(eventsOf(events, 'error').map((e) => e.message), [stopLine('anthropic', 'overloaded')]);
    if (route === 'relay') {
      assert.match(textOf(events, 'delta'), /not signed in on this Mac, so this answer is from Claude/);
      const route = gptRoute({ model, chatgpt: false });
      assert.deepEqual(eventsOf(events, 'model'), [{ type: 'model', model: route.model, effort: 'low', fallback: 'not_connected' }]);
      assert.deepEqual(logsOf(f, 'relay_drop'), []);
      assert.deepEqual(toolsOf(events)[0], modelStart('overloaded'));
    }
  });
}

test('Claude relay answers typed additions in the active SDK query', async () => {
  const messages = [];
  let queries = 0;
  const sdkEvent = (event) => ({ type: 'stream_event', parent_tool_use_id: null, event });
  const Claude = class extends ClaudeCodeAgent {
    constructor(options) {
      super({ ...options, keepWarm: false, query: ({ prompt }) => {
        queries++;
        const stream = (async function* () {
          const input = prompt[Symbol.asyncIterator]();
          messages.push((await input.next()).value);
          const added = await Promise.race([input.next(), wait(300, { done: true })]);
          if (added.done) throw new Error('The running Claude query did not receive the follow-up.');
          messages.push(added.value);
          yield sdkEvent({ type: 'message_start', message: { usage: {} } });
          yield sdkEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Dentist Thursday, gym Friday.' } });
          yield sdkEvent({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} });
          yield sdkEvent({ type: 'message_stop' });
          yield { type: 'result', subtype: 'success', is_error: false, result: 'ok' };
        })();
        return Object.assign(stream, { interrupt: async () => {}, close: () => {} });
      } });
    }
  };
  const f = fixture({ provider: 'anthropic', chatgpt: false, Claude });
  f.st.agentSettings.current.model = 'claude-opus-5-5';
  const { events, turn } = await relayRun(f, { inputs: [{ seq: 1, text: 'and Friday?' }] });
  assert.equal(queries, 1);
  assert.deepEqual(messages.map((m) => m.message.content.at(-1).text), [turnPrompt(turn).text, `${INPUT_PREFIX}and Friday?`]);
  assert.deepEqual(logsOf(f, 'relay_input').map((entry) => entry.at), [undefined]);
  assert.equal(textOf(events, 'delta'), 'Dentist Thursday, gym Friday.');
  assert.equal(events.at(-1).type, 'done');
});

test('a real rate-limit error still hands the local request to the next model', async () => {
  const f = fixture({ config: { backups: true }, script: async function* (_, round) {
    if (round > 1) { yield* reply('The backup answered.'); return; }
    yield retry(1, 2000);
    yield { type: 'error', error: Object.assign(new Error('Rate limit'), { status: 429 }) };
  } });
  f.st.chainOrder = () => [{ provider: 'anthropic', spec: 'anthropic:backup' }];
  f.st.explain = () => ({});
  f.st.routeForTurn = () => {
    if (f.st.retryInfo) Object.assign(f.st.config, { provider: 'anthropic', model: 'backup' });
    return null;
  };
  await f.prompt(request, null, '', true);
  await f.st.running;
  assert.equal(logsOf(f, 'limit')[0]?.kind, 'limit');
  assert.deepEqual(f.runs.map(({ provider, model: id }) => [provider, id]), [['openai', model], ['anthropic', 'backup']]);
  assert.deepEqual(eventsOf(f.ui, 'done')[0], { type: 'done', stopped: true });
  assert.deepEqual(eventsOf(f.ui, 'error'), []);
  assert.equal(f.spoken.at(-1), 'The backup answered.');
  assert.equal(f.runs[0].signal.aborted, false);
});

test('a backup model retry cannot adopt a replacement device pairing', async () => {
  let pair = 'device-a';
  const f = fixture({ config: { backups: true }, script: async function* (_, round) {
    if (round > 1) { yield* reply('Unexpected retry.'); return; }
    pair = 'device-b';
    yield { type: 'error', error: Object.assign(new Error('Rate limit'), { status: 429 }) };
  } });
  f.st.notePairing = () => pair;
  f.st.chainOrder = () => [{ provider: 'anthropic', spec: 'anthropic:backup' }];
  f.st.explain = () => ({});
  await f.enqueue(request, { image: { type: 'image', data: 'inert fixture' } });
  await f.st.running;
  assert.equal(f.runs.length, 1);
  assert.deepEqual(eventsOf(f.ui, 'error').map((e) => e.message), ['The device pairing changed. Ask again.']);
});
