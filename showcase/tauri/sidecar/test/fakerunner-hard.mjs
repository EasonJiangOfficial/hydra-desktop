// A stand-in worker for test/agenthard.test.mjs part 2: forked by agents.mjs in place of agentrun.mjs, it speaks the
// same messages (start, ask, reply, finish, end) and asks one ordinary yes/no and one hard one (a money step), as
// agentrun.mjs tags them (hard: safety.mjs hardAsk). What the parent replied goes to FAKE_LOG2.
import fs from 'node:fs';

let seq = 0;
const waiting = new Map();
const send = (m, cb) => process.send(m, cb);
const ask = (question, hard) => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); send({ t: 'ask', id, question, always: true, deletion: true, hard }); });
process.on('message', async (m) => {
  if (m?.t === 'reply') { const r = waiting.get(m.id); waiting.delete(m.id); r?.(m.value ?? null); return; }
  if (m?.t !== 'start') return;
  const ordinary = await ask('Overwrite files/a.txt?', false);
  const hard = await ask('Pays or moves money: buy. Click "Buy now" in Safari?', true);
  fs.writeFileSync(process.env.FAKE_LOG2, JSON.stringify({ ordinary, hard }));
  send({ t: 'finish', result: { outcome: 'Asked twice.', report: '', files: [] } });
  send({ t: 'end', ok: true }, () => process.exit(0));
});
send({ t: 'beat' });
