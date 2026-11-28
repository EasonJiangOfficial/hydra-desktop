import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { test } from 'node:test';
import { createBrainTurn } from '../brain-server.mjs';
import { createToolBridge } from '../claudecode.mjs';
import { createHydraTools } from '../hydramcp.mjs';
import { cleanEvent, routineCallIdentity } from '../relay.mjs';

const approved = randomUUID();
const first = { turnId: randomUUID(), claimId: randomUUID(), callId: randomUUID() };
const second = { ...first, callId: randomUUID() };

const toolUse = (id, note) => ({ type: 'tool_use', id, name: 'mcp__gg__hydra_remember', input: { note } });
const assistant = (id, ...content) => ({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', content, stop_reason: 'tool_use' } });
const toolEcho = (tool_use_id, content, is_error = false) => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id, content, is_error }] },
});

function fixture(toolName = 'remember') {
  const requests = [];
  const api = { async req(path, { body }) {
    if (path.startsWith('/api/agent/relay/approval?')) return Response.json({ status: 'approved' });
    assert.equal(path, '/api/mcp/agent');
    requests.push(body);
    const result = body.method === 'tools/list'
      ? { tools: [{ name: toolName, inputSchema: { type: 'object', properties: { approvalId: {}, note: {} } } }] }
      : body.params.arguments.note === 'first' && !body.params.arguments.approvalId
        ? { structuredContent: { needsApproval: true, approvalId: approved, summary: 'Save the note', danger: false } }
        : { content: [{ type: 'text', text: 'Saved' }] };
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  } };
  return { hydra: createHydraTools({ api }), requests };
}

test('pairs a confirmation and approved retry with their own call while a sibling finishes first', async () => {
  const { hydra, requests } = fixture();
  const confirms = [];
  const waiting = Promise.withResolvers();
  const answer = Promise.withResolvers();
  await hydra.refresh();
  const [tool] = hydra.tools({
    routineCall: (id) => ({ first, second })[id],
    onConfirm: (confirm) => confirms.push(cleanEvent({ type: 'confirm', ...confirm })),
    waitFor: () => { waiting.resolve(); return answer.promise; },
  });
  assert.equal(tool.rawInputSchema.properties.approvalId, undefined);
  const pending = tool.execute({ note: 'first', approvalId: 'wrong' }, { toolCallId: 'first' });
  await waiting.promise;
  assert.equal(await tool.execute({ note: 'second' }, { toolCallId: 'second' }), 'Saved');
  answer.resolve('approved');
  assert.equal(await pending, 'Saved');
  assert.deepEqual(requests.slice(1).map(({ params }) => params), [
    { name: 'remember', arguments: { note: 'first' }, _meta: { 'hydra/routine-call': first } },
    { name: 'remember', arguments: { note: 'second' }, _meta: { 'hydra/routine-call': second } },
    { name: 'remember', arguments: { note: 'first', approvalId: approved }, _meta: { 'hydra/routine-call': first } },
  ]);
  assert.deepEqual(confirms, [[{ type: 'confirm', id: approved, summary: 'Save the note', danger: false, callId: first.callId }]]);
});

test('keeps standalone and legacy MCP arguments and confirmations intact', async () => {
  const { hydra, requests } = fixture();
  const confirms = [];
  await hydra.refresh();
  const [tool] = hydra.tools({ onConfirm: (confirm) => confirms.push(confirm), waitFor: async () => 'declined' });
  await assert.rejects(tool.execute({ note: 'first' }, { toolCallId: 'first' }), /owner said no/);
  assert.deepEqual(requests[1].params, { name: 'remember', arguments: { note: 'first' } });
  assert.deepEqual(confirms, [{ id: approved, summary: 'Save the note', danger: false }]);
  assert.equal(requests.length, 2);
});

