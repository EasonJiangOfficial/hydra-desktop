// Desktop build 4, the lane E fix round: each check fails without its fix.
// - asks in a voice turn: a take never answers a yes/no "no" by opening (overlay), only a take that started after the
//   question can answer it, a yes that names the action counts, an ask never said is never answered by voice, a take
//   opens after the question is said, the first line (the target) is said;
// - progress lines pause at an answer and resume when the run works on; only the owner's own turns get them and the
//   pending sound; no news while asleep;
// - the strict sleep word is the whole take; a take that hears nothing mid-turn says nothing;
// - Approve all: a Delete key, a sign-in read, a password manager, an unclassified connector or MCP call and an
//   overwrite verb still ask; nothing is a yes after Stop; the capability header and schema match the web contract;
// - folds: a tiny first request never parks the cut, question endings, Stop during the fold wait, the newest
//   screenshots kept, no addition lost to the context count;
// - an orb tap mid-take sends it.
// Run: npm test
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ROAMIES_DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'b4fix-'));
const { askForTake, ownTurn, spokenAnswer, spokenQuestion, startProgress, trackAsk, ASK_DEADLINE_MS } = await import('../voiceturn.mjs');
const { heardSleepWord } = await import('../power.mjs');
const { canNudge } = await import('../agents.mjs');
const { checkRead, checkWindow, deletesCall, deletesKey } = await import('../safety.mjs');
const { CAPABILITIES_HEADER, capabilitiesSchema, relayApprovalSchema } = await import('../relayschema.mjs');
const { CAPABILITIES, hydraApi } = await import('../hydramcp.mjs');
const S = await import('../store.mjs');
const { ClaudeCodeAgent } = await import('../claudecode.mjs');
const { agentEvents } = await import('../agentstream.mjs');

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const side = read('../sidekick.mjs'), tools = read('../tools.mjs'), host = read('../../../roamies/host.js');
const mainRs = read('../../src-tauri/src/main.rs'), voiceSwift = read('../../src-tauri/voice/main.swift');

function fakeClock() {
  let t = 0, timers = [];
  return {
    now: () => t,
    setTimer: (f, ms) => { const h = { f, at: t + ms }; timers.push(h); return h; },
    clearTimer: (h) => { timers = timers.filter((x) => x !== h); },
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const next = timers.filter((h) => h.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        t = next.at; timers = timers.filter((h) => h !== next); next.f();
      }
      t = end;
    },
  };
}

// ---- 1. The detached orb: a take opening keeps a yes/no open (the sidecar closes it when the take answers it).
{
  assert.match(host, /if \(ask && !ask\.choices\) finishAsk\(null\);\n      endTalk\(\);/, 'listening never answers a yes/no no');
  assert.doesNotMatch(host, /dropAutoListen\(\);\n      if \(ask\) finishAsk\(null\);/);
}

// ---- 2. Only a take that started after the question was shown answers it ("okay thanks" from before means else).
{
  const c = fakeClock();
  const voice = { progress: () => true };
  c.advance(1000);
  const a = trackAsk({ id: 'a1', route: 'overlay', question: 'Open ui.elevenlabs.io?', choices: true, voice, resolve: () => {}, ...c });
  const open = new Map([['a1', { a }]]);
  assert.equal(askForTake(open, { text: 'okay thanks', takeAt: 500 }), null, 'a take from before the ask never answers it');
  assert.equal(askForTake(open, { text: 'yes', takeAt: null }), null, 'nor one whose start is unknown');
  // Lane E round 2: shown is not heard. Only a take that started once its question had played answers it.
  assert.equal(askForTake(open, { text: 'okay thanks', takeAt: 1200 }), null, 'a take before its question played never does');
  a.audio(3, 4000);
  assert.equal(askForTake(open, { text: 'okay thanks', takeAt: 3999 }), null, 'nor one that started while it played');
  assert.equal(askForTake(open, { text: 'okay thanks', takeAt: 4000 })?.said, 'yes', 'a take after it played does');
  assert.equal(askForTake(open, { text: 'open Chrome instead', takeAt: 4200 }), null, 'other words are for the turn');
}

