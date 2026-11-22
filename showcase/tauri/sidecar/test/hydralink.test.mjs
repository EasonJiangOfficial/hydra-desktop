// The link to Hydra's data (hydralink.mjs): the URL and device key settings, and the one place Hydra's tools plug in.
import assert from 'node:assert/strict';
import { cleanDeviceKey, cleanHydraUrl, createHydraLink, registerHydraTool } from '../hydralink.mjs';

assert.deepEqual(cleanHydraUrl('https://hydra-olive-one.vercel.app/'), { ok: true, url: 'https://hydra-olive-one.vercel.app' });
assert.deepEqual(cleanHydraUrl('  https://hydra.example.com/api/agent/ '), { ok: true, url: 'https://hydra.example.com/api/agent' });
assert.deepEqual(cleanHydraUrl(''), { ok: true, url: '' });
assert.equal(cleanHydraUrl('http://hydra.example.com').ok, false, 'https only');
assert.equal(cleanHydraUrl('https://me:pw@hydra.example.com').ok, false, 'no sign-in in the address');
assert.equal(cleanHydraUrl('hydra').ok, false);
assert.equal(cleanDeviceKey('short').ok, false);
assert.deepEqual(cleanDeviceKey('hk_0123456789abcdef'), { ok: true, key: 'hk_0123456789abcdef' });

let url = '';
const link = createHydraLink({ getUrl: () => url, getKey: async () => 'hk_0123456789abcdef' });
assert.equal(link.status(), 'off');
url = 'https://hydra.example.com';
assert.equal(link.status(), 'unpaired', 'a URL but no key read yet');
await link.load();
assert.equal(link.status(), 'ready');
assert.deepEqual(link.tools(), [], 'no tool is registered until U13 defines them');
let seen = null;
const off = registerHydraTool({ name: 'hydra_example', description: 'test', execute: async (args, ctx) => { seen = ctx.hydra; return 'ok'; } });
assert.throws(() => registerHydraTool({ name: 'hydra_example', execute() {} }), /already registered/);
const [t] = link.tools();
assert.equal(await t.execute({}, {}), 'ok');
assert.deepEqual(seen, { url: 'https://hydra.example.com', key: 'hk_0123456789abcdef' }, 'a tool gets the link');
link.setKey(null);
assert.deepEqual(link.tools(), [], 'unpaired: the agent sees no Hydra tools');
off();
console.log('hydralink tests: passed');