for (const providerId of [undefined, 'provider-call-id']) test(
  `Claude bridge keeps the same audit receipt on replay (${providerId ?? 'fallback'})`,
  async () => {
    const { hydra, requests } = fixture();
    await hydra.refresh();
    const routineCall = routineCallIdentity({ ...first, id: first.turnId, surface: 'routine', routineCallEvidence: true });
    const events = [];
    const bridge = createToolBridge({ tools: hydra.tools({ routineCall }), onEvent: (event) => events.push(event) });
    let respond;
    const transport = { onmessage: undefined, async send(reply) { respond(reply); } };
    await bridge.config.instance.connect(transport);
    const rpc = (id) => new Promise((resolve) => {
      respond = resolve;
      transport.onmessage({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: {
          name: 'hydra_remember', arguments: { note: 'second' },
          ...(providerId && { _meta: { 'claudecode/toolUseId': providerId } }),
        },
      });
    });
    assert.deepEqual((await rpc(1)).result.content, [{ type: 'text', text: 'Saved' }]);
    assert.deepEqual((await rpc(providerId ? 2 : 1)).result.content, [{ type: 'text', text: 'Saved' }]);
    const [firstRequest, replayRequest] = requests.slice(1);
    assert.deepEqual(firstRequest.params._meta, replayRequest.params._meta);
    const callIds = events.map((event) => routineCall(event.toolInvocationId).callId);
    assert.equal(new Set(callIds).size, 1);
    assert.equal(callIds[0], firstRequest.params._meta['hydra/routine-call'].callId);
  },
);

for (const variant of ['fallback', 'provider', 'legacy']) test(
  `Claude gives each held prompt invocation its own receipt (${variant})`,
  async () => {
    const enabled = variant !== 'legacy';
    const { hydra, requests } = fixture();
    await hydra.refresh();
    const prompts = [];
    const resumedSessions = [];
    const query = ({ prompt, options }) => Object.assign((async function* () {
      const input = await prompt[Symbol.asyncIterator]().next();
      prompts.push(input.value.message.content.map((part) => part.text).join("\n"));
      resumedSessions.push(options.resume);
      yield { type: 'system', subtype: 'init', session_id: 'fixture-claude-session' };
      let respond;
      const transport = { onmessage: undefined, async send(reply) { respond(reply); } };
      await options.mcpServers.gg.instance.connect(transport);
      yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
      yield assistant('msg-tool', toolUse('provider-call-id', 'first'));
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } } };
      const rpc = new Promise((resolve) => {
        respond = resolve;
        transport.onmessage({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: {
            name: 'hydra_remember', arguments: { note: 'first' },
            ...(variant !== 'fallback' && { _meta: { 'claudecode/toolUseId': 'provider-call-id' } }),
          },
        });
      });
      const reply = await rpc;
      assert.deepEqual(reply.result.content, [{ type: 'text', text: 'Saved' }]);
      yield toolEcho('provider-call-id', reply.result.content);
      yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Saved' };
    })(), { interrupt: async () => {}, close: () => {} });
    const run = createBrainTurn({ hydraTools: hydra, cwd: os.tmpdir(), query });
    const turn = { id: randomUUID(), claimId: randomUUID(), surface: 'routine', input: { text: 'Save fixture' }, ...(enabled && { routineCallEvidence: true }) };
    const events = [];
    let rounds = 0;
    await run(turn, {
      emit: (event) => events.push(...cleanEvent(event)),
      signal: new AbortController().signal,
      done: async () => ++rounds === 1 ? ['Save the second note too.'] : [],
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Save the second note too/);
    assert.deepEqual(resumedSessions, [undefined, 'fixture-claude-session']);
    const tools = events.filter((event) => event.type === 'tool' || event.type === 'confirm');
    assert.deepEqual(tools.filter((event) => event.type === 'tool').map((event) => event.status), ['start', 'done', 'start', 'done']);
    assert.equal(tools.filter((event) => event.type === 'confirm').length, 2);
    const calls = requests.slice(1).map((request) => request.params);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map((call) => call.arguments.approvalId), [undefined, approved, undefined, approved]);
    if (enabled) {
      const origins = [calls[0], calls[2]].map((call) => call._meta['hydra/routine-call']);
      assert.notEqual(origins[0].callId, origins[1].callId, 'each real invocation has its own receipt');
      for (const [i, origin] of origins.entries()) {
        assert.match(origin.callId, /^[0-9a-f-]{36}$/);
        assert.deepEqual(origin, { turnId: turn.id, claimId: turn.claimId, callId: tools[i * 3].callId });
        assert.deepEqual(tools.slice(i * 3, i * 3 + 3).map((event) => event.callId), Array(3).fill(origin.callId));
        assert.deepEqual(calls[i * 2 + 1]._meta, calls[i * 2]._meta);
      }
    } else {
      assert.ok(calls.every((call) => !('_meta' in call)));
      assert.ok(tools.every((event) => !('callId' in event)));
    }
  },
);


