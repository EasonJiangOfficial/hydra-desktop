// The agent seams of the phone view (RV plan section 8, T-D3-1 to T-D3-4): Take over closes the gate (no Mac tool
// starts, reads and screenshots too), Hand back opens it with a "look again" line, 75 s in control ends the tool
// call cleanly, Stop rejects the wait and runs the Stop path once; captions per tool and per step, never typed text;
// with no session live the wrapper sends nothing. Run: npm test
import assert from 'node:assert/strict';
import { createViewGate, stepCaption, HANDBACK_LINE, STILL_LINE } from '../viewgate.mjs';
import { fakeClock, flush } from './fakeremote.mjs';

const tool = (name, fn = async () => `${name} done`) => ({ name, description: '', parameters: null, execute: fn });

// ---- T-D3-1 take over, hand back, 75 s ----
{
  const clock = fakeClock();
  const said = [];
  const gate = createViewGate({ clock });
  gate.tap({ agent: (s) => said.push(s) });
  let ran = 0;
  const shot = gate.wrap(tool('take_screenshot', async () => { ran += 1; return 'Screenshot of the screen.' }));
  await gate.takeover();
  assert.equal(gate.owner(), true);
  const p = shot.execute({}, {});
  await clock.advance(9_000);
  assert.equal(ran, 0, 'no Mac tool starts while the owner is in control');
  await clock.advance(1_000);
  gate.handback();
  const r = await p;
  assert.equal(ran, 1, 'it runs after Hand back');
  assert.ok(r.startsWith(HANDBACK_LINE(10)), `the result starts with the hand-back line: ${r}`);
  assert.match(HANDBACK_LINE(10), /took control for 10 s and handed back\. The screen may have changed\. Look again before you go on\./);
  // An image result keeps its blocks, with the line first.
  const img = gate.wrap(tool('read_window', async () => ({ content: [{ type: 'image', data: 'x' }] })));
  await gate.takeover();
  const q = img.execute({}, {});
  await clock.advance(2_000); gate.handback();
  const ri = await q;
  assert.equal(ri.content[0].type, 'text'); assert.ok(ri.content[0].text.startsWith('The owner took control for 2 s'));
  assert.equal(ri.content[1].type, 'image');
  // 75 s in control: the tool does not run and says to stop.
  await gate.takeover();
  ran = 0;
  const late = shot.execute({}, {});
  await clock.advance(75_000);
  assert.equal(await late, STILL_LINE, 'after 75 s it returns the stop line');
  assert.equal(ran, 0, 'and does not run');
  assert.equal(STILL_LINE, 'The owner is still in control. Stop here.');
  gate.handback();
  // A non-Mac tool never waits.
  const mem = gate.wrap(tool('remember_commitment'));
  await gate.takeover();
  assert.equal(await mem.execute({}, {}), 'remember_commitment done', 'memory tools do not wait');
  gate.handback();
}

// ---- Take over waits for the running helper call to end before the owner's hands work ----
{
  const clock = fakeClock();
  const gate = createViewGate({ clock });
  gate.tap({ agent: () => {} });
  let finish;
  const act = gate.wrap(tool('act_in_app', () => new Promise((r) => { finish = r; })));
  const running = act.execute({ target: 'Safari', steps: [] }, {});
  await flush();
  let took = false;
  const t = gate.takeover().then(() => { took = true; });
  await flush();
  assert.equal(took, false, 'Taking over until the running call ends');
  assert.equal(gate.owner(), true, 'but the gate is already closed');
  finish('ok'); await running; await t;
  assert.equal(took, true, 'then the owner is in control');
  gate.handback();
}

// ---- T-D3-2 stop while waiting ----
{
  const clock = fakeClock();
  let stops = 0;
  const gate = createViewGate({ clock, onStop: () => { stops += 1; } });
  gate.tap({ agent: () => {} });
  const shot = gate.wrap(tool('take_screenshot'));
  await gate.takeover();
  const p = shot.execute({}, {});
  await clock.advance(1_000);
  gate.stop();
  await assert.rejects(p, /stopped/i, 'Stop rejects the wait');
  assert.equal(gate.owner(), false, 'and opens the gate');
  // The Mac's own Stop path opens the gate too, and does not call itself again.
  gate.stop({ quiet: true });
  assert.equal(stops, 1, 'the Stop path runs once');
  // Stop and Hand back together: Stop wins (race 12).
  await gate.takeover();
  const p2 = shot.execute({}, {});
  gate.stop(); gate.handback();
  await assert.rejects(p2, /stopped/i);
}

