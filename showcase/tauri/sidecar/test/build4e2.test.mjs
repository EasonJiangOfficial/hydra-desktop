// Desktop build 4 E2: Approve all on the Mac (owner: "also quitting apps, changing stuff requires approval, there
// should be a mode that approves all actions"; deletions still ask). The setting from /api/agent/state, the one rule
// (sidekick ask), the structured deletion tag on MCP, connector, relay and background-agent asks, the capability this
// build declares, and the danger words. Each block fails without its fix. Run: npm test (temp home; fakes only).
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roamies-e2-')));
process.env.HOME = process.env.USERPROFILE = tmp;
process.env.ROAMIES_DATA_DIR = path.join(tmp, 'data');
process.env.ROAMIES_FAKE_AGENT = fileURLToPath(new URL('./fakeagent.mjs', import.meta.url));
process.env.FAKE_LOG = path.join(tmp, 'fake.log');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const { SETTINGS_DEFAULTS, cleanSettings, createSettingsWatch } = await import('../agentsettings.mjs');
const { DANGER, hydraApi } = await import('../hydramcp.mjs');
const { APPROVE_CAPS, askAsApproval, createRelay } = await import('../relay.mjs');
const { approveAllSays, checkMcpCall, deletesCall, isYes, checkOpen, checkRead, checkWrite } = await import('../safety.mjs');
const { createMcpTools } = await import('../mcp.mjs');
const { brainGate } = await import('../brain-server.mjs');
const { relayApprovalSchema } = await import('../relayschema.mjs');

// ---- The setting: approveAll (camelCase or snake_case), a boolean, default off; anything else keeps the last value.
{
  assert.equal(SETTINGS_DEFAULTS.approveAll, false, 'off until the owner turns it on');
  assert.equal(cleanSettings({ settings: { approve_all: true } }).approveAll, true);
  assert.equal(cleanSettings({ settings: { approveAll: true } }).approveAll, true, 'camelCase too');
  for (const bad of ['true', 1, null, {}]) assert.equal(cleanSettings({ settings: { approve_all: bad } }, { ...SETTINGS_DEFAULTS, approveAll: true }).approveAll, true, `${JSON.stringify(bad)} keeps the last`);
  assert.equal(cleanSettings({ settings: {} }).approveAll, false, 'an older server sends none: off');
  // The watch reads it from GET /api/agent/state and tells the change.
  const changes = [];
  let body = { settings: { approve_all: true } };
  const w = createSettingsWatch({ api: { req: async () => ({ ok: true, json: async () => body }) }, onChange: (n, b) => changes.push([b.approveAll, n.approveAll]), setTimer: () => 1, clearTimer: () => {} });
  await w.start();
  assert.equal(w.current.approveAll, true);
  body = { settings: { approve_all: false } };
  await w.refresh();
  assert.deepEqual(changes, [[false, true], [true, false]]);
  w.stop();
}

// ---- The one rule (sidekick ask, the agents' asks): a yes/no tagged deletion: false only, and only when on.
{
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  const askFn = src.slice(src.indexOf('function ask(opts, signal) {'), src.indexOf('askQueued ??= oneYesNoAtATime(showAsk);'));
  // After the relay branch (a relay turn's asks stay server approvals), before anything is shown.
  assert.ok(askFn.indexOf('if (relayed?.live) return relayed.ask(opts, signal);') >= 0 && askFn.indexOf('if (autoYes(opts))') > askFn.indexOf('relayed?.live'), 'ask() says yes for Approve all after the relay branch');
  assert.match(src, /const autoYes = \(opts\) => approveAllSays\(approveAll\(\), opts\);/);
  assert.match(src, /const approveAll = \(\) => agentSettings\.current\.approveAll === true;/);
  assert.match(src, /approveAll: \(\) => approveAll\(\),/, 'the background agents get it');
  assert.match(src, /confirm: async \(question, signal\) => isYes\(await ask\(\{ placeholder: question, choices: \['Allow', "Don't allow"\], always: true, deletion: false \}, signal\)\),/, 'starting or copying from an agent is not a deletion');
  assert.match(src, /askSummary\(app, c\.tool, input\), choices: \['Allow', "Don't allow"\], always: true, deletion: deletesCall\(\{ name: c\.tool \}\) \}/, 'a connector call carries its tag');
  // Typed prompts never: the FORGET ask, keys, codes.
  assert.equal(approveAllSays(true, { placeholder: 'Type FORGET to erase everything I remember' }), false);
  assert.equal(approveAllSays(true, { prompt: 'Paste your API key', mask: true, deletion: false }), false);
  // A choice that is not a yes/no with a tag (the orb's Attach / Keep) is untagged: it asks.
  assert.equal(approveAllSays(true, { placeholder: 'The orb', choices: ['Attach to Hydra', 'Keep it here'] }), false);
}