test('Claude counts overlapping identical bridge calls once each despite late and repeated SDK echoes', async () => {
  const { hydra, requests } = fixture();
  await hydra.refresh();
  const query = ({ prompt, options }) => Object.assign((async function* () {
    await prompt[Symbol.asyncIterator]().next();
    const waiting = new Map();
    const transport = { onmessage: undefined, async send(reply) { waiting.get(reply.id)(reply); } };
    await options.mcpServers.gg.instance.connect(transport);
    const rpc = (id) => new Promise((resolve) => {
      waiting.set(id, resolve);
      transport.onmessage({
        jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'hydra_remember', arguments: { note: 'second' } },
      });
    });
    yield assistant('msg-overlap', toolUse('provider-first', 'second'), toolUse('provider-second', 'second'));
    const [resultA, resultB] = await Promise.all([rpc(1), rpc(2)]);
    assert.deepEqual(resultA.result.content, resultB.result.content);
    yield toolEcho('provider-second', resultB.result.content);
    yield toolEcho('provider-second', resultB.result.content);
    yield toolEcho('provider-first', resultA.result.content);
    yield assistant('msg-denied', toolUse('provider-denied', 'second'));
    yield toolEcho('provider-denied', [{ type: 'text', text: 'Refused by the SDK before execution' }], true);
    yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
    yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } };
    yield { type: 'result', subtype: 'success', is_error: false, result: 'Saved' };
  })(), { interrupt: async () => {}, close: () => {} });
  const run = createBrainTurn({ hydraTools: hydra, cwd: os.tmpdir(), query });
  const turn = { id: randomUUID(), claimId: randomUUID(), surface: 'routine', input: { text: 'Save the fixture twice' }, routineCallEvidence: true };
  const events = [];
  await run(turn, { emit: (event) => events.push(...cleanEvent(event)), signal: new AbortController().signal });
  const origins = requests.slice(1).map((request) => request.params._meta['hydra/routine-call'].callId);
  assert.equal(origins.length, 2);
  assert.notEqual(origins[0], origins[1]);
  const tools = events.filter((event) => event.type === 'tool');
  assert.deepEqual(tools.filter((event) => event.status === 'done').map((event) => event.callId).sort(), [...origins].sort());
  assert.deepEqual(tools.filter((event) => event.status === 'error').map((event) => event.summary), ['Refused by the SDK before execution']);
});


const transcriptCases = [
  { batch: false, refusalFirst: false, sameName: true, provider: false, duplicate: true, held: true },
  { batch: false, refusalFirst: true, sameName: true, provider: true, duplicate: false, held: false },
  { batch: false, refusalFirst: false, sameName: false, provider: true, duplicate: false, held: false },
  { batch: true, refusalFirst: false, sameName: true, provider: true, duplicate: true, held: false },
  { batch: true, refusalFirst: true, sameName: false, provider: false, duplicate: false, held: false },
];

