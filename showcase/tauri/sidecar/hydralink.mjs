// The link to Hydra's data: the Hydra agent API (DESIGN.md section 6 item 9, PLAN.md U13). That service isn't built yet,
// so this is the client side only, behind one small interface:
// - settings: the Hydra URL (config.hydraUrl, https only) and a device key (kept with the other keys: the macOS Keychain
//   on a Mac). Pairing through Hydra's Accounts > Connections comes with U13 and will fill these in.
// - registerHydraTool(def): the one place Hydra's tools plug in. A def is an agent tool ({ name, description,
//   parameters (zod), execute(args, ctx) }); its execute gets `link` ({ url, key }) as ctx.hydra. No tool is registered
//   here, and no endpoint is assumed: U13 defines them.
// The agent sees Hydra's tools only once a URL and a key are both set.

export const HYDRA_KEY_SECRET = 'hydra-device-key';
const tools = new Map();

/** A Hydra URL to save: an https origin (a path is kept), or '' to clear. */
export function cleanHydraUrl(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { ok: true, url: '' };
  let u;
  try { u = new URL(t); } catch { return { ok: false, why: 'That is not a web address.' }; }
  if (u.protocol !== 'https:') return { ok: false, why: 'Hydra is reached over https only.' };
  if (u.username || u.password) return { ok: false, why: 'No sign-in details in the address, please.' };
  return { ok: true, url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/** A device key to save: printable, 16 to 512 characters, or '' to remove it. */
export function cleanDeviceKey(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return { ok: true, key: '' };
  if (!/^[\x21-\x7e]{16,512}$/.test(t)) return { ok: false, why: "That doesn't look like a device key." };
  return { ok: true, key: t };
}

/** Where Hydra's tools plug in. Returns a function that takes the tool away again. */
export function registerHydraTool(def) {
  if (!def?.name || typeof def.execute !== 'function') throw new Error('A Hydra tool needs a name and an execute function.');
  if (tools.has(def.name)) throw new Error(`A Hydra tool called ${def.name} is already registered.`);
  tools.set(def.name, def);
  return () => tools.delete(def.name);
}

/**
 * The link as the agent sees it. getUrl() → the saved URL; getKey() → the device key (async, from the key store).
 * status: 'off' (no URL), 'unpaired' (no key) or 'ready'. tools(link): the registered tools, each given the link.
 */
export function createHydraLink({ getUrl, getKey }) {
  let key = null, keyRead = false;
  const link = () => ({ url: getUrl() || '', key });
  return {
    async load() { key = (await getKey().catch(() => null)) || null; keyRead = true; return this.status(); },
    setKey(k) { key = k || null; keyRead = true; },
    status() { return !getUrl() ? 'off' : keyRead && key ? 'ready' : 'unpaired'; },
    get url() { return getUrl() || ''; },
    get toolCount() { return tools.size; },
    tools() {
      if (this.status() !== 'ready') return [];
      return [...tools.values()].map((t) => ({ ...t, execute: (args, ctx) => t.execute(args, { ...ctx, hydra: link() }) }));
    },
  };
}