// ---- What is a deletion for a connected server's call: its destructive hint or its name, never the question.
{
  for (const n of ['trash_message', 'delete_event', 'remove_label', 'send_message', 'drop_table', 'gmail_delete_draft', 'deleteEvent']) assert.equal(deletesCall({ name: n }), true, n);
  for (const n of ['create_event', 'update_event', 'list_messages', 'quit_app', 'open_page']) assert.equal(deletesCall({ name: n }), false, n);
  assert.equal(deletesCall({ name: 'tidy', annotations: { destructiveHint: true } }), true, 'the server says it destroys');
}

// ---- MCP connections: remove_connection and a destructive call are deletions; adding or a plain write is not.
{
  const asked = [];
  const ask = async (o) => { asked.push(o); return 'yes'; };
  const tools = { notes_update: { annotations: {}, execute: async () => 'ok' }, notes_delete: { annotations: {}, execute: async () => 'ok' }, tidy: { annotations: { destructiveHint: true }, execute: async () => 'ok' } };
  const m = { has: (n) => n === 'notes', remove: async () => {}, tool: async (s, t) => tools[t], importable: () => ({}), probe: async () => ({ ok: true }), add: async () => ({ ok: true, tools: [] }) };
  const T = Object.fromEntries(createMcpTools({ mcp: m, ask, isYes, userName: 'Ken', checkCall: checkMcpCall }).map((t) => [t.name, t]));
  await T.remove_connection.execute({ name: 'notes', reason: 'not used' }, {});
  for (const t of ['notes_update', 'notes_delete', 'tidy']) await T.use_connection.execute({ server: 'notes', tool: t, args: '{}' }, {});
  await T.add_connection.execute({ name: 'linear', url: 'https://mcp.linear.app/sse' }, {});
  assert.deepEqual(asked.map((o) => o.deletion), [true, false, true, true, false], asked.map((o) => o.placeholder).join(' | '));
}

// ---- A relay turn's ask: deletion from the tag (untagged: true), a deletion is dangerous, typed prompts answer null.
{
  const got = [];
  const asker = askAsApproval(async (a) => { got.push(a); return 'approved'; });
  assert.equal(await asker({ placeholder: 'Quit Xcode?', choices: ['Allow'], deletion: false }), 'yes');
  await asker({ placeholder: 'Remove the scheduled job "x"?', choices: ['Allow'], deletion: true });
  await asker({ placeholder: 'Bring Notes forward?', choices: ['Allow'] });
  assert.equal(await asker({ prompt: 'Paste the code' }), null, 'nobody here to type it');
  assert.deepEqual(got.map((a) => [a.deletion, a.danger]), [[false, false], [true, true], [true, true]], JSON.stringify(got));
  // The danger words cover the Mac's own wording too (Drop, Forget, Overwrite); what deletes is still the tag.
  for (const s of ['Drop "Call mum"?', 'Forget "likes tea"?', 'Overwrite /Users/x/a.txt?', 'Delete the skill "x"?']) assert.ok(DANGER.test(s), s);
  assert.ok(!DANGER.test('Quit Xcode?') && !DANGER.test('Open ui.elevenlabs.io?'));
}

