import assert from 'node:assert/strict';
import { aboutHydra } from '../about.mjs';

// The app's manual for about_roamies: Hydra Desktop's own pages and behaviour, and only the features this Mac has.
const full = aboutHydra({ name: 'Hydra', mac: true, snap: true, voice: true, hotkeys: true, wake: true });
const bare = aboutHydra({ name: 'Hydra', mac: true, snap: false, voice: false, hotkeys: false, wake: false });
assert.match(full, /after 5 minutes without the owner talking/);
assert.match(full, /two sharp claps 0\.25 to 0\.8 seconds apart wake you with a short chime, and you listen at once \(no greeting\)/);
assert.match(full, /default "Hydra, sleep"/);
assert.match(full, /Hey Hydra/);
assert.match(full, /modified version of Roamies by Ken Kai under AGPL-3\.0/);
assert.match(full, /never downloads updates/);
assert.match(full, /manage_app/);
assert.match(full, /quitting an app with unsaved work/);
assert.ok(!/Ask About an Area|Hey Hydra|Listening \(/.test(bare), 'features this copy lacks are left out');
for (const t of [full, bare]) {
  assert.ok(!/KenKaiii|skool|youtube|JARVIS|Roamie\b/i.test(t), 'no promos, no old characters');
  assert.ok(!/\$\{|undefined/.test(t), 'every part is filled in');
}
console.log('about tests: passed');
