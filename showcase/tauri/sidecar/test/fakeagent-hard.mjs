// A stand-in model for test/agenthard.test.mjs (loaded by agentrun.mjs through ROAMIES_FAKE_AGENT): a plain write in
// its own folder (an ordinary ask: Approve all answers it), a read of a dotfile (an ordinary ask too, round 1 L12), then
// a read of a sign-in store in the home folder (refused, never asked: owner's hard limit), then finish. Each tool result
// is logged to FAKE_LOG.
import fs from 'node:fs';
import path from 'node:path';

export default class FakeHardAgent {
  constructor(o) { this.o = o; }
  steer() {}
  prompt() {
    const o = this.o;
    const steps = [
      ['write_file', { path: 'files/a.txt', content: 'one' }],
      ['write_file', { path: 'files/a.txt', content: 'two' }],
      ['read_file', { path: path.join(process.env.HOME, '.zshrc') }],
      ['read_file', { path: path.join(process.env.HOME, '.config', 'hydra', 'notes.txt') }],
      ['finish', { outcome: 'Tried the read.', files: [{ path: 'files/a.txt', what: 'the note' }] }],
    ];
    async function* run() {
      let i = 0;
      for (const [name, args] of steps) {
        const id = `t${++i}`;
        yield { type: 'tool_call_start', toolCallId: id, name, args };
        let isError = false, result;
        try { result = await o.tools.find((t) => t.name === name).execute(args, { signal: o.signal }); } catch (e) { isError = true; result = e.message; }
        fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name, isError, result: String(result).slice(0, 300) }) + '\n');
        yield { type: 'tool_call_end', toolCallId: id, isError, result };
        yield { type: 'turn_end', usage: { inputTokens: 1, outputTokens: 1 } };
      }
      return { message: { role: 'assistant', content: [] }, totalTurns: i, totalUsage: {} };
    }
    const g = run();
    return { [Symbol.asyncIterator]: () => g, then: (a, b) => Promise.resolve({}).then(a, b) };
  }
}