// ---- round 2: one Stop stops everything. The menu Stop or Esc (quiet: the Mac's own Stop path) aborts relay and
// brain turns too; the phone's Stop aborts the Mac's local turn (made with no outer signal) as well as relay ones ----
{
  const clock = fakeClock();
  let stops = 0;
  const gate = createViewGate({ clock, onStop: () => { stops += 1; } });
  const relay = gate.turn(new AbortController().signal), local = gate.turn();
  gate.stop({ quiet: true });
  assert.equal(relay.signal.aborted, true, 'the menu Stop aborts a relay turn');
  assert.equal(local.signal.aborted, true, 'and the local turn');
  assert.equal(stops, 0, 'without calling the Stop path again');
  relay.done(); local.done();
  const local2 = gate.turn(), relay2 = gate.turn(new AbortController().signal);
  gate.stop();
  assert.equal(local2.signal.aborted, true, 'the phone Stop aborts the local turn');
  assert.equal(relay2.signal.aborted, true, 'and the relay turn');
  assert.equal(stops, 1, 'and runs the Stop path once');
  local2.done(); relay2.done();
  // sidekick.mjs: the local turn's controller (what the model run listens to) aborts with its gate turn.
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../sidekick.mjs', import.meta.url), 'utf8');
  assert.match(src, /controller = new AbortController\(\);[^\n]*rvTurn\.signal\.addEventListener\('abort'/, 'the local turn aborts when its gate turn does');
}

// ---- T-D3-3 captions ----
{
  const clock = fakeClock();
  const said = [];
  const gate = createViewGate({ clock });
  gate.tap({ agent: (s) => said.push(s) });
  const open = gate.wrap(tool('open'));
  await open.execute({ target: 'Safari' }, {});
  const starts = said.filter((s) => s.busy && s.caption);
  assert.equal(starts[0].caption, 'Opening Safari', 'one caption at the start of each Mac tool');
  assert.equal(said.filter((s) => s.caption === 'Opening Safari').length, 1);
  said.length = 0;
  gate.step({ ev: 'step', do: 'fill', label: 'Subject', text: 'hunter2', bounds: [10, 20, 30, 40] });
  assert.deepEqual(said, [{ busy: true, caption: 'Typing in Subject', step: { bounds: [10, 20, 30, 40], kind: 'fill' } }], 'a fill step says the field, never the text');
  assert.ok(!JSON.stringify(said).includes('hunter2'));
  assert.equal(stepCaption({ do: 'click', label: 'Search' }), 'Clicking Search');
  assert.equal(stepCaption({ do: 'choose', label: 'Canada' }), 'Choosing Canada');
  assert.equal(stepCaption({ do: 'key', label: 'cmd+w' }), 'Pressing cmd+w');
  assert.equal(stepCaption({ do: 'scroll' }), 'Scrolling');
  assert.equal(stepCaption({ do: 'type', label: '' }), 'Typing');
}

// ---- T-D3-4 no session: the tap is off, nothing is sent, and the wrapper is cheap ----
{
  const clock = fakeClock();
  const gate = createViewGate({ clock });
  const said = [];
  const t = gate.wrap(tool('take_screenshot', async () => 'x'));
  gate.step({ ev: 'step', do: 'click', label: 'A', bounds: [0, 0, 1, 1] });
  const n = 2000, t0 = performance.now();
  for (let i = 0; i < n; i++) await t.execute({}, {});
  const per = (performance.now() - t0) / n;
  assert.ok(per < 1, `under 1 ms per call (${per.toFixed(4)} ms)`);
  assert.deepEqual(said, []);
  // The tap off again after a session: nothing more is sent.
  const seen = [];
  gate.tap({ agent: (s) => seen.push(s) }); gate.tap(null);
  await t.execute({}, {});
  assert.deepEqual(seen, []);
}
console.log('viewgate ok');