// ---- 3. A clear yes that names the action, or with fillers, is a yes; mixed or other words are not.
{
  const q = 'Open ui.elevenlabs.io?';
  for (const t of ['yes open it', 'yes you can', 'sure go ahead and open it', 'yeah open it', 'go for it', 'yes I do', 'please do', 'yes open ui.elevenlabs.io']) assert.equal(spokenAnswer(t, q), 'yes', t);
  for (const t of ["no don't open it", 'no thanks', 'nope']) assert.equal(spokenAnswer(t, q), 'no', t);
  for (const t of ['yes but open chrome instead', 'okay now open notes', 'open it in chrome', 'I told you no yes']) assert.equal(spokenAnswer(t, q), null, t);
}

// ---- 4. Progress lines pause at an answer and come back when the run works on (an addition's tools).
{
  const c = fakeClock(), said = [];
  const voice = { beat: () => { said.push('beat'); return true; }, progress: (l) => { said.push(l); return true; } };
  const p = startProgress({ voice, live: () => true, random: () => 0, ...c });
  c.advance(1100); assert.deepEqual(said, ['beat']);
  p.pause();
  c.advance(60_000); assert.deepEqual(said, ['beat'], 'nothing over the answer');
  p.resume();
  c.advance(5_500); assert.equal(said.length, 2, 'a progress line once the run works on again');
  c.advance(5_500); assert.equal(said.length, 3);
  p.stop(); p.resume(); c.advance(60_000); assert.equal(said.length, 3, 'stopped (the turn ended) stays stopped');
  assert.match(side, /else if \(e\.type === 'tool_call_start'\) \{\n        progress\.resume\(\);/, 'a tool after the answer resumes it');
  assert.match(side, /e\.type === 'server_tool_call' && \(progress\.resume\(\),/);
  assert.match(side, /if \(e\.stopReason !== 'tool_use'\) progress\.pause\(\);/);
}

// ---- 5. An ask the voice never said is not voiced; one whose turn voice ended stops being voiced.
{
  const c = fakeClock(), said = [];
  const gone = { progress: (l) => { said.push(l); return false; } };
  let got;
  const a = trackAsk({ id: 'a1', route: 'panel', question: 'Forget "x"?', choices: true, voice: gone, resolve: (v) => { got = v; }, ...c });
  assert.equal(a.voiced, false, 'the voice refused it: not voiced');
  assert.equal(askForTake(new Map([['a1', { a }]]), { text: 'yes', takeAt: 10 }), null, 'so no spoken yes answers it');
  c.advance(ASK_DEADLINE_MS);
  assert.equal(got, null); assert.equal(said.length, 1, 'and its expiry says nothing');
  const live = { progress: (l) => { said.push(l); return true; } };
  const b = trackAsk({ id: 'b1', route: 'panel', question: 'Open Mail?', choices: true, voice: live, resolve: () => {}, ...c });
  assert.equal(b.voiced, true);
  b.unvoice();
  assert.equal(b.voiced, false);
  assert.match(side, /for \(const \[, w\] of yesNoOpen\) if \(w\.voice && w\.voice === voice\) w\.a\.unvoice\(\);/, 'the turn ending unvoices its asks');
}

// ---- 6. After the question is said a take opens (once its audio has played: askArm, build4efix2), so a bare "yes" is
// heard. The helper's afterVoice path stays for older sidecars.
{
  assert.match(side, /w\.took = true; askTake = \{ id \}; send\(\{ type: 'listen', via: 'ask', wait: 8 \}\);/);
  assert.doesNotMatch(side, /afterVoice: true/, 'not on any quiet gap: on its own audio');
  assert.match(mainRs, /"afterVoice": msg\.get\("afterVoice"\)\.and_then\(Value::as_bool\) == Some\(true\)/, 'the shell passes it on');
  assert.match(voiceSwift, /if after \{ voice\.listenAfterVoice\(wait: wait, via: via\) \}/, 'the helper waits for the voice');
}

// ---- 7. While a turn runs, the sleep word is the whole take (fillers aside).
{
  for (const t of ['I told hydra sleep is important', 'hydra sleep mode docs please']) assert.equal(heardSleepWord(t, 'Hydra, sleep', { strict: true }), false, t);
  for (const t of ['Hydra, sleep.', 'okay hydra sleep now']) assert.equal(heardSleepWord(t, 'Hydra, sleep', { strict: true }), true, t);
  assert.equal(heardSleepWord('I told hydra sleep is important', 'Hydra, sleep'), true, 'idle it still matches anywhere');
}

// ---- 8. A take that hears nothing while a turn runs says nothing over it.
{
  assert.match(side, /else if \(m\.code === 'nothing_heard' && busy\) logLine\('nothing_heard', \{ busy: true \}\);\n    else if \(m\.code === 'nothing_heard'\) say\(/);
}

// ---- 9. A Delete key (with or without cmd) makes the plan a deletion, so Approve all asks.
{
  for (const k of ['delete', 'backspace', 'forwarddelete', 'cmd+delete', 'shift+delete']) assert.equal(deletesKey(k), true, k);
  for (const k of ['return', 'a', 'cmd+s', 'tab']) assert.equal(deletesKey(k), false, k);
  assert.match(tools, /deletion: notes\.length > 0 \|\| mapped\.some\(\(s\) => s\.do === 'key' && deletesKey\(s\.key\)\)/);
}

// ---- 10. After Stop (an aborted signal) an ask is a no before Approve all could say yes.
{
  const at = (re) => side.search(re);
  assert.ok(at(/if \(signal\?\.aborted\) return Promise\.resolve\(null\);/) > 0);
  assert.ok(at(/if \(signal\?\.aborted\) return Promise\.resolve\(null\);/) < at(/if \(autoYes\(opts\)\) \{ logLine\('ask_auto'/), 'checked first');
}

// ---- 11. The capability header is the web contract's, on every request; the schema is the web's.
{
  assert.equal(CAPABILITIES_HEADER, 'x-hydra-capabilities');
  assert.equal(CAPABILITIES, '{"approveAllDeletionTags":1}');
  const seen = [];
  const api = hydraApi({ base: 'https://hydra.invalid', getKey: async () => 'k'.repeat(20), fetchImpl: async (u, o) => { seen.push(o.headers); return { ok: true }; } });
  await api.req('/api/agent/relay/next?wait=1&slot=live');
  await api.req('/api/agent/jobs');
  for (const h of seen) assert.deepEqual(capabilitiesSchema.parse(h[CAPABILITIES_HEADER]), { approveAllDeletionTags: 1 });
  const ok = relayApprovalSchema.safeParse({ turnId: crypto.randomUUID(), claimId: crypto.randomUUID(), summary: 'Trash it?', danger: true, deletion: true });
  assert.equal(ok.success, true); assert.equal(ok.data.deletion, true, 'deletion is a schema field');
}

// ---- 12. A sign-in file read and a password manager's window: Approve all never answers them.
{
  const home = '/Users/k';
  const hidden = checkRead(`${home}/.config/anthropic/key.txt`, home);
  assert.equal(hidden.secret, true);
  assert.equal(checkRead(`${home}/Documents/a.txt`, home).secret, undefined);
  assert.equal(checkWindow({ app: '1Password', title: 'All Items' }, home).secret, true);
  assert.equal(checkWindow({ app: 'Safari', title: 'Orbs' }, home).secret, undefined);
  assert.match(tools, /confirm\(v\.reason, ctx, \{ deletion: !!v\.secret \}\)/, 'readable tags it');
  assert.match(tools, /confirm\(asks\.join\('\\n'\), ctx, \{ deletion: secret \}\)/, 'windowShows tags it');
}

// ---- 13. Connector and MCP calls: unclassified or overwrite-class is a deletion.
{
  for (const n of ['write_file', 'edit_file', 'update_file', 'overwrite_file', 'clear_values', 'discard_draft', 'update_draft', 'update_event', 'modify_labels', 'batch_modify', 'unlabel_message']) {
    assert.equal(deletesCall({ name: n }), true, n);
    assert.equal(deletesCall({ name: n, annotations: { destructiveHint: false } }), true, `${n}: its verb overwrites, whatever the hint`);
  }
  assert.equal(deletesCall({ name: 'create_event' }), true, 'no hint: unknown is a deletion');
  assert.equal(deletesCall({ name: 'search_threads', annotations: { readOnlyHint: true } }), false, 'a server that says it only reads');
}

// ---- 14. A deletion ask says its target aloud (its first line), the details point at the screen.
{
  assert.equal(spokenQuestion('Forget "likes green tea"?\n\nWhy: you said you stopped'), 'Can I forget "likes green tea"? The details are on the screen. Say yes or no.');
  assert.equal(spokenQuestion('Remove the scheduled job "Daily"?\n\nWhy: done'), 'Can I remove the scheduled job "Daily"? The details are on the screen. Say yes or no.');
}

// ---- 15. A tiny first request never parks the cut: the chat still folds.
{
  let n = 0;
  const req = (u, results) => {
    const i = ++n, out = [{ role: 'user', content: `r${i} ${'u'.repeat(u)}` }];
    results.forEach((c, j) => { out.push({ role: 'assistant', content: [{ type: 'tool_call', id: `c${i}_${j}`, name: 'read_page', args: {} }] }); out.push({ role: 'tool', content: [{ type: 'tool_result', toolCallId: `c${i}_${j}`, content: 'w'.repeat(c) }] }); });
    out.push({ role: 'assistant', content: [{ type: 'text', text: `Done. (r${i})` }] });
    return out;
  };
  const A = [...req(200, [1000]), ...req(200, [162000]), ...Array.from({ length: 10 }, () => req(300, [6000])).flat()];
  const scale = 120_000 / S.approxTokens(A);
  const p = S.planFold(A, { trigger: 90_000, scale, foldCap: 40_000 });
  assert.equal(p.ok, true, `it folds (was: ${p.reason})`);
  // With a cut that fits under the cap and is worth a fold, that one is taken.
  n = 0;
  const B = Array.from({ length: 14 }, () => req(300, [9000])).flat();
  const q = S.planFold(B, { trigger: 90_000, scale: 120_000 / S.approxTokens(B), foldCap: 20_000 });
  assert.ok(q.ok && S.approxTokens(q.folded) <= 20_000, 'the cap holds when a cut fits');

  // ---- 16. No cut right after a question, whatever its last line looks like.
  for (const ending of ['Should I open it in Safari or Chrome? (Say yes or no.)', 'Which one?\n1. Safari\n2. Chrome', 'Want me to open it? 🙂']) {
    n = 0;
    const C = Array.from({ length: 12 }, () => req(300, [6000])).flat();
    const s = 120_000 / S.approxTokens(C);
    const plain = S.planFold(C, { trigger: 90_000, scale: s });
    const Q = C.map((m) => ({ ...m })); Q[plain.end - 1] = { role: 'assistant', content: [{ type: 'text', text: ending }] };
    assert.notEqual(S.planFold(Q, { trigger: 90_000, scale: s }).end, plain.end, JSON.stringify(ending));
  }
}

// ---- 17. Stop or the sleep word during the fold wait end it; the wait plays the pending sound.
{
  assert.match(side, /const wait = foldWait = new AbortController\(\);/);
  assert.match(side, /else if \(foldWait\) \{ logLine\('stopped', \{ by, waiting: 'fold' \}\); foldWait\.abort\('sleep'\); \}/, 'sleep ends it');
  assert.match(side, /controller\?\.abort\(\); foldWait\?\.abort\(\);/, 'Stop ends it');
  assert.match(side, /if \(wait\.signal\.aborted\) \{[\s\S]{0,300}return;\n    \}/, 'and the request never runs');
  assert.match(side, /const on = \(!!foldWait && foldWaitOwn && !voiceBusy && VOICE_ON\(\) && yesNoOpen\.size === 0 && !power\.asleep\) \|\| pendingWanted/, 'never a silent wait (for his own request)');
}

// ---- 18. A fold keeps the newest 3 screenshots for the re-seeded session.
{
  const img = (d) => ({ type: 'image', data: d, mimeType: 'image/png' });
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'a' }, img('A')] },
    ...['B', 'C', 'D'].map((d, i) => ({ role: 'tool', content: [{ type: 'tool_result', toolCallId: `c${i}`, content: [img(d)] }] })),
  ];
  assert.deepEqual(S.newestImages(msgs).map((p) => p.data), ['B', 'C', 'D']);
  assert.match(side, /foldImages = agent \? newestImages\(agent\.getMessages\(\)\) : null;/);
  assert.match(side, /: kept \? \[\{ type: 'text', text: sent \}, \.\.\.keptNote\] : sent;/, 'they go with the next message');
}

// ---- 19. An addition during the context count is refused (it becomes the next request), never sent to a dead run.
{
  const SESSION = 's1', pushed = [];
  let agent, during = null;
  const ev = (event) => ({ type: 'stream_event', event, parent_tool_use_id: null, session_id: SESSION });
  const query = ({ prompt }) => {
    const inputs = prompt[Symbol.asyncIterator]();
    (async () => { for (;;) { const r = await inputs.next(); if (r.done) break; pushed.push(r.value?.message?.content?.[0]?.text); } })();
    async function* run() {
      await new Promise((r) => setTimeout(r, 5));
      yield { type: 'system', subtype: 'init', session_id: SESSION };
      yield ev({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 5 } } });
      yield ev({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here.' } });
      yield { type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Here.' }] } };
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
      yield ev({ type: 'message_stop' });
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Here.', session_id: SESSION };
    }
    const q = run(); q.interrupt = async () => {}; q.close = () => {};
    q.getContextUsage = async () => { during = agent.addInput('[added] and open Safari'); return { categories: [{ id: 'messages', tokens: 100, kind: 'used' }] }; };
    return q;
  };
  agent = new ClaudeCodeAgent({ model: 'claude-opus-5-5', system: 's', tools: [], executable: '/bin/claude', cwd: '/', env: {}, query, onRateLimit: () => {}, connectors: true });
  for await (const e of agentEvents(agent.prompt('show me the orbs'))) void e;
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(during, false, 'refused while the run counts its context');
  assert.deepEqual(pushed, ['show me the orbs'], 'nothing went into the dead run');
  assert.deepEqual(agent.unanswered(), []);
}

// ---- 20. Only the owner's own turns get the pending sound and progress lines; news waits while Hydra sleeps.
{
  assert.equal(ownTurn({ text: 'open Safari' }), true);
  assert.equal(ownTurn({ text: '(System, not Ken: these commitments are due now.)' }), false, 'a reminder');
  assert.equal(ownTurn({ text: 'x', news: ['a1'] }), false, 'news');
  assert.equal(ownTurn({ text: 'x', intro: true }), false, 'the intro chat');
  assert.match(side, /const own = ownTurn\(\{ text, news, intro: !!intro \}\);\n  const progress = turnProgress = startProgress\(\{ voice: own && voice,/);
  assert.match(side, /pendingVoice = own \? voice : null;/);
  const quiet = { quietMs: 5000 };
  assert.equal(canNudge(quiet), true);
  assert.equal(canNudge({ ...quiet, asleep: true }), false, 'asleep: no news turn');
  assert.match(side, /gates: \(\) => \(\{ asleep: power\.asleep, busy,/);
}

// ---- 21. An orb tap mid-take sends what was heard (Esc still cancels).
{
  assert.match(mainRs, /Some\("listen_finish"\) => to_voice\(app, &json!\(\{ "cmd": "finish" \}\)\),/);
  assert.match(voiceSwift, /case "finish": DispatchQueue\.main\.async \{ voice\.externalFinish\(\) \}/);
  assert.match(voiceSwift, /func externalFinish\(\) \{\n        guard phase == \.armed \|\| phase == \.holding \|\| phase == \.handsFree else \{ return \}\n        end\("orb tap"\)\n        finish\(\)/);
}

console.log('build4efix: all passed');