for (const variant of transcriptCases) test(
  `Claude keeps refusal naming across ${variant.batch ? 'batched' : 'split'} results, ${variant.refusalFirst ? 'refusal' : 'success'} first, ${variant.sameName ? 'same' : 'distinct'} tools`,
  async () => {
    const { hydra, requests } = fixture('get_planning');
    await hydra.refresh();
    const deniedTool = variant.sameName ? 'get_planning' : 'get_layouts';
    const readArgs = { note: 'second' }, deniedArgs = { note: 'Unreachable board' };
    const sdkCall = (id, tool, input) => ({ type: 'tool_use', id, name: `mcp__gg__hydra_${tool}`, input });
    const prompts = [];
    const query = ({ prompt, options }) => Object.assign((async function* () {
      await prompt[Symbol.asyncIterator]().next();
      prompts.push(options.resume);
      yield { type: 'system', subtype: 'init', session_id: 'receipt-transcript-session' };
      yield assistant('receipt-message', sdkCall('sdk-read', 'get_planning', readArgs), sdkCall('sdk-denied', deniedTool, deniedArgs));
      const response = Promise.withResolvers();
      const transport = { onmessage: undefined, async send(reply) { response.resolve(reply); } };
      await options.mcpServers.gg.instance.connect(transport);
      transport.onmessage({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: {
          name: 'hydra_get_planning', arguments: readArgs,
          ...(variant.provider && { _meta: { 'claudecode/toolUseId': 'sdk-read' } }),
        },
      });
      const { result } = await response.promise;
      const success = toolEcho('sdk-read', result.content);
      const refusal = toolEcho('sdk-denied', [{ type: 'text', text: 'Refused before execution' }], true);
      const reports = variant.refusalFirst ? [refusal, success] : [success, refusal];
      if (variant.batch) yield { type: 'user', message: { role: 'user', content: reports.flatMap((report) => report.message.content) } };
      else yield* reports;
      if (variant.duplicate) yield success;
      yield { type: 'stream_event', event: { type: 'message_start', message: { usage: {} } } };
      yield { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } };
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Read one board' };
    })(), { interrupt: async () => {}, close: () => {} });
    const run = createBrainTurn({ hydraTools: hydra, cwd: os.tmpdir(), query });
    const turn = { id: randomUUID(), claimId: randomUUID(), surface: 'routine', input: { text: 'Read two boards' }, routineCallEvidence: true };
    const events = [];
    let rounds = 0;
    await run(turn, {
      emit: (event) => events.push(...cleanEvent(event)),
      signal: new AbortController().signal,
      done: async () => ++rounds === 1 && variant.held ? ['Check again after this note'] : [],
    });
    assert.deepEqual(prompts, variant.held ? [undefined, 'receipt-transcript-session'] : [undefined]);
    const calls = requests.slice(1);
    assert.equal(calls.length, variant.held ? 2 : 1);
    assert.ok(calls.every(({ params }) => params.name === 'get_planning'));
    const tools = events.filter((event) => event.type === 'tool');
    const successes = tools.filter((event) => event.status === 'done');
    assert.deepEqual(successes.map((event) => [event.name, event.callId]), calls.map(({ params }) => [
      'hydra_get_planning', params._meta['hydra/routine-call'].callId,
    ]));
    const refusals = tools.filter((event) => event.status === 'error');
    assert.equal(refusals.length, calls.length);
    assert.ok(refusals.every((event) => event.name === `hydra_${deniedTool}` && event.summary === 'Refused before execution'),
      JSON.stringify(refusals.map(({ name, summary }) => ({ name, summary }))));
    assert.equal(new Set([...successes, ...refusals].map((event) => event.callId)).size, calls.length * 2);
    assert.ok(refusals.every((event) => tools.some((start) =>
      start.status === 'start' && start.name === event.name && start.callId === event.callId)));
  },
);