// ---- The approval POST carries deletion from the tag and the capability; a caller that gives none sends true.
{
  const turn = { id: randomUUID(), claimId: randomUUID(), threadId: randomUUID(), surface: 'phone', input: { text: 'x' }, context: {} };
  let served = false;
  const posts = [], events = [];
  const api = { req: async (p, o) => {
    if (p.startsWith('/api/agent/relay/next')) { if (!served) { served = true; return { status: 200, ok: true, json: async () => ({ turn }) }; } await wait(20); return { status: 204, ok: true }; }
    if (p === '/api/agent/relay/events') { events.push(...o.body.events); return { status: 200, ok: true, json: async () => ({ ok: true }) }; }
    if (p === '/api/agent/relay/approval') { posts.push(o.body); return { status: 201, ok: true, json: async () => ({ id: randomUUID() }) }; }
    return { status: 404, ok: false, json: async () => ({}) };
  } };
  const relay = createRelay({ api, waitSecs: 1, flushMs: 1, slots: ['live'], sleep: (ms) => wait(Math.min(ms, 5)), waitFor: async () => 'approved',
    runTurn: async (t, { approve, emit }) => {
      await approve({ summary: 'Quit Xcode?', danger: false, deletion: false });
      await approve({ summary: 'Drop "x"?', deletion: true });
      await approve({ summary: 'Something?' });
      emit({ type: 'done' });
    } });
  relay.start();
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'done'); i++) await wait(10);
  await relay.stop();
  assert.deepEqual(posts.map((b) => [b.deletion, b.approveAllDeletionTags]), [[false, 1], [true, 1], [true, 1]], JSON.stringify(posts));
  assert.deepEqual(APPROVE_CAPS, { approveAllDeletionTags: 1 });
  // The shared schema (byte-identical with the web's) still takes the body: the new fields are extra, not wrong.
  for (const b of posts) assert.ok(relayApprovalSchema.safeParse(b).success);
}

// ---- Every request this build makes declares the capability.
{
  const seen = [];
  const api = hydraApi({ base: 'https://hydra.invalid', getKey: async () => 'k'.repeat(20), fetchImpl: async (url, o) => { seen.push(o.headers); return { ok: true }; } });
  await api.req('/api/agent/relay/next?wait=1&slot=live');
  await api.req('/api/agent/relay/approval', { method: 'POST', body: {} });
  assert.deepEqual(seen.map((h) => h['X-Hydra-Caps']), ['approveAllDeletionTags=1', 'approveAllDeletionTags=1']);
}

// ---- The server brain's connector gate tags its approvals the same way.
{
  const got = [];
  const gate = brainGate({ approve: async (a) => { got.push(a); return 'approved'; } });
  await gate('mcp__claude_ai_Gmail__trash_message', { id: '1' });
  await gate('mcp__claude_ai_Google_Calendar__create_event', { title: 'x' });
  assert.deepEqual(got.map((a) => a.deletion), [true, false], JSON.stringify(got));
}

// ---- A background agent's own asks (its process, the real worker): Approve all answers the non-deletions there and
// then; its overwrite still waits for the owner's yes on its row. Off: every one waits.
{
  const { agentsRoot, createAgents } = await import('../agents.mjs');
  async function runOne(approveAll) {
    const events = [];
    let onEnd = null;
    fs.writeFileSync(process.env.FAKE_LOG, '');
    const mgr = createAgents({
      fork, root: agentsRoot(), userName: 'Ken', home: tmp, runner: fileURLToPath(new URL('../agentrun.mjs', import.meta.url)), safety: { checkRead, checkWrite, checkOpen },
      config: { model: async () => ({ provider: 'anthropic', model: 'fake', route: 'api' }), creds: async () => ({}), allowActions: () => true, image: () => null, open: async () => {}, reveal: async () => {}, approveAll: () => approveAll },
      ui: ({ e }) => {
        if (!e) return;
        events.push(e);
        if (e.type === 'ask') setTimeout(() => mgr.answer(e.agent.id, true), 30);
        if (e.type === 'done' || e.type === 'fail' || e.type === 'gone') onEnd?.(e);
      },
    });
    const end = new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error(`no result: ${JSON.stringify(events.map((e) => e.type))}`)), 20_000); onEnd = (e) => { clearTimeout(t); resolve(e); }; });
    const a = await mgr.start({ type: 'maker', title: `Dog page ${approveAll}`, brief: 'Make a landing page for Woof Co.' });
    const e = await end;
    assert.equal(e.type, 'done', e.agent?.reason);
    return { a, asks: events.filter((x) => x.type === 'ask').map((x) => x.agent.ask.question) };
  }
  const on = await runOne(true);
  assert.deepEqual(on.asks, [`Overwrite ${path.join(on.a.dir, 'files', 'index.html')}?`], 'on: only the overwrite waits');
  assert.equal(fs.readFileSync(path.join(on.a.dir, 'files', 'index.html'), 'utf8'), '<h1>Woof Co</h1>');
  const off = await runOne(false);
  assert.deepEqual(off.asks, [`Create ${path.join(off.a.dir, 'files', 'index.html')}?`, `Overwrite ${path.join(off.a.dir, 'files', 'index.html')}?`, `Create ${path.join(off.a.dir, 'work', 'build.sh')}?`], 'off: every one waits');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('build 4 E2 (approve all): ok');
