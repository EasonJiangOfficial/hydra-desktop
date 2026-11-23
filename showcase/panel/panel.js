// The panel that opens from the menu bar or tray icon: a sidebar of pages. Home (what's going on) and Memory,
// then a page per group of settings: Model, Appearance, Voice, Behavior and About, and What's new.
// The sidecar owns every value: it sends the whole state when the panel opens and after each change, and the
// panel sends back the same actions the menu used ({type:'menu', id}). Opened in a plain browser it shows a
// labelled preview with sample data instead.
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const TAURI = window.__TAURI__?.core?.invoke;
  const invoke = TAURI ?? preview();
  const send = (msg) => invoke('sidecar_send', { msg }).catch(() => {});
  const hide = () => invoke('panel_hide').catch(() => {});
  // An action from the menu's list. away: it happens on the desktop, so the panel steps aside first.
  const act = (id, away = false) => { if (away) hide(); send({ type: 'menu', id }); };

  let state = null, tab = 'home', deferred = false;
  // What's open in the panel itself: a key field (provider id, 'fish' or 'gemini'), the row action waiting for its
  // Confirm, each long list's page (pg) and how many rows fit on one (per, measured), Memory's tab and its search.
  const ui = { key: null, kind: {}, arm: null, add: { label: '', url: '', key: '', images: false }, addSent: null, pg: {}, per: {}, base: {}, rec: null, mtab: 'facts', tabs: {}, q: '', bindShown: new Set() };
  let armTimer = 0;
  const disarm = () => { clearTimeout(armTimer); if (ui.arm) { ui.arm = null; return true; } return false; };

  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, f] of Object.entries(v)) n.addEventListener(ev, f);
      else if (k.startsWith('aria-') || k === 'role' || k.startsWith('data-')) n.setAttribute(k, String(v));
      else n[k] = v;
    }
    n.append(...kids.flat().filter((c) => c != null && c !== false));
    return n;
  };
  const btn = (label, onclick, { kind = 'ghost', k, disabled, wide, aria, title } = {}) =>
    el('button', { className: `px btn ${kind}${wide ? ' wide' : ''}`, type: 'button', textContent: label, disabled, title, 'data-k': k, 'aria-label': aria, on: { click: onclick } });
  const link = (label, onclick, { k, danger, aria, disabled } = {}) =>
    el('button', { className: `link${danger ? ' danger' : ''}`, type: 'button', textContent: label, 'data-k': k, 'aria-label': aria, disabled, on: { click: onclick } });
  // A row's action, played out: the row steps out, then the action goes. Re-rendering brings the list in line.
  // A block opening in place grows into its room and fades in; closing, the reverse. Marked with data-anim (its id).
  const shown = (n) => !n.hidden && n.getClientRects().length > 0;
  function grow(n, open) {
    if (REDUCED.matches || !shown(n)) return Promise.resolve();
    const h = n.offsetHeight, gap = parseFloat(getComputedStyle(n.parentElement).rowGap) || 0;
    n.classList.remove('appear', 'vanish'); void n.offsetWidth; n.classList.add(open ? 'appear' : 'vanish');
    const shut = { height: '0px', marginTop: `${-gap}px` }, full = { height: `${h}px`, marginTop: '0px' };
    n.style.overflow = 'hidden';
    return n.animate(open ? [shut, full] : [full, shut], { duration: open ? 200 : 160, easing: 'cubic-bezier(.2, .8, .2, 1)', fill: open ? 'none' : 'forwards' })
      .finished.catch(() => {}).then(() => { n.style.overflow = ''; if (open) n.classList.remove('appear'); });
  }
  // Closes the open block `id` (animated), then runs then().
  const shutBlock = (id, then) => { const n = document.querySelector(`.pane [data-anim="${CSS.escape(id)}"]`); return n && shown(n) ? grow(n, false).then(then) : then(); };
  // The key field under a row: opens (closing another first), or closes if it's the one open.
  function toggleKey(id) {
    const prev = ui.key;
    if (prev === id) return closeKey();
    const open = () => { ui.key = id; render(`key-${id}`); };
    return prev ? shutBlock(`key-${prev}`, open) : open();
  }
  function closeKey() {
    const id = ui.key;
    if (!id) return;
    shutBlock(`key-${id}`, () => { if (ui.key === id) { ui.key = null; render(`addkey:${id}`); } });
  }
  // A row being removed dissolves out, then leaves the list at once (the rows below step up as it goes, so no empty
  // gap waits for the sidecar). Until the new state drops it, every redraw keeps it out, so it never blinks back; if
  // the removal didn't happen after a few seconds, it returns.
  const gone = new Map(); // the row's action key → when to give up on it
  const rowOf = (k) => document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`)?.closest('li');
  const keepGone = () => { for (const [k, until] of gone) { if (Date.now() > until) gone.delete(k); else rowOf(k)?.classList.add('gone'); } };
  const leave = (from, id) => {
    const k = from.dataset.k, row = from.closest('li');
    if (k) gone.set(k, Date.now() + 4000);
    row?.classList.add('leaving');
    setTimeout(() => { row?.classList.add('gone'); act(id); }, REDUCED.matches ? 0 : 190);
    setTimeout(() => { if (k && gone.delete(k) && rowOf(k)) render(); }, 4100);
  };
  // Asks first in the same spot: the first press turns it into Confirm (for 4 s), the second does it.
  const armed = (label, yes, k, id, aria) => {
    const on = ui.arm === k;
    const b = el('button', { className: 'link danger arm', type: 'button', 'data-k': k, 'aria-pressed': String(on), 'aria-label': on ? `Confirm: ${aria}` : aria },
      el('span', { className: 'no', textContent: label, 'aria-hidden': 'true' }), el('span', { className: 'yes', textContent: yes, 'aria-hidden': 'true' }));
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); b.setAttribute('aria-pressed', 'false'); return leave(b, id); }
      clearTimeout(armTimer); ui.arm = k; render(k);
      armTimer = setTimeout(() => { if (ui.arm === k) { ui.arm = null; render(); } }, 4000);
    });
    return b;
  };
  // A row's tick (done) or X (forget, drop) asks first, like Quit: pressed, it turns into Confirm in place while the
  // row's other button steps aside; pressed again it goes, left alone for 4 s it goes back.
  // Line icons: 1.5 px ink strokes with round ends (no pixel art).
  const ICONS = { tick: 'M2.5 7.5l3 3 6-7', x: 'M3 3l8 8M11 3l-8 8' };
  const pix = (name) => `<svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${ICONS[name]}"/></svg>`;
  const armIcon = (b, on) => { b.setAttribute('aria-pressed', String(on)); b.setAttribute('aria-label', on ? `Confirm: ${b.dataset.aria}` : b.dataset.aria); if (on) b.removeAttribute('data-tip'); else b.dataset.tip = b.dataset.name; };
  const calmIcons = () => { for (const o of document.querySelectorAll('.pane .ibtn[aria-pressed="true"]')) armIcon(o, false); };
  function iconArmed(icon, tip, k, id, aria) {
    const no = el('span', { className: 'no', 'aria-hidden': 'true' });
    no.innerHTML = pix(icon);
    const b = el('button', { className: `link ibtn${icon === 'x' ? ' danger' : ''}`, type: 'button', 'data-k': k, 'data-name': tip, 'data-aria': aria },
      no, el('span', { className: 'yes', textContent: 'Confirm', 'aria-hidden': 'true' }));
    armIcon(b, ui.arm === k);
    b.addEventListener('click', () => {
      if (ui.arm === k) { disarm(); return leave(b, id); }
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(k);
      const me = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`) ?? b;
      ui.arm = k; armIcon(me, true); hideTip();
      armTimer = setTimeout(() => { if (ui.arm !== k) return; ui.arm = null; const n = document.querySelector(`.pane [data-k="${CSS.escape(k)}"]`); if (n) armIcon(n, false); }, 4000);
    });
    return b;
  }
  // No title: the section is alone in its tab, which names it.
  // An info dot: an explanation on hover or focus, never a sentence on the page (DESIGN.md section 7, copy rule).
  const info = (text) => (text ? el('button', { className: 'info', type: 'button', 'aria-label': text, 'data-tip': text }, 'i') : null);
  const group = (title, desc, n, ...kids) => el('div', { className: 'group' },
    el('div', { className: 'ghead' }, title ? el('h2', {}, title, n != null ? el('span', { className: 'n', textContent: String(n) }) : null, info(desc)) : null, !title && desc ? info(desc) : null),
    ...kids);
  // A page's tabs (Memory, Model, Appearance, Listening): one part of the page at a time. tabs: [id, label]; pick(id) switches.
  const tabRow = (label, panel, tabs, on, pick) => el('div', { className: 'tabs', role: 'tablist', 'aria-label': label }, tabs.map(([id, text]) => el('button', {
    className: 'tab', type: 'button', role: 'tab', id: `tab-${id}`, 'aria-selected': String(on === id), 'aria-controls': panel, tabIndex: on === id ? 0 : -1, 'data-k': `tab-${id}`,
    on: { click: () => { if (on !== id) { pick(id); disarm(); render(`tab-${id}`); } } },
  }, text)));
  // The tab picked on a page: the one kept from before when it's still offered, else the first.
  const pageTab = (page, tabs, first = tabs[0][0]) => (tabs.some(([id]) => id === ui.tabs[page]) ? ui.tabs[page] : first);
  const tabPanel = (id, on, ...kids) => el('div', { className: 'tabpanel', role: 'tabpanel', id, 'aria-labelledby': `tab-${on}` }, ...kids);
  const toggle = (label, hint, on, onflip, k) => el('div', { className: 'setting' },
    el('span', { id: `lbl-${k}` }, label, info(hint)),
    el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!on), 'aria-labelledby': `lbl-${k}`, 'data-k': k, on: { click: onflip } }));
  // tips: { value: text } shown in a tooltip on hover or keyboard focus, and read out as the option's description.
  const picks = (label, list, value, pick, k, tips = null) => el('div', { className: 'picks', role: 'radiogroup', 'aria-label': label },
    list.map(([v, text]) => el('button', {
      className: 'px chord', type: 'button', role: 'radio', 'aria-checked': String(v === value), tabIndex: v === value ? 0 : -1, 'data-k': `${k}:${v}`,
      'data-tip': tips?.[v] ?? null, 'aria-describedby': tips?.[v] ? `tip-${k}-${v}` : null,
      on: { click: () => v !== value && pick(v) },
    }, el('span', { className: 'px cap', textContent: text }), tips?.[v] ? el('span', { className: 'sr-only', id: `tip-${k}-${v}`, textContent: tips[v] }) : null)));

  // ---- tooltip: one box, by whatever has a data-tip under the pointer or keyboard focus ----
  // It can be hovered (it sits right against its control), Esc closes it, and it never covers its control.
  let tipFor = null, tipTimer = 0;
  const tipBox = () => $('tip');
  function showTip(target, own = null) {
    clearTimeout(tipTimer);
    const t = tipBox(), text = own ?? target.dataset.tip;
    if (!text) return;
    if (tipFor !== target) { t.textContent = text; t.classList.remove('in'); void t.offsetWidth; t.classList.add('in'); }
    tipFor = target; t.hidden = false;
    const r = target.getBoundingClientRect(), gut = 12;
    // Fit the text, up to 300px (or the window): a one-word tip gets a small card.
    t.style.maxWidth = `${Math.min(300, innerWidth - gut * 2)}px`;
    const w = t.offsetWidth, h = t.offsetHeight, below = r.bottom + 6 + h <= innerHeight - 8;
    const x = Math.round(Math.min(Math.max(r.left, gut), innerWidth - gut - w)), y = Math.round(below ? r.bottom + 6 : r.top - 6 - h);
    t.style.left = `${x}px`; t.style.top = `${y}px`;
    // The frame can be what "fixed" is measured from (its open/close effects): correct by where it actually landed.
    const at = t.getBoundingClientRect();
    t.style.left = `${x + (x - Math.round(at.left))}px`; t.style.top = `${y + (y - Math.round(at.top))}px`;
  }
  function hideTip(soon = false) {
    clearTimeout(tipTimer);
    if (soon) { tipTimer = setTimeout(() => hideTip(), 120); return; }
    tipFor = null; const t = tipBox(); if (t) t.hidden = true;
  }
  // A description cut to one line ("…") shows in full: on hover, and when its row's control has keyboard focus.
  const clipped = (n) => (n && n.scrollWidth > n.clientWidth ? n.textContent : null);
  document.addEventListener('pointerover', (e) => {
    const d = e.target.closest?.('.setting > span small, .ghead p');
    if (d) { const full = clipped(d); if (full) d.dataset.tip = full; else delete d.dataset.tip; }
  }, true);
  document.addEventListener('pointerover', (e) => { const x = e.target.closest?.('[data-tip]'); if (x) showTip(x); else if (e.target.closest?.('#tip')) clearTimeout(tipTimer); });
  document.addEventListener('pointerout', (e) => { if (e.target.closest?.('[data-tip], #tip') && !e.relatedTarget?.closest?.('[data-tip], #tip')) hideTip(true); });
  document.addEventListener('focusin', (e) => {
    const x = e.target.closest?.('[data-tip]');
    if (x && x.matches(':focus-visible')) return showTip(x);
    const full = !x && e.target.matches?.(':focus-visible') ? clipped(e.target.closest?.('.setting')?.querySelector(':scope > span small')) : null;
    if (full) showTip(e.target, full); else hideTip();
  });
  document.addEventListener('focusout', () => hideTip(true));

  const ago = (at) => {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 45) return 'now';
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  };
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
  const tokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  // Why pick each voice model: a line under the choice, and more in its tooltip with the cost.
  const WHY = { 'drama-3': 'More emotion. Slower, and costs more.', 's2.1-pro': 'Natural pace. Less emotion, costs less.' };
  const WHY_LONG = {
    'drama-3': 'The most expressive: whispers, laughs and real excitement. It talks slower, with pauses between sentences.',
    's2.1-pro': 'A natural, quicker pace. Feelings only come through lightly.',
  };
  // A spoken reply is about 200 characters (1 to 3 short sentences), so 100 replies are about 20,000. The offer's
  // last day is shown in Pacific time, as Fish states it (it ends Dec 1, 00:00 PT).
  const price = (c) => {
    const per100 = (perM) => `$${(perM * 0.02).toFixed(2)}`;
    const promo = c.promo && Date.now() < Date.parse(c.promo.until)
      ? ` (${per100(c.promo.perM)} until ${new Date(Date.parse(c.promo.until) - 1).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'America/Los_Angeles' })})` : '';
    return `$${c.perM} per million characters: about ${per100(c.perM)} per 100 replies${promo}. Billed to your Fish Audio account.`;
  };
  // Gemini's two: a reply is about 12 seconds of speech, so 100 replies are about 20 minutes.
  const GEMINI_WHY = { 'gemini-3.8-flash-lite-tts': 'Quick. Costs less.', 'gemini-3.8-flash-tts': 'Studio quality. Costs more.' };
  const GEMINI_WHY_LONG = {
    'gemini-3.8-flash-lite-tts': 'The quick, cheaper one: good for everyday replies.',
    'gemini-3.8-flash-tts': "Google's best voice quality, with more feeling in it.",
  };
  const geminiPrice = (c) => `About $${(c.per10s * 120).toFixed(2)} per 100 replies, billed to your Google AI Studio account (it has a free tier).`;
  const where = () => (state?.os === 'mac' ? 'your Keychain' : state?.os === 'win' ? 'Windows, encrypted for your account' : state?.os === 'linux' ? 'your keyring' : 'this computer');

  // ---------------------------------------------------------------- header
  function head() {
    const s = state.status;
    $('led').className = `led${s.state === 'ready' ? ' on' : s.state === 'busy' ? ' busy' : ''}`;
    const now = $('now');
    now.replaceChildren(el('b', { textContent: s.text }), state.model ? ` · ${state.model.name}` : s.state === 'off' ? ' · Sign in on the Model page' : '');
    now.title = now.textContent;
    $('ver').textContent = `v${state.version}`;
    updateButton();
    react();
    // The sidebar marks a page that needs you: no account to answer with.
    mark('model', s.state === 'off' ? 'not signed in' : null);
  }
  // One button for updates, updated in place (not rebuilt) so it keeps focus: Check for updates, then Update to x
  // (it downloads, installs and restarts), then Done. "Up to date" shows for a few seconds after a check.
  // Hydra Desktop has no self-updater, so no update button.
  function updateButton() { $('head-update').hidden = true; }
  $('head-update').addEventListener('click', () => act(state?.update?.available ? 'install_update' : 'update'));
  // Quit asks first: the first press turns it into Confirm for 4 s, the second quits.
  const quitB = $('head-quit');
  let quitTimer = 0;
  const unarmQuit = () => { clearTimeout(quitTimer); quitB.setAttribute('aria-pressed', 'false'); quitB.setAttribute('aria-label', 'Quit Hydra'); };
  quitB.addEventListener('click', () => {
    if (quitB.getAttribute('aria-pressed') === 'true') { unarmQuit(); act('quit'); return; }
    quitB.setAttribute('aria-pressed', 'true'); quitB.setAttribute('aria-label', 'Confirm: quit Hydra');
    quitTimer = setTimeout(unarmQuit, 4000);
  });
  const closeB = $('head-close');
  closeB.innerHTML = pix('x');
  closeB.addEventListener('click', hide);
  function mark(page, why) {
    const b = $(`nav-${page}`);
    b.classList.toggle('flag', !!why);
    let sr = b.querySelector('.sr-only');
    if (why && !sr) b.append(sr = el('span', { className: 'sr-only' }));
    if (sr) { if (why) sr.textContent = ` (${why})`; else sr.remove(); }
  }

  // ---------------------------------------------------------------- live Roamies
  // The same LED renderer as on the desktop and in the setup guide, drawn small: one in the header (the Roamie
  // you have, reacting to what's going on) and one per look on the Appearance page. One loop draws them all,
  // only while the panel is up and each canvas is on screen.
  const LED = [[255, 255, 255], [229, 229, 234], [161, 161, 166], [110, 110, 115], [29, 29, 31]];
  const live = new Set();
  let pointer = null; // the cursor in page px, for their eyes
  addEventListener('pointermove', (e) => { pointer = [e.clientX, e.clientY]; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer = null; });
  const ACT_SECS = { hype: 2.8, upset: 3.4, wave: 3.1, remind: 3.1, motivate: 3.1 };
  const POSES = {
    think: (t) => ({ arms: 1, tl: [-0.08, 0.5 + Math.sin(t * 2) * 0.03], tr: [0.98, 0.34], mouth: Math.sin(t * 0.9) > 0.6 ? 'o' : 'flat', brow: 'raised' }),
    concerned: () => ({ arms: 0.7, tl: [-0.45, 0.95], tr: [0.45, 0.95], mouth: 'frown', brow: 'raised' }),
  };
  // A Roamie on a canvas of w×h CSS px: the one on screen at half scale (the app's unit, every dot half size), so
  // each size shows its own art (the full face, the small one, the pointer) at its real size next to the others.
  const ZOOM = 0.5, UNIT = 340;
  function liveRoamie(canvas, w, h, { look = 'hydra', y = 0.5, form = 'default' } = {}) {
    if (!window.Roamie?.ditherKit) return null;
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    const z = ZOOM, unit = UNIT;
    w /= z; h /= z;
    const env = {
      w, h, dpr, t: 0, unit, transparent: true, spawn: { x: w / 2, y: h * y },
      safe: { left: 0, right: 0, top: 0, bottom: 0 }, mouse: { x: w / 2, y: h * y, inside: false, active: false }, sleepy: 0, reduced: REDUCED.matches,
    };
    let K = null, clock = 0, actUntil = 0;
    const me = {
      pose: null, look, form,
      kit: Roamie.ditherKit({
        id: 'panel', label: 'Panel', matrix: true, pixel: 1.3, glow: 0, speed: 80, pal: LED,
        // busy: no acts of its own; pose: whatever's going on, except while it's acting something out.
        plugin: (kit) => { K = kit; return { busy: () => true, pose: () => (clock < actUntil ? null : POSES[me.pose]?.(clock) ?? null) }; },
      }).create(env),
      act(name) { if (!K || REDUCED.matches) return; K.startAct(name); actUntil = clock + (ACT_SECS[name] ?? 3); },
      setLook(l) { if (l === me.look) return; me.look = l; me.kit.setLook(l); },
      setForm(f) { if (f === me.form) return; me.form = f; me.kit.setForm(f); },
      appear(v = 'fade') { me.kit.appear(v, w / 2, h * y); },
      step(dt) {
        clock += dt; env.t += dt; env.reduced = REDUCED.matches;
        // Eyes on the cursor, wherever it is in the panel; looking ahead when it's away.
        const r = canvas.getBoundingClientRect();
        if (pointer) Object.assign(env.mouse, { x: (pointer[0] - r.left) / z, y: (pointer[1] - r.top) / z, inside: true, active: true });
        else Object.assign(env.mouse, { x: w * 1.6, y: h * y, inside: true, active: true });
        me.kit.update(dt, env);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.setTransform(dpr * z, 0, 0, dpr * z, 0, 0);
        ctx.save(); me.kit.draw(ctx, env); ctx.restore();
      },
    };
    me.kit.setLook(look); me.kit.setForm(form); me.kit.resize(env);
    me.kit.mover.anchor = { x: w / 2, y: h * y, r: 1.5 };
    me.kit.vanish(null, true);
    live.add({ me, canvas });
    return me;
  }
  let lastFrame = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(1 / 30, (now - (lastFrame || now)) / 1000); lastFrame = now;
    if (document.hidden || $('frame').classList.contains('shut')) return;
    for (const { me, canvas } of live) if (canvas.isConnected && canvas.offsetParent) me.step(dt);
  }
  requestAnimationFrame(loop);

  // The header's Roamie: your look, reacting to what's going on. A short line beside it when something changes.
  // The same size and detail as the look tiles (fewer dots than that and the faces turn to noise).
  const avatar = liveRoamie($('avatar'), 64, 64, { y: 0.5 });
  let quipTimer = 0, seen = { look: null, update: null, opened: 0 };
  function quip(text, secs = 2.6) {
    const q = $('saying'), n = $('by');
    clearTimeout(quipTimer);
    q.textContent = text; q.classList.add('on'); n.classList.add('quiet');
    quipTimer = setTimeout(() => { q.classList.remove('on'); n.classList.remove('quiet'); }, secs * 1000);
  }
  function react() {
    if (!avatar) return;
    avatar.pose = state.busy ? 'think' : state.status.state === 'off' ? 'concerned' : null;
    window.Roamie.asleep = !!state.hydra?.asleep;
  }

  // ---------------------------------------------------------------- Home
  function home() {
    const u = state.update;
    const mac = state.os === 'mac';
    return [
      el('div', { className: 'group' },
        el('h2', { className: 'sr-only', textContent: 'Actions' }),
        el('div', { className: 'actions' },
          // askKeys: the type-to-ask shortcut (a tap of two modifier keys), so it can be learnt from the button.
          btn('Ask', () => act('ask', true), { kind: u.available ? 'ghost' : 'primary', k: 'ask', disabled: state.busy,
            aria: state.askKeys ? `Ask ${state.name}, or tap ${state.askKeys} anywhere` : `Ask ${state.name}`, title: state.askKeys ? `Or tap ${state.askKeys} anywhere` : null }),
          btn('Show list', () => act('list', true), { k: 'list' }),
          state.snap ?? mac ? btn('Ask about an area', () => act('snap', true), { k: 'snap' }) : null,
          state.busy ? btn('Stop', () => act('stop'), { k: 'stop' }) : btn('New chat', () => act('new'), { k: 'new', disabled: !state.canNew, aria: 'Start a new conversation' }),
          mac ? null : btn(`Show ${state.name}`, () => act('show', true), { k: 'show' }))),
      recentList(),
    ].flat();
  }
  function recentList() {
    const { box, nav } = paged('recent', state.recent, (r) => el('li', { className: `item ${r.kind}` },
      el('span', { className: 'mark', 'aria-hidden': 'true' }),
      el('span', { className: 'text', dir: 'auto', textContent: r.kind === 'ask' ? `“${r.text}”` : r.text, title: r.text }),
      el('span', { className: 'meta', textContent: ago(r.at) })), { label: 'Recent' });
    return [
      el('div', { className: 'group paged' }, el('div', { className: 'ghead' }, el('h2', { textContent: 'Recent' })), box),
      foot(state.usage ? el('p', { className: 'usage', textContent: `Today: ${state.usage.requests} request${state.usage.requests === 1 ? '' : 's'} · ${tokens(state.usage.tokens)} tokens` }) : null, nav),
    ];
  }

  // ---------------------------------------------------------------- pages of a long list
  // As many rows as fit (measured after drawing, see fit()), the rest a page away with the arrows in the footer.
  const EMPTY = 'Nothing yet…';
  // pin: the index of a row that must stay in view (an open key field), whatever page that puts it on.
  function paged(key, items, row, { label, empty = EMPTY, id, pin = -1 } = {}) {
    const per = ui.per[key] ?? 8, pages = Math.max(1, Math.ceil(items.length / per));
    if (pin >= 0) ui.pg[key] = Math.floor(pin / per);
    const pg = ui.pg[key] = Math.min(Math.max(0, ui.pg[key] ?? 0), pages - 1);
    const shown = items.slice(pg * per, pg * per + per);
    const box = el('div', { className: 'pagebox', 'data-pager': key, id },
      shown.length ? el('ul', { className: 'list', 'aria-label': label }, shown.map(row)) : el('p', { className: 'empty', textContent: empty }));
    return { box, nav: pages > 1 ? pager(key, pg, pages, label) : null };
  }
  function pager(key, pg, pages, label) {
    const go = (d) => {
      ui.pg[key] = pg + d; disarm();
      // Keep focus on an arrow that still works at the end of the list.
      const edge = pg + d === 0 || pg + d === pages - 1;
      refresh(`${key}:${edge ? (d < 0 ? 'next' : 'prev') : d < 0 ? 'prev' : 'next'}`);
    };
    return el('div', { className: 'pager', role: 'group', 'aria-label': `${label}: page ${pg + 1} of ${pages}` },
      btn('‹', () => go(-1), { kind: 'ghost mini', k: `${key}:prev`, disabled: pg === 0, aria: 'Previous page' }),
      el('span', { className: 'pnum', textContent: `${pg + 1} / ${pages}`, 'aria-hidden': 'true' }),
      btn('›', () => go(1), { kind: 'ghost mini', k: `${key}:next`, disabled: pg === pages - 1, aria: 'Next page' }));
  }
  // The page's footer: something about the whole list on the left, the arrows on the right; none when both are empty.
  const foot = (left, nav, id) => (left || nav ? el('div', { className: 'pfoot', id }, el('div', { className: 'pfoot-l' }, left), nav) : null);
  // How many rows fit in each list's box now; true when that changed (so it's drawn again). A plain row sets the
  // size; a taller one (an open key field, a note under the row) takes its extra room off the page.
  function fit() {
    let changed = false;
    for (const box of document.querySelectorAll(`#pane-${tab} .pagebox`)) {
      const rows = [...box.querySelectorAll('.list > li')].filter((r) => r.offsetHeight > 0); // not one being removed (hidden)
      if (!rows.length || !box.clientHeight) continue;
      const open = (r) => r.classList.contains('open');
      const shut = rows.filter((r) => !open(r));
      const unit = Math.min(...(shut.length ? shut : rows).map((r) => r.offsetHeight));
      const over = (list) => list.reduce((n, r) => n + Math.max(0, r.offsetHeight - unit), 0);
      // Regression: a taller row on one page (Ollama's note) made that page smaller, which moved every page and showed
      // rows twice. For the same box, the size without open rows only ever shrinks, so the pages hold still.
      const k = box.dataset.pager, h = box.clientHeight, seen = ui.base[k];
      let base = Math.floor((h - over(shut)) / unit);
      if (seen?.h === h && seen.unit === unit) base = Math.min(base, seen.n);
      ui.base[k] = { h, unit, n: base };
      const per = Math.max(3, base - Math.ceil(over(rows.filter(open)) / unit));
      if (per !== ui.per[box.dataset.pager]) { ui.per[box.dataset.pager] = per; changed = true; }
    }
    return changed;
  }

  // ---------------------------------------------------------------- Memory
  // Three tabs, What I remember, Commitments and Recently deleted, each a page at a time; Get to know me at the end of
  // the tab row.
  function memory() {
    const on = ['commits', 'bin'].includes(ui.mtab) ? ui.mtab : 'facts';
    return [
      el('div', { className: 'mhead' },
        tabRow('Memory', 'mem-panel', [['facts', 'What I remember'], ['commits', 'Commitments'], ['bin', 'Recently deleted']], on, (id) => { ui.mtab = id; }),
        link('Get to know me', () => act('intro', true), { k: 'intro', disabled: state.intro })),
      ...(on === 'commits' ? commitList() : on === 'bin' ? binList() : factList()),
    ];
  }
  // What was deleted (facts, commitments, jobs, skills, connections) and files as they were before I changed them:
  // kept 30 days, each with Put back.
  function binList() {
    const d = state.deleted ?? [];
    const { box, nav } = paged('bin', d, (x) => el('li', { className: 'item mem bin' },
      el('span', { className: 'text', dir: 'auto', title: x.title }, x.title, el('small', { textContent: `${x.kind} · ${x.when}` })),
      el('span', { className: 'row-btns' }, link('Put back', () => act(`bin:restore:${x.id}`, true), { k: `bin:restore:${x.id}`, aria: `Put back: ${x.title}` }))),
    { label: 'Recently deleted', empty: 'Nothing deleted in the last 30 days.' });
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-bin' }, box), foot(d.length ? el('p', { className: 'usage', textContent: `${d.length} kept for 30 days` }) : null, nav)];
  }
  // ---------------------------------------------------------------- Abilities
  // What I can do beyond talking, a tab each: skills I know, apps I'm connected to, and what I do on my own.
  const ABILITY_TABS = [['skills', 'Skills'], ['connections', 'Connections'], ['routines', 'Routines']];
  function abilitiesPage() {
    const t = pageTab('abilities', ABILITY_TABS);
    const head = el('div', { className: 'mhead' }, tabRow('Abilities', 'ab-panel', ABILITY_TABS, t, (id) => { ui.tabs.abilities = id; }));
    const { body, foot: end } = t === 'connections' ? connectionsTab() : t === 'routines' ? routinesTab() : skillList();
    return [head, tabPanel('ab-panel', t, ...body), end];
  }
  // How-tos I learned (by asking me to remember how, or on my own after a long task that worked). View opens the file;
  // Remove, like the other Abilities tabs (Forget is for what I remember about them).
  function skillList() {
    const k = state.skills ?? [];
    const { box, nav } = paged('skills', k, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.description }, x.name, el('small', { textContent: x.description })),
      el('span', { className: 'row-btns' },
        link('View', () => act(`skill:view:${x.slug}`, true), { k: `skill:view:${x.slug}`, aria: `View the skill ${x.name}` }),
        armed('Remove', 'Confirm', `skill:forget:${x.slug}`, `skill:forget:${x.slug}`, `Remove the skill ${x.name}`))),
    { label: 'Skills', empty: `None yet. Say “remember how to do this” after I've done something.` });
    return { body: [el('div', { className: 'group paged' }, box)], foot: foot(k.length ? el('p', { className: 'usage', textContent: `${k.length} skill${k.length === 1 ? '' : 's'}` }) : null, nav) };
  }
  function factList() {
    const f = state.facts, q = ui.q.trim().toLowerCase();
    const hits = q ? f.filter((x) => x.text.toLowerCase().includes(q)) : f;
    const { box, nav } = paged('facts', hits, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', textContent: x.text, title: x.text }),
      el('span', { className: 'row-btns icons' }, x.replaced ? el('span', { className: 'val', textContent: 'Replaced', title: 'A newer fact corrects this one; I no longer use it. Forget it to remove it.' }) : null, iconArmed('x', 'Forget', `forget:${x.id}`, `forget:${x.id}`, `Forget: ${x.text}`))), { label: 'What I remember', empty: q ? `No match for "${ui.q.trim()}".` : EMPTY, id: 'facts-box' });
    // Search once there's more than a page: it looks through all of them, and the pages follow the matches.
    const search = f.length > (ui.per.facts ?? 8) || q ? el('div', { className: 'find' }, el('span', { className: 'px field' },
      el('input', { type: 'search', id: 'find-facts', value: ui.q, placeholder: `Search ${f.length} memories`, 'aria-label': 'Search what I remember', autocomplete: 'off', spellcheck: false,
        on: { input: (e) => { ui.q = e.target.value; ui.pg.facts = 0; refreshFacts(); }, keydown: (e) => { if (e.key === 'Escape' && ui.q) { e.preventDefault(); e.stopPropagation(); e.target.value = ui.q = ''; refreshFacts(); } } } }))) : null;
    return [
      el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-facts' }, search, box),
      foot(f.length ? armed('Forget everything', `Forget all ${f.length}`, 'forget-all', 'forgetall:yes', `Forget all ${f.length} things I remember`) : null, nav, 'facts-foot'),
    ];
  }
  // Searching redraws just the list and its footer, so the search field keeps its focus and caret.
  function refreshFacts() {
    const [panel, ft] = factList(), box = $('facts-box');
    if (!box) return render();
    box.replaceWith(panel.querySelector('#facts-box'));
    const old = $('facts-foot');
    if (old && ft) old.replaceWith(ft); else if (old) old.remove(); else if (ft) $('mem-panel').after(ft);
    if (fit()) refreshFacts();
  }
  function commitList() {
    const { box, nav } = paged('commits', state.commitments, (x) => el('li', { className: 'item mem' },
      el('span', { className: 'text', dir: 'auto', title: x.text }, x.text, x.when ? el('small', { className: x.overdue ? 'late' : '', textContent: x.overdue ? `Overdue · ${x.when}` : x.when }) : null),
      el('span', { className: 'row-btns icons' },
        iconArmed('tick', 'Done', `done:${x.id}`, `done:${x.id}`, `Done: ${x.text}`),
        iconArmed('x', 'Drop', `drop:${x.id}`, `drop:${x.id}`, `Drop: ${x.text}`))), { label: 'Commitments' });
    const n = state.commitments.length;
    return [el('div', { className: 'group paged', role: 'tabpanel', id: 'mem-panel', 'aria-labelledby': 'tab-commits' }, box), foot(n ? el('p', { className: 'usage', textContent: `${n} open` }) : null, nav)];
  }
  // A page arrow: the search field (if it has focus) is kept by redrawing only the list.
  const refresh = (focusKey) => (tab === 'memory' && ui.mtab === 'facts' && document.activeElement?.id === 'find-facts' ? refreshFacts() : render(focusKey));

  // ---------------------------------------------------------------- Settings
  // A masked key field that opens in place. id: a provider, or a voice service ('fish', 'gemini'). kinds: the kinds of key it takes
  // (Kimi and Xiaomi: a plan key or a pay-per-token key), picked above the field; onsave gets the kind's id.
  function keyForm(id, label, onsave, kinds = null) {
    const kind = kinds?.find((x) => x.id === ui.kind[id]) ?? kinds?.[0];
    const name = kind?.label ?? label;
    const input = el('input', { type: 'password', id: `key-${id}`, autocomplete: 'off', spellcheck: false, placeholder: `${name} key`, 'aria-label': `${name} API key`, maxLength: 1000 });
    const save = () => { const v = input.value.trim(); if (!v) return input.focus(); onsave(v, kind?.id); input.value = ''; closeKey(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } });
    const row = el('div', { className: 'keyform', hidden: ui.key !== id, 'data-anim': `key-${id}` }, el('span', { className: 'px field' }, input), btn('Save', save, { k: `save:${id}` }));
    if (!kinds) return row;
    row.hidden = false; delete row.dataset.anim;
    return el('div', { className: 'keykinds', hidden: ui.key !== id, 'data-anim': `key-${id}` },
      picks(`${label} key type`, kinds.map((x) => [x.id, x.label]), kind.id, (v) => { ui.kind[id] = v; render(`kind-${id}:${v}`); }, `kind-${id}`,
        Object.fromEntries(kinds.map((x) => [x.id, x.billing]))),
      row);
  }

  const signIn = (p) => link(p.id === 'anthropic' ? 'Sign in with Claude' : 'Sign in', () => act(`login:${p.id}`), { k: `login:${p.id}`, aria: p.id === 'anthropic' ? 'Sign in with Claude' : `Sign in to ${p.label}`, disabled: !!state.loggingIn });
  const connect = (s) => link('Connect', () => act(`local:connect:${s.id}`), { k: `local:connect:${s.id}`, aria: `Connect ${s.label}` });
  const addKey = (p) => link(ui.key === p.id ? 'Cancel' : 'Add key', () => toggleKey(p.id), { k: `addkey:${p.id}`, aria: `Add ${p.label} API key` });

  // A connected account's key: replace it (saving under the same kind overwrites it), or add one next to a sign-in.
  const changeKey = (p) => link(ui.key === p.id ? 'Cancel' : p.keySaved ? 'Change key' : 'Add key', () => toggleKey(p.id),
    { k: `addkey:${p.id}`, aria: `${p.keySaved ? 'Change the' : 'Add a'} ${p.label} API key` });

  // Settings, one page per concern.
  // The runnable models, one optgroup per signed-in provider, values 'provider:modelId'; `current` is the selected one ('' for none).
  // text: also the models that can't see images, in their own group per provider (subagents only).
  const modelOptgroups = (current, text = false) => state.providers.filter((p) => p.on).flatMap((p) => [
    el('optgroup', { label: p.label }, p.models.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === current }))),
    text && p.textModels?.length ? el('optgroup', { label: `${p.label}, text only` },
      p.textModels.map((m) => el('option', { value: `${p.id}:${m.id}`, textContent: m.name, selected: `${p.id}:${m.id}` === current }))) : null,
  ].filter(Boolean));
  // The model a 'provider:modelId' names (undefined when it isn't listed), and its display name (the raw id when it isn't).
  const findModel = (v) => {
    const i = v.indexOf(':');
    const p = i < 0 ? null : state.providers.find((x) => x.id === v.slice(0, i)), id = v.slice(i + 1);
    return p ? p.models.find((x) => x.id === id) ?? p.textModels?.find((x) => x.id === id) : undefined;
  };
  const modelName = (v) => findModel(v)?.name ?? v;
  // A model select with a first option `first` (value ''), for the value `current`; onpick gets the select element.
  const modelSelect = (aria, k, current, first, onpick, text = false) => el('span', { className: 'px field select' },
    el('select', { 'aria-label': aria, 'data-k': k, on: { change: (e) => onpick(e.target) } },
      el('option', { value: '', textContent: first, selected: !current }),
      modelOptgroups(current, text)));
  // Effort: how hard a model thinks before it answers. A model's `levels` are the thinking levels it supports (none: it
  // can't think). The stops are Off, then those levels; the automatic value ('') starts at the app default, 'low'.
  const EFFORT_NAMES = { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max', ultra: 'Ultra' };
  const EFFORT_HINT = 'Higher is smarter but slower.';
  const effortStops = (m) => (m?.levels?.length ? ['off', ...m.levels.filter((x) => x !== 'off')] : null);
  // Where a slider starts: the slot's level when its model has it, else low, else the model's lowest level.
  const effortStart = (stops, v) => stops.indexOf(stops.includes(v) ? v : stops.includes('low') ? 'low' : stops[1]);
  const effortHint = () => el('p', { className: 'why wrap effort-hint', textContent: EFFORT_HINT });
  // The Effort slider for a slot ('default', a job kind, 'backup1' or 'backup2') running `value` ('provider:modelId').
  // Nothing when no model is chosen; a note when the model can't think. hint: show the explanation under it.
  function effortRow(slot, value, hint = false) {
    const m = findModel(value);
    if (!m) return null;
    const stops = effortStops(m);
    if (!stops) return el('p', { className: 'effort-none', textContent: "This model doesn't think." });
    const ticks = el('div', { className: 'effort-ticks', 'aria-hidden': 'true' }, stops.map((s, i) => { const t = el('span', { textContent: EFFORT_NAMES[s] ?? s }); t.style.setProperty('--i', i); return t; }));
    ticks.style.setProperty('--n', stops.length);
    // Moving the thumb (input) highlights its stop; letting go (change) sends it.
    const show = (i) => {
      range.style.setProperty('--p', i / (stops.length - 1));
      range.setAttribute('aria-valuetext', EFFORT_NAMES[stops[i]] ?? stops[i]);
      [...ticks.children].forEach((t, j) => t.classList.toggle('on', j === i));
    };
    const range = el('input', {
      type: 'range', className: 'effort-range', min: 0, max: stops.length - 1, step: 1, value: effortStart(stops, state.efforts?.[slot] ?? ''),
      'data-k': `effort_${slot}`, 'aria-label': `Effort for ${m.name}`,
      on: { input: (e) => show(Number(e.target.value)), change: (e) => act(`effort_${slot}:${stops[Number(e.target.value)]}`) },
    });
    show(Number(range.value));
    return el('div', { className: 'effort' }, el('p', { className: 'sub', textContent: 'Effort' }), range, ticks, hint ? effortHint() : null);
  }
  function modelPage() {
    const on = state.providers.filter((p) => p.on);
    const model = state.model ? `${state.model.provider}:${state.model.id}` : '';
    const select = on.length ? el('span', { className: 'px field select' },
      el('select', { 'aria-label': 'Model', 'data-k': 'model', on: { change: (e) => act(`model:${e.target.value}`) } },
        model ? null : el('option', { value: '', textContent: 'Pick a model', disabled: true, selected: true }),
        modelOptgroups(model))) : null;
    // The accounts, then each local server (Ollama, LM Studio, the ones added) and the Add a server row.
    const servers = state.localServers ?? [];
    if (ui.addSent != null && servers.length > ui.addSent) { ui.addSent = null; ui.add = { label: '', url: '', key: '', images: false }; if (ui.key === ADD) ui.key = null; }
    // Hydra Desktop runs on Claude only (the owner's Claude login): the one account to sign in to is Claude. Another
    // provider still signed in or with a saved key shows only so it can be removed.
    const accounts = state.providers.filter((p) => p.id === 'anthropic' || p.on);
    const { box, nav } = paged('accounts', accounts, (p) => (p.add ? addServerRow() : p.server ? serverRow(p) : el('li', { className: `acct${ui.key === p.id ? ' open' : ''}` },
      el('div', { className: 'setting' },
        // Connected: a lit dot by the name, its word in a tooltip (and for screen readers).
        el('span', { className: 'acct-name' }, p.id === 'anthropic' ? 'Claude' : p.label, p.on ? el('span', { className: 'led on', role: 'img', 'aria-label': p.method === 'local' ? 'Connected' : 'Signed in', 'data-tip': p.method === 'local' ? 'Connected' : 'Signed in' }) : null),
        p.on ? el('span', { className: 'row-btns' },
          ui.key === p.id ? null : armed(p.signedIn && !p.keySaved ? 'Sign out' : 'Remove', 'Confirm', `signout:${p.id}`, `signout:${p.id}`, `Remove ${p.label} from Hydra`))
          : state.loggingIn === p.id ? el('span', { className: 'waiting', textContent: 'Signing in…' })
          : p.method === 'oauth' ? signIn(p)
          : addKey(p)),
      null)),
    { label: 'Accounts', pin: accounts.findIndex((p) => p.id === ui.key) });
    // Tabs, so each part fits the window: the model you talk to, hybrid models, subagents, backups and the accounts. The
    // middle three need a signed-in account; with none, the page opens on Accounts.
    const hybrid = hybridGroup(), crew = subagentGroup(), backups = fallbackGroup();
    const tabs = [['default', 'Default'], hybrid ? ['hybrid', 'Hybrid'] : null, crew ? ['crew', 'Subagents'] : null, backups ? ['backups', 'Backups'] : null, ['accounts', 'Accounts']].filter(Boolean);
    const t = pageTab('model', tabs, on.length ? 'default' : 'accounts');
    const head = el('div', { className: 'mhead' }, tabRow('Model', 'model-panel', tabs, t, (id) => { ui.tabs.model = id; }));
    if (t === 'accounts') return [head, tabPanel('model-panel', t, el('div', { className: 'group paged' }, box)), foot(null, nav)];
    return [head, tabPanel('model-panel', t, ...(t === 'hybrid' ? [hybrid] : t === 'crew' ? [crew] : t === 'backups' ? [backups] : [group(null, 'Which AI answers you.', null,
      select ?? el('p', { className: 'empty', textContent: 'Sign in on the Accounts tab first.' }),
      effortRow('default', model, true),
      toggle('Lite mode', 'For small or local models. Fewer features.', state.lite, () => act('lite'), 'lite'))]))];
  }
  // Hybrid models: a fast default for chatting, and the jobs that switch to a model picked here, then back. Shown once
  // an account is signed in. Each job's value is '' (the default model) or 'provider:modelId'.
  function hybridGroup() {
    const h = state.hybrid;
    if (!h || !state.providers.some((p) => p.on)) return null;
    // The master switch: off leaves only the title, description and switch; on shows the job rows as well.
    const on = !!h.on;
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'A different model for each kind of job.' }),
        on && h.active ? el('p', { className: 'why', role: 'status', textContent: `Using ${modelName(h.active)} for this job` }) : null),
      toggle('Use hybrid models', 'Or name one: "use Opus for this".', on, () => act('hybrid'), 'hybrid'),
      on ? el('div', { className: 'setting' },
        el('span', { id: 'lbl-heavyall' }, 'Set all jobs to'),
        modelSelect('Set all jobs to', 'heavyall', '', 'Choose…', (sel) => { if (sel.value) { act(`heavyall:${sel.value}`); sel.value = ''; } })) : null,
      on ? h.jobs.map((j) => el('div', { className: 'slot' },
        el('div', { className: 'setting' },
          el('span', { id: `lbl-heavy-${j.kind}` }, j.label),
          modelSelect(`${j.label} model`, `heavy_${j.kind}`, j.value, 'Default model', (sel) => act(`heavy_${j.kind}:${sel.value}`))),
        j.value ? effortRow(j.kind, j.value) : null)) : null);
  }
  // If a limit is reached: up to two backup models, tried in order when a model hits its limit. Shown once an account
  // is signed in. state.fallbacks.slots are the first and second backup ('' or 'provider:modelId').
  function fallbackGroup() {
    const f = state.fallbacks;
    if (!f || !state.providers.some((p) => p.on)) return null;
    // The master switch: off leaves only the title, description and switch; on shows the backups and their status.
    const on = !!f.on;
    const slots = f.slots ?? ['', ''];
    const limits = (f.limited ?? []).map((x) => el('p', { className: 'why', role: 'status', textContent: x.until
      ? `${x.label} is at its limit until ${new Date(x.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : `${x.label} is at its limit; I'll try it again soon` }));
    const chain = state.model && slots.some(Boolean) ? `Order: ${[state.model.name, ...slots.filter(Boolean).map(modelName)].join(' → ')}` : null;
    const row = (i, label) => el('div', { className: 'slot' },
      el('div', { className: 'setting' },
        el('span', { id: `lbl-fallback-${i}` }, label),
        modelSelect(label, `fallback_${i}`, slots[i - 1] ?? '', 'None', (sel) => act(`fallback_${i}:${sel.value}`))),
      slots[i - 1] ? effortRow(`backup${i}`, slots[i - 1]) : null);
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'Up to two, tried in order.' }),
        on ? limits : null,
        on && f.using ? el('p', { className: 'why', role: 'status', textContent: `Using ${modelName(f.using)} for now` }) : null),
      toggle('Use backup models', 'Switch when a model hits its limit.', on, () => act('backups'), 'backups'),
      on ? row(1, 'First backup') : null,
      on ? row(2, 'Second backup') : null,
      on && chain ? el('p', { className: 'why wrap', textContent: chain }) : null);
  }
  // Subagents: specialists the chat hands background work to. Each runs on the model picked here; one with no model
  // follows the model hybrid models set for its kind of job (when those are on), else it is not on the crew.
  function subagentGroup() {
    const sa = state.subagents;
    if (!sa || !state.providers.some((p) => p.on)) return null;
    const on = !!sa.on, hybridOn = !!(state.hybrid && state.hybrid.on);
    return el('div', { className: 'group' },
      el('div', { className: 'ghead' }, el('p', { className: 'wrap', textContent: 'Specialists I hand background work to.' })),
      toggle('Use subagents', 'Up to three at once. They report back.', on, () => act('subagents'), 'subagents'),
      on ? el('div', { className: 'setting' },
        el('span', { id: 'lbl-delegate' }, 'Hand off'),
        picks('Hand off', [['ask', 'When I ask'], ['auto', 'On its own too']], sa.delegate ?? 'ask', (x) => act(`delegate_${x}`), 'delegate')) : null,
      on ? el('p', { className: 'why wrap', textContent: sa.delegate === 'auto' ? 'I also hand off long jobs myself.' : 'Only when you ask for an agent.' }) : null,
      on ? sa.crew.map((c) => el('div', { className: 'slot' },
        el('div', { className: 'setting' },
          el('span', { id: `lbl-crew-${c.id}` }, c.label, el('small', { className: 'wrap', textContent: c.via === 'hybrid' ? `${c.hint} Uses ${modelName(c.uses)}.` : c.hint })),
          modelSelect(`${c.label} model`, `crew_${c.id}`, c.value, hybridOn ? 'Follow hybrid' : 'Off', (sel) => act(`crew_${c.id}:${sel.value}`), true)),
        c.value ? effortRow(`sub_${c.id}`, c.value) : null)) : null);
  }
  // A local server: connected (a lit dot) or not, its address if it was added, and why its models aren't in the
  // Model menu (not running, or none can see images). Ollama and LM Studio disconnect; added ones are removed.
  function serverRow(x) {
    const remove = armed(x.custom ? 'Remove' : 'Disconnect', 'Confirm', `local:remove:${x.id}`, `local:remove:${x.id}`, `${x.custom ? 'Remove' : 'Disconnect'} ${x.label}`);
    return el('li', { className: 'acct' },
      el('div', { className: 'setting' },
        // An added server's address is in its name's tooltip, so every row stays one line.
        el('span', { className: 'acct-name' }, el('span', { className: 'acct-label', 'data-tip': x.baseUrl ?? null, tabIndex: x.baseUrl ? 0 : null, 'aria-describedby': x.baseUrl ? `addr-${x.id}` : null }, x.label, x.baseUrl ? el('span', { className: 'sr-only', id: `addr-${x.id}`, textContent: x.baseUrl }) : null),
          x.on ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Connected', 'data-tip': 'Connected' }) : null),
        el('span', { className: 'row-btns' }, x.on ? remove : x.custom ? el('span', { className: 'links' }, connect(x), remove) : connect(x))),
      x.note ? el('p', { className: 'empty note', textContent: x.note }) : null);
  }
  // Any other OpenAI-compatible server (llama.cpp, vLLM, oMLX…): a name, its address, a key if it needs one, and
  // whether its models can see images (most servers don't say). Saved once it answers; the sidecar says if it didn't.
  const ADD = 'local-add';
  function addServerRow() {
    const a = ui.add, open = ui.key === ADD;
    const field = (id, prop, label, o = {}) => el('span', { className: 'px field' }, el('input', {
      id, value: a[prop], 'aria-label': label, placeholder: o.placeholder ?? label, type: o.type ?? 'text', autocomplete: 'off', spellcheck: false, maxLength: o.max ?? 200,
      on: { input: (e) => { a[prop] = e.target.value; }, keydown: (e) => { if (e.key === 'Enter') save(); else if (e.key === 'Escape') { e.stopPropagation(); closeKey(); } } } }));
    const save = () => {
      const label = a.label.trim(), url = a.url.trim();
      if (!label) return $(`${ADD}-name`)?.focus() ?? $(`key-${ADD}`)?.focus();
      if (!url) return $(`${ADD}-url`)?.focus();
      ui.addSent = (state.localServers ?? []).length;
      send({ type: 'panel_local_add', label, baseUrl: url, key: a.key.trim(), images: a.images });
    };
    return el('li', { className: `acct${open ? ' open' : ''}` },
      el('div', { className: 'setting' },
        el('span', { className: 'acct-label', 'data-tip': 'llama.cpp, vLLM, oMLX or any OpenAI-compatible server.' }, 'Another server'),
        el('span', { className: 'row-btns' }, link(open ? 'Cancel' : 'Add server', () => toggleKey(ADD), { k: `addkey:${ADD}`, aria: open ? 'Cancel adding a server' : 'Add a server' }))),
      open ? el('div', { className: 'addserver', 'data-anim': `key-${ADD}` },
        el('div', { className: 'keyform' }, field(`key-${ADD}`, 'label', 'Server name', { placeholder: 'Name', max: 40 }), field(`${ADD}-url`, 'url', 'Server address', { placeholder: 'http://127.0.0.1:8080', max: 500 })),
        el('div', { className: 'keyform' }, field(`${ADD}-key`, 'key', 'API key (optional)', { type: 'password', max: 1000 }), btn('Save', save, { k: `save:${ADD}` })),
        toggle('Its models can see images', 'Most servers don\'t say, so tell me.', a.images, () => { a.images = !a.images; render(`img:${ADD}`); }, `img:${ADD}`)) : null);
  }
  function volumeRow() {
    const said = el('p', { className: 'why', 'aria-hidden': 'true' });
    const show = (n) => {
      const t = n === 0 ? 'Muted' : `${n}%`;
      range.style.setProperty('--p', n / 100);
      range.setAttribute('aria-valuetext', t);
      said.textContent = t;
    };
    const range = el('input', {
      type: 'range', className: 'effort-range', min: 0, max: 100, step: 5, value: state.volume ?? 100, 'data-k': 'volume', 'aria-label': 'Volume',
      on: { input: (e) => show(Number(e.target.value)), change: (e) => act(`volume:${e.target.value}`) },
    });
    show(Number(range.value));
    return el('div', { className: 'effort' }, el('p', { className: 'sub', textContent: 'Volume' }), range, said);
  }
  function speakingPage() {
    // Hydra speaks with Fish Audio once its key is in the Keychain; until then, with the Mac's own voice.
    const fish = !!state.fishKey;
    return [
      group('Spoken replies', null, null,
        picks('Replies', [['text', 'Text only'], ['voice', 'Voice and text']], state.replies, (x) => act(`replies:${x}`), 'replies'),
        volumeRow(),
        el('div', { className: 'setting' },
          el('span', {}, 'Voice', info(fish ? "Hydra's Fish Audio voice." : "The Mac's voice until a Fish Audio key is added.")),
          el('span', { className: 'val', textContent: fish ? 'Fish Audio' : 'Mac' })),
        fish && state.replies === 'voice' && state.fishModels?.length ? el('div', { className: 'reveal', 'data-anim': 'fish-model' },
          el('p', { className: 'sub', textContent: 'Voice model' }),
          picks('Voice model', state.fishModels.map((c) => [c.id, c.name]), state.fishModel, (x) => act(`fishmodel:${x}`), 'fishmodel',
            Object.fromEntries(state.fishModels.map((c) => [c.id, `${WHY_LONG[c.id] ?? ''} ${price(c)}`.trim()]))),
        ) : null,
        el('div', { className: 'setting' },
          el('span', {}, fish ? 'Fish Audio key' : 'Add a Fish Audio key', fish ? info(`Saved in ${where()}.`) : null),
          el('span', { className: 'row-btns' },
            link(ui.key === 'fish' ? 'Cancel' : fish ? 'Change' : 'Add', () => toggleKey('fish'), { k: 'addkey:fish', aria: fish ? 'Change the Fish Audio key' : 'Add a Fish Audio key' }),
            fish && ui.key !== 'fish' ? armed('Remove', 'Confirm', 'fishkey-remove', 'fishkey_remove', 'Remove the Fish Audio key') : null)),
        keyForm('fish', 'Fish Audio', (key) => send({ type: 'panel_fishkey', key }))),
    ];
  }
  // Which mic I listen on (from #59, by overspend1): automatic (the system's default, or on a Mac the built-in mic while
  // that's a Bluetooth headset, which would drop to call-quality sound), or one picked here, kept while it's unplugged.
  function micPicker(v) {
    if (!v.mics?.length) return null;
    const gone = v.mic && !v.mics.some((m) => m.id === v.mic);
    return el('div', { className: 'reveal', 'data-anim': 'mic' },
      el('p', { className: 'sub', textContent: 'Microphone' }),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Microphone', 'data-k': 'mic', on: { change: (e) => act(`mic:${e.target.value}`) } },
          el('option', { value: '', textContent: v.micAuto ? `Automatic (${v.micAuto})` : 'Automatic', selected: !v.mic }),
          v.mics.map((m) => el('option', { value: m.id, textContent: m.name, selected: m.id === v.mic })),
          gone ? el('option', { value: v.mic, textContent: 'Picked mic (unplugged, using automatic)', selected: true }) : null)));
  }
  // The language I listen for (macOS). 'auto' follows the Mac's own languages; a locale id names one. langOnline: true when
  // Apple's servers recognise it (the audio leaves this Mac); null when unknown, which is what Arabic and Hebrew do today.
  const SPEAK_LANGS = [['auto', 'Automatic (my Mac\'s languages)'], ['en-US', 'English'], ['ar-SA', 'العربية · Arabic'], ['he-IL', 'עברית · Hebrew'],
    ['es-ES', 'Español · Spanish'], ['fr-FR', 'Français · French'], ['de-DE', 'Deutsch · German'], ['it-IT', 'Italiano · Italian'],
    ['pt-BR', 'Português · Portuguese'], ['ja-JP', '日本語 · Japanese'], ['ko-KR', '한국어 · Korean'], ['zh-CN', '中文 · Chinese'], ['hi-IN', 'हिन्दी · Hindi']];
  const SPEAK_ONLINE = 'This language goes to Apple\'s servers. Add it under Dictation in System Settings to keep it on this Mac.';
  // The Speak in select, shown on a Mac while voice control is on, with the online hint under it when it applies.
  function speakPicker(v) {
    const lang = v.lang ?? 'auto';
    const online = v.langOnline === true || (['ar-SA', 'he-IL'].includes(lang) && v.langOnline == null);
    return el('div', { className: 'reveal', 'data-anim': 'speakin' },
      el('p', { className: 'sub' }, 'Speak in', info('The language you talk to me in.')),
      el('span', { className: 'px field select' },
        el('select', { 'aria-label': 'Language I speak', 'data-k': 'speechlang', on: { change: (e) => act(`speechlang:${e.target.value}`) } },
          SPEAK_LANGS.map(([code, label]) => el('option', { value: code, textContent: label, dir: 'auto', selected: code === lang })))),
      online ? el('p', { className: 'why wrap', role: 'status', textContent: SPEAK_ONLINE }) : null);
  }
  // Wayland: the commands to bind to keys in the desktop's settings (no app may hold its own shortcuts there).
  // A command shows only after copying it failed, so it can be copied by hand.
  const BIND_ROWS = [['talk', 'Talk to me'], ['summon', 'Show or hide me'], ['ask', 'Ask me'], ['list', 'Your list'], ['panel', 'This panel']];
  // Talking to me, and when the mic opens without a key.
  function listeningPage() {
    const v = state.voice;
    if (!v) return [group('Listening', 'Voice input isn’t available on this computer.', null)];
    const needs = (hint) => (v.on ? hint : 'Needs Voice control on');
    const tabs = [['talking', 'Talking'], ['handsfree', 'Hands-free']], t = pageTab('listening', tabs);
    const head = el('div', { className: 'mhead' }, tabRow('Listening', 'listen-panel', tabs, t, (id) => { ui.tabs.listening = id; }));
    return [head, tabPanel('listen-panel', t, t === 'talking'
      ? group(null, 'Speak instead of typing.', null,
        toggle('Voice control', v.download
          ? (v.download.status === 'downloading' ? `Downloading the voice model… ${v.download.pct}%` : v.download.status === 'error' ? 'The download failed' : `Needs a ${v.download.size} download`)
          : v.keys ? `Hold ${v.keys} to talk` : 'Press your talk shortcut to talk', v.on, () => act('voice'), 'voice'),
        v.download && v.download.status !== 'downloading' ? el('div', { className: 'links' }, link(v.download.status === 'error' ? 'Retry the download' : `Download (${v.download.size})`, () => act('voicedl'), { k: 'voicedl' })) : null,
        micPicker(v),
        v.mac ? toggle('Mute Mac while talking', 'Other sounds go quiet while you talk', v.mute, () => act('mutetalk'), 'mutetalk') : null,
        v.mac && v.on ? speakPicker(v) : null)
      : [group('Triggers', 'Ways to start talking without a key. Heard on this Mac only; nothing leaves it until you talk.', null,
        v.mac ? toggle('Clap to talk', needs('A double clap starts listening. Asleep, it wakes Hydra.'), v.clapTalk, () => act('claptalk'), 'claptalk') : null,
        v.wake ? toggle('Key phrase', needs(`Say “${v.wakePhrase || 'Hey Hydra'}”, or just “Hydra”, to start listening. Asleep too: it wakes Hydra.`), v.wakeWord, () => act('wakeword'), 'wakeword') : null,
        v.wake ? phraseRow(v) : null,
        // Set in Hydra (agent_settings.sleep_word): shown here, changed there.
        el('div', { className: 'setting' }, el('span', {}, 'Sleep word', info('Puts Hydra to sleep at once. Change it in Hydra.')),
          el('span', { className: 'val', textContent: v.sleepWord ?? 'Hydra, sleep' })),
        v.mac ? toggle('Interrupt by talking', v.bargeNA ? 'Off for now: this mic has no echo cancellation, so Hydra could hear its own voice and stop itself. It tries again with another mic.' : needs('Talk while Hydra speaks to stop it and say something new. A double clap does it too. Uses the Mac\'s echo cancellation.'), v.barge, () => act('barge'), 'barge') : null),
      group('After replies', 'When the mic opens without a key.', null,
        toggle('Auto-listen', needs(v.listenEvery ? 'Mic opens after every spoken reply.' : 'Mic opens when I ask you something.'), v.autoListen, () => act('autolisten'), 'autolisten'),
        v.autoListen && v.listenChoices ? el('div', { className: 'reveal', 'data-anim': 'listen-more' },
          toggle('After every reply', needs('Not just questions, so you can keep talking.'), v.listenEvery, () => act('listenevery'), 'listenevery'),
          el('p', { className: 'sub', textContent: 'Mic waits for you' }),
          picks('Mic waits for you', v.listenChoices.map((s) => [String(s), `${s} s`]), String(v.listenSecs), (x) => act(`listensecs:${x}`), 'listensecs')) : null,
        toggle('Listen after reminders', needs('Mic opens after a reminder, so you can say “snooze 10 minutes”.'), v.snoozeListen, () => act('snoozelisten'), 'snoozelisten'))])];
  }
  // The wake phrase, typed in place (no prompt: that one rendered on the orb, hidden while it's in the Hydra window).
  // Enter or leaving the field saves it; Esc puts it back.
  function phraseRow(v) {
    const now = v.wakePhrase || 'Hey Hydra';
    const save = (input) => {
      const t = input.value.trim().replace(/\s+/g, ' ');
      ui.phrase = null;
      if (t && t !== now) act(`wakephrase:${t}`); else input.value = now;
    };
    const input = el('input', { type: 'text', value: ui.phrase ?? now, 'aria-labelledby': 'lbl-wakephrase', 'data-k': 'wakephrase', autocomplete: 'off', spellcheck: false, maxLength: 40,
      on: {
        input: (e) => { ui.phrase = e.target.value; },
        keydown: (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
          else if (e.key === 'Escape') { e.stopPropagation(); ui.phrase = null; e.target.value = now; e.target.blur(); }
        },
        change: (e) => save(e.target),
      } });
    return el('div', { className: 'setting' },
      el('span', { id: 'lbl-wakephrase' }, 'Wake phrase', info('Two to six words, like Hey Hydra. Saved in Hydra too when paired.')),
      el('span', { className: 'px field phrase' }, input));
  }
  // The keys that work from anywhere. On Wayland no app may hold its own, so it lists the commands to bind instead.
  const SHORTCUT_LABELS = { summon: 'Show or hide me', snap: 'Ask about an area', list: 'Your list' };
  function shortcutsPage() {
    const b = state.bind, sc = state.shortcuts, w = state.writeKeys;
    if (b) {
      return [group('Shortcuts', 'Add these as custom shortcuts in your keyboard settings, with any keys you like.', null,
        BIND_ROWS.filter(([k]) => b[k]).map(([k, label]) => el('div', { className: 'setting' },
          el('span', {}, label, ui.bindShown.has(k) ? el('small', { className: 'cmd', textContent: b[k] }) : null),
          link('Copy', () => send({ type: 'copy_bind', which: k }), { k: `bind-${k}`, aria: `Copy the command for ${label.toLowerCase()}` }))))];
    }
    if (!sc) return [group('Shortcuts', 'This computer doesn’t allow shortcuts that work from anywhere.', null)];
    return [
      sc.talk ? group('Talk', 'Hold two keys to talk. Tap them to talk hands-free.', null,
        picks('Talk keys', sc.talk.pairs, sc.talk.value, (x) => act(`talk:${x}`), 'talk',
          Object.fromEntries(sc.talk.pairs.map(([id, keys]) => [id, `Hold ${keys} to talk. If they’re your typing keys, the two swap.`])))) : null,
      w ? group('Type to me', 'Tap two keys together to open a text box by the cursor.', null,
        picks('Type-to-ask keys', [...w.pairs, ['off', 'Off']], w.value, (x) => act(`write:${x}`), 'write',
          Object.fromEntries([...w.pairs.map(([id, keys]) => [id, `Tap ${keys} together, anywhere, to type to me.`]),
            ['off', 'No tap opens the text box, so the keys stay free for other apps. The Ask button on Home still opens it.']]))) : null,
      group('Other keys', 'Press Change, then the new keys. Esc cancels.', null,
        sc.keys.map(({ id, words }) => {
          const rec = ui.rec === id, label = SHORTCUT_LABELS[id] ?? id;
          return el('div', { className: `setting${rec ? ' recording' : ''}` },
            el('span', {}, label, el('small', { textContent: rec ? 'Press the new keys…' : words, 'aria-live': rec ? 'polite' : null })),
            link(rec ? 'Cancel' : 'Change', () => { ui.rec = rec ? null : id; render(`rec-${id}`); }, { k: `rec-${id}`, aria: rec ? `Stop changing the keys for ${label.toLowerCase()}` : `Change the keys for ${label.toLowerCase()}` }));
        })),
    ];
  }
  // Things I do on my own through the day.
  function routinesTab() {
    const f = state.focus;
    return { body: [
      group(null, 'Things I do on my own through the day.', null,
        state.brief ? toggle('Morning briefing', 'The first time you talk to me each day, I start with what’s due.', state.brief.on, () => act('morningbrief'), 'morningbrief') : null,
        state.brief?.on && state.brief.canTodoist ? toggle('Include Todoist', 'I read your Todoist window (opening it if needed). Stay signed in.', state.brief.todoist, () => act('brieftodoist'), 'brieftodoist') : null,
        f ? el('div', { className: 'setting' },
          el('span', {}, f.until ? 'Focus block running' : 'Focus distractions',
            el('small', { className: 'wrap', textContent: f.until ? `Until ${new Date(f.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${f.task ? ` · ${f.task}` : ''}` : `Say “focus for 30 minutes”. I watch for: ${f.list.slice(0, 4).join(', ')}${f.list.length > 4 ? '…' : ''}` })),
          f.until ? link('Stop', () => act('focusstop'), { k: 'focusstop', aria: 'Stop the focus block' }) : link('Edit', () => act('distractions'), { k: 'distractions', aria: 'Edit the distraction list' })) : null),
      jobGroup(),
    ] };
  }
  // Work an agent does at set times. They're made by asking (schedule_job); here they're run, paused or removed.
  function jobGroup() {
    const jobs = state.jobs ?? [];
    return group('Scheduled jobs', 'Work an agent does for you at set times. Ask me to schedule one.', jobs.length || null,
      jobs.length ? el('ul', { className: 'list', 'aria-label': 'Scheduled jobs' }, jobs.map((j) => el('li', { className: 'item mem' },
        el('span', { className: 'text', dir: 'auto', title: j.title }, j.title,
          el('small', { textContent: `${j.next}${j.repeat ? ` · ↻ ${j.repeat}` : ''}` }),
          j.last ? el('small', { className: j.bad ? 'late' : '', textContent: j.last, title: j.last }) : null),
        el('span', { className: 'row-btns' },
          link('Run now', () => act(`job:run:${j.id}`), { k: `job:run:${j.id}`, aria: `Run ${j.title} now` }),
          link(j.paused ? 'Resume' : 'Pause', () => act(`job:${j.paused ? 'resume' : 'pause'}:${j.id}`), { k: `job:pause:${j.id}`, aria: `${j.paused ? 'Resume' : 'Pause'} ${j.title}` }),
          armed('Remove', 'Confirm', `job:remove:${j.id}`, `job:remove:${j.id}`, `Remove ${j.title}`))))) : el('p', { className: 'empty', textContent: 'No scheduled jobs yet.' }));
  }
  // Apps and services I use through their MCP servers. They're added by asking me (I find the server, ask before
  // connecting, and take any key in the chat input); here they're switched off, signed in to or removed.
  const CONN_STATE = { connected: (x) => `Connected · ${x.toolCount} tool${x.toolCount === 1 ? '' : 's'}`, 'needs-login': () => 'Needs sign-in', 'needs-key': (x) => `Needs a key${x.error ? ` (${x.error.replace(/^needs /, '')})` : ''}`,
    error: (x) => `Not working: ${x.error ?? 'no answer'}`, off: () => 'Off', connecting: () => 'Connecting…', idle: () => 'Not connected yet' };
  function connectionsTab() {
    const list = state.connections ?? [];
    const { box, nav } = paged('connections', list, (x) => {
      const bad = x.state === 'error' || x.state === 'needs-key' || x.state === 'needs-login';
      return el('li', { className: 'acct' }, el('div', { className: 'setting' },
        el('span', { id: `lbl-mcp-${x.name}` }, el('span', { className: 'acct-name' }, x.name, x.state === 'connected' ? el('span', { className: 'led on', role: 'img', 'aria-label': 'Connected', 'data-tip': 'Connected' }) : null),
          el('small', { className: bad ? 'late' : '', textContent: (CONN_STATE[x.state] ?? CONN_STATE.idle)(x), title: x.where })),
        el('span', { className: 'row-btns' },
          x.state === 'needs-login' ? link('Sign in', () => act(`mcp:login:${x.name}`, true), { k: `mcp:login:${x.name}`, aria: `Sign in to ${x.name}` }) : null,
          armed('Remove', 'Confirm', `mcp:remove:${x.name}`, `mcp:remove:${x.name}`, `Remove the ${x.name} connection and its keys`),
          el('button', { className: 'px switch', type: 'button', role: 'switch', 'aria-checked': String(!!x.enabled), 'aria-labelledby': `lbl-mcp-${x.name}`, 'data-k': `mcp:sw:${x.name}`,
            on: { click: () => act(`mcp:${x.enabled ? 'off' : 'on'}:${x.name}`) } }))));
    }, { label: 'Connections', empty: 'No apps connected yet.' });
    return {
      body: [group(null, 'Apps like Linear and Notion I can use for you.', null), el('div', { className: 'group paged' }, box)],
      foot: foot(btn('Connect an app', () => act('askconnect', true), { k: 'askconnect' }), nav),
    };
  }
  // What I may do, and when I start.
  function generalPage() {
    return [
      group('General', 'What I may do, and when I start.', null,
        toggle('Sound effects', null, state.sound, () => act('sound'), 'sound'),
        state.notch != null ? group('Where I appear', 'Beside your cursor, or from the top of the screen.', null,
          picks('Where I appear', [['off', 'Beside the cursor'], ['drop', 'Capsule'], ...(state.notchReal ? [['spread', 'Notch']] : [])], state.notch, (x) => act(`notch_${x}`), 'notch',
            { off: 'Everything beside your cursor, as usual.', spread: 'Everything in the notch, widening sideways.', drop: state.notchReal ? 'Everything in a capsule that drops from the notch.' : 'Everything in a capsule at the top of the screen.' })) : null,
        state.gameMode != null ? toggle('Game mode', 'In a fullscreen game, I move to a panel at the edge of the screen.', state.gameMode, () => act('gamemode'), 'gamemode') : null,
        toggle('Allow file edits and commands', 'Change files and run commands', state.actions, () => act('actions'), 'actions'),
        state.learnSkills != null ? toggle('Learn skills', 'After a long task that worked, I keep the how-to for next time.', state.learnSkills, () => act('learnskills'), 'learnskills') : null,
        state.login ? toggle('Open at login', null, state.login.on, () => act('login'), 'login') : null,
        state.sync ? el('div', { className: 'setting' },
          el('span', {}, 'Sync memory', el('small', { title: state.sync.dir, textContent: !state.sync.dir ? 'Share reminders and memory with your other computer' : state.sync.error ? `Not syncing: ${state.sync.error}` : `Via ${state.sync.dir.split(/[\\/]/).filter(Boolean).pop()}${state.sync.at ? ` · ${new Date(state.sync.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}` })),
          state.sync.dir ? [state.sync.paused ? link('Sync anyway', () => act('syncallow'), { k: 'syncallow', danger: true, aria: 'Sync anyway, removing those items on every computer' }) : null,
            link('Stop', () => act('syncstop'), { k: 'syncstop', aria: 'Stop syncing memory' })] : link('Set up', () => act('syncsetup'), { k: 'syncsetup', aria: 'Set up memory sync' })) : null),
    ];
  }
  // ---------------------------------------------------------------- Hydra
  // The agent: awake or asleep (5 minutes without talk; a double clap or Wake brings it back), the sleep word, how
  // easily a double clap wakes it, and the link to Hydra's data (the Hydra agent API, paired later).
  const CLAP = [['0.2', 'Low'], ['0.5', 'Medium'], ['0.8', 'High']];
  function hydraPage() {
    const h = state.hydra ?? {};
    const clap = CLAP.reduce((best, [v]) => (Math.abs(+v - (h.clap ?? 0.5)) < Math.abs(+best - (h.clap ?? 0.5)) ? v : best), '0.5');
    return [
      group('Agent', 'Asleep after 5 minutes without talk. A double clap or the wake phrase wakes it. The sleep word and the other triggers are on the Listening page.', null,
        el('div', { className: 'setting' },
          el('span', {}, h.asleep ? 'Asleep' : 'Listening'),
          h.asleep ? btn('Wake', () => act('power:wake'), { kind: 'primary', k: 'power:wake' }) : btn('Sleep', () => act('power:sleep'), { k: 'power:sleep' })),
        toggle('Detached orb', 'Off: the orb lives in the Hydra window, and the menu bar icon shows its state while that window is hidden. On: it floats on the desktop, bottom right.', h.detached, () => act(h.detached ? 'orb:attach' : 'orb:detach'), 'orbmode'),
        state.sizes?.length > 1 ? [el('p', { className: 'sub', textContent: 'Size' }),
          picks('Size', state.sizes, state.size ?? 'default', (x) => act(`size:${x}`), 'size', { small: '40 px across.', default: '48 px across.', large: '64 px across.' })] : null,
        el('p', { className: 'sub', textContent: 'Clap sensitivity' }),
        picks('Clap sensitivity', CLAP, clap, (x) => act(`clapsens:${x}`), 'clapsens', { '0.2': 'Only loud claps close by.', '0.5': 'Claps from across a desk.', '0.8': 'Softer claps from across the room.' }),
        state.voice?.mac ? [el('div', { className: 'setting' },
          el('span', {}, 'Your claps', info(h.clapCal ? 'Set from your own claps in this room. Clap twice again to set it anew.' : 'Clap twice and I learn how your claps sound in this room.')),
          btn(h.clapCalibrating ? 'Listening…' : h.clapCal ? 'Again' : 'Clap twice', () => act('clapcal'), { k: 'clapcal', disabled: h.clapCalibrating, aria: 'Clap twice to set how your claps sound' })),
        // The live clap level, and the mark a clap must reach (clap_level from the voice helper, 10 a second).
        el('div', { className: 'clapmeter', id: 'clapmeter', role: 'meter', 'aria-label': 'Clap level', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'data-tip': 'Clap: the bar should pass the mark.' },
          el('span', { className: 'fill' }), el('span', { className: 'mark' }))] : null),
      group("Hydra's data", 'The Hydra agent API. Pairing comes with it.', null,
        h.olderData ? el('div', { className: 'setting' },
          el('span', {}, 'Older data', info(`Hydra now keeps its data in ~/HydraAgent. ${h.olderData} is still there with older data; nothing in it was changed or removed.`)),
          el('span', { className: 'val', textContent: h.olderData })) : null,
        el('div', { className: 'setting' },
          el('span', {}, 'Address', info(h.url || 'Not set')),
          el('span', { className: 'row-btns' }, el('span', { className: 'val', textContent: h.url ? h.url.replace(/^https:\/\//, '') : 'Not set' }), link(h.url ? 'Change' : 'Add', () => act('hydra_url', true), { k: 'hydra_url', aria: 'Set the Hydra address' }))),
        el('div', { className: 'setting' },
          el('span', {}, 'Device key', info(`Kept in ${where()}.`)),
          el('span', { className: 'row-btns' }, el('span', { className: 'val', textContent: h.link === 'ready' ? 'Saved' : 'Not set' }), link(h.link === 'ready' ? 'Change' : 'Add', () => act('hydra_key', true), { k: 'hydra_key', aria: 'Set the Hydra device key' }))),
        el('div', { className: 'setting' },
          el('span', {}, 'Sign-in link', info("Hydra's email sign-in link opens in your browser. Paste it here to sign in the Hydra window.")),
          link('Paste', () => act('signin_link', true), { k: 'signin_link', aria: 'Paste a Hydra sign-in link' })),
        el('div', { className: 'setting' },
          el('span', {}, 'Status'),
          el('span', { className: 'val', textContent: h.link === 'ready' ? `Paired · ${h.tools ?? 0} tools` : h.link === 'unpaired' ? 'Not paired' : 'Off' }))),
    ];
  }

  // ---------------------------------------------------------------- About
  const SOURCE = [
    ['Source code', 'https://github.com/EasonJiangOfficial/hydra-desktop'],
    ['Roamies, the original', 'https://github.com/KenKaiii/Roamies'],
    ['License: AGPL-3.0', 'https://www.gnu.org/licenses/agpl-3.0.html'],
  ];
  function aboutPage() {
    return [
      group('Hydra Desktop', null, null,
        el('p', { className: 'notice', textContent: 'Hydra Desktop is a modified version of Roamies by Ken Kai (AGPL-3.0)' }),
        SOURCE.map(([label, url]) => el('div', { className: 'setting' },
          el('span', {}, label),
          link('Open', () => send({ type: 'open_link', url }), { k: `src-${label}`, aria: `Open ${label}` })))),
      group('Help', null, null,
        el('div', { className: 'links' },
          link('Setup guide', () => act('setup', true), { k: 'setup' }),
          link('Show logs', () => act('logs'), { k: 'logs' }),
          link('Save diagnostics', () => act('diagnostics'), { k: 'diagnostics', aria: 'Save a diagnostics file to send when something goes wrong' }),
          state.problem ? link('Copy last error', copyProblem, { k: 'copy-problem' }) : null)),
    ];
  }

  // ---------------------------------------------------------------- render
  const PANES = { home, hydra: hydraPage, memory, abilities: abilitiesPage, model: modelPage, speaking: speakingPage, listening: listeningPage, shortcuts: shortcutsPage, general: generalPage, about: aboutPage };
  // focusKey: what to focus after (a data-k, or an element id); otherwise whatever had focus keeps it.
  function render(focusKey, animate = false) {
    if (!state) return;
    const active = document.activeElement;
    // Never rebuild under someone typing a key: catch up when they leave the field.
    if (!focusKey && !animate && active?.tagName === 'INPUT' && active.closest('.pane')) { deferred = true; return; }
    deferred = false;
    const keep = focusKey ?? active?.dataset?.k ?? (active?.id?.startsWith('key-') ? active.id : null);
    hideTip();
    const scroll = $('pane-' + tab).closest('.body').scrollTop;
    head();
    const pane = $(`pane-${tab}`);
    const same = render.tab === tab; render.tab = tab;
    const before = new Set([...pane.querySelectorAll('[data-anim]')].filter(shown).map((n) => n.dataset.anim));
    // A page with a list fits it to the room left and pages it; any other page scrolls.
    const draw = () => { pane.replaceChildren(...PANES[tab]().flat().filter(Boolean));
    pane.classList.toggle('paged', !!pane.querySelector('.pagebox')); keepGone(); };
    draw();
    // Lists show as many rows as fit: drawn once to measure, again if a different number fits.
    if (fit()) draw();
    pane.closest('.body').scrollTop = scroll;
    if (same && !animate) for (const n of pane.querySelectorAll('[data-anim]')) if (shown(n) && !before.has(n.dataset.anim)) grow(n, true);
    // Rows fill in one after another (a page's worth; the rest come with the last), only when it opens or
    // the tab changes, never on the updates that arrive while it's open.
    pane.classList.toggle('enter', animate);
    if (animate) {
      let i = 0;
      for (const n of pane.children) { n.style.setProperty('--i', Math.min(i++, 10)); for (const li of n.querySelectorAll('.list > li')) li.style.setProperty('--i', Math.min(i++, 10)); }
      clearTimeout(render.t); render.t = setTimeout(() => pane.classList.remove('enter'), 600);
    }
    if (keep) (document.querySelector(`.pane [data-k="${CSS.escape(keep)}"]`) ?? document.getElementById(keep))?.focus();
    meterWanted(tab === 'hydra' && !!state.voice?.mac);
  }
  // The live clap level runs only while the Agent page shows.
  function meterWanted(on) { if (on !== !!ui.meter) { ui.meter = on; act(on ? 'clapmeter:on' : 'clapmeter:off'); } }
  const dbTo = (db) => Math.max(0, Math.min(1, (db + 80) / 80));
  function clapLevel(m) {
    const n = $('clapmeter');
    if (!n) return;
    const v = dbTo(m.db), mark = dbTo(m.needs);
    n.style.setProperty('--v', v.toFixed(3)); n.style.setProperty('--n', mark.toFixed(3));
    n.classList.toggle('hit', m.db >= m.needs);
    n.setAttribute('aria-valuenow', String(Math.round(v * 100)));
  }

  // ---- an ask from the agent while the orb is in the Hydra window (the overlay that draws asks is hidden then) ----
  // It slides down over the page: a question with its choices (the first one is yes), or a field with Send. The panel
  // closing (it lost focus) is never an answer: the ask is kept and shows again when the panel opens (C3).
  let askNow = null, askHeld = null;
  function askSheet(m) {
    closeAsk(null, false);
    askHeld = null;
    const question = m.prompt || m.placeholder || '';
    const answer = (text) => { const id = m.id; closeAsk(id, true); send({ type: 'answer', id, text }); };
    const choices = Array.isArray(m.choices) && m.choices.length ? m.choices.map(String) : null;
    const input = choices ? null : el('input', { type: m.mask ? 'password' : 'text', value: m.value || '', placeholder: m.prompt ? (m.placeholder || '') : '', 'aria-label': question, autocomplete: 'off', spellcheck: false, maxLength: 2000,
      on: { keydown: (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); answer(input.value); } else if (e.key === 'Escape') { e.stopPropagation(); answer(null); } } } });
    const sheet = el('div', { className: 'asksheet', role: 'dialog', 'aria-label': question, 'data-ask': m.id },
      el('p', { className: 'askq', dir: 'auto', textContent: question }),
      choices
        ? el('div', { className: 'askrow' }, choices.map((c, i) => btn(c, () => answer(i === 0 ? 'yes' : null), { kind: i === 0 ? 'primary' : 'ghost', k: `ask-${i}` })))
        : el('div', { className: 'askrow' }, el('span', { className: 'px field' }, input), btn('Send', () => answer(input.value), { kind: 'primary', k: 'ask-send' }), btn('Cancel', () => answer(null), { k: 'ask-cancel' })));
    document.querySelector('.body').prepend(sheet);
    askNow = { id: m.id, sheet, m };
    setTimeout(() => (input ?? sheet.querySelector('button'))?.focus(), 30);
  }
  function closeAsk(id, animate) {
    if (!askNow || (id != null && askNow.id !== id)) return;
    const { sheet } = askNow;
    askNow = null;
    if (!animate || REDUCED.matches) return sheet.remove();
    sheet.classList.add('out');
    setTimeout(() => sheet.remove(), 170);
  }
  document.addEventListener('focusout', (e) => { if (deferred && e.target.tagName === 'INPUT') setTimeout(() => deferred && render(), 0); });
  // The window changes size with the screen it opens on: as many rows as fit there.
  let resizeTimer = 0;
  addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => state && render(), 120); });

  // copy: the app has the full error behind this line; Copy details puts it on the clipboard (and the note stays
  // up longer, to leave time to press it).
  const copyProblem = () => send({ type: 'copy_problem', from: 'panel' });
  let noteTimer = 0;
  function note(text, bad = false, copy = false) {
    const n = $('note');
    n.replaceChildren(el('span', { textContent: text, title: text }), ...(copy ? [link('Copy details', copyProblem, { k: 'note-copy' })] : []));
    n.removeAttribute('title'); n.className = `note${bad ? ' bad' : ''}`; n.hidden = false;
    clearTimeout(noteTimer); noteTimer = setTimeout(() => { n.hidden = true; }, copy ? 20000 : bad ? 9000 : 5000);
  }

  // ---------------------------------------------------------------- sidebar and keys
  const TABS = Object.keys(PANES);
  const navi = (t) => $(`nav-${t}`);
  function show(name, focus = false) {
    // Pages that became Abilities tabs (and Memory's old Skills tab) open that tab.
    if (ABILITY_TABS.some(([id]) => id === name)) { ui.tabs.abilities = name; name = 'abilities'; }
    if (!PANES[name]) name = name === 'settings' ? 'model' : 'home';
    const changed = name !== tab;
    if (!changed && !focus) return;
    tab = name;
    disarm(); ui.key = null; ui.rec = null;
    for (const t of TABS) {
      if (t === name) navi(t).setAttribute('aria-current', 'page'); else navi(t).removeAttribute('aria-current');
      $(`pane-${t}`).hidden = t !== name;
    }
    $('pane-' + name).closest('.body').scrollTop = 0;
    render(null, changed);
    const t = navi(name);
    if (changed) { t.classList.remove('ping'); void t.offsetWidth; t.classList.add('ping'); }
    if (focus) t.focus();
  }
  document.querySelector('.side').addEventListener('animationend', (e) => e.target.classList.remove('ping'));
  for (const t of TABS) navi(t).addEventListener('click', () => show(t));
  // Up and down walk the sidebar (Home and End jump to its ends); Tab goes on into the page.
  document.querySelector('.side').addEventListener('keydown', (e) => {
    const i = TABS.indexOf(e.target.dataset?.page);
    if (i < 0) return;
    const n = TABS.length;
    const j = e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
    if (j >= 0) { e.preventDefault(); show(TABS[j], true); }
  });
  // Changing a shortcut on the Shortcuts page: the next key with Control, Option (Alt) or Command (Win) is the new one.
  const KEY_CODE = /^(Key[A-Z]|Digit\d|F\d{1,2}|Space|Backquote|Minus|Equal|BracketLeft|BracketRight|Backslash|Semicolon|Quote|Comma|Period|Slash)$/;
  document.addEventListener('keydown', (e) => {
    const which = ui.rec;
    if (!which) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.key === 'Escape') { ui.rec = null; render(`rec-${which}`); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key) || !KEY_CODE.test(e.code)) return;
    const mods = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Command'].filter(Boolean);
    if (!mods.some((x) => x !== 'Shift')) { note(state.os === 'mac' ? 'Hold Control, Option or Command too.' : 'Hold Ctrl or Alt too.', true); return; }
    ui.rec = null;
    act(`shortcut:${which}:${[...mods, e.code].join('+')}`);
    render(`rec-${which}`);
  }, true);
  // Radio groups: arrows move the choice, like the setup guide's.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && tipFor) { e.preventDefault(); hideTip(); return; }
    if (e.key === 'Escape' && !e.defaultPrevented) { const was = ui.arm; if (ui.key) closeKey(); else if (disarm()) render(was ?? undefined); else hide(); return; }
    const tl = e.target.closest?.('[role="tablist"]');
    if (tl && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const all = [...tl.querySelectorAll('[role="tab"]')], i = all.indexOf(e.target);
      all[(i + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length]?.click();
      return;
    }
    const g = e.target.closest?.('[role="radiogroup"]');
    if (!g || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const all = [...g.querySelectorAll('[role="radio"]')], i = all.indexOf(e.target);
    const next = all[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length];
    next?.click();
    // Focus follows the choice (the group may be redrawn when the new state arrives).
    const k = next?.dataset.k;
    if (k) { next.focus(); setTimeout(() => document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus(), 200); }
  });
  // The recent list's "2m ago" stays true while it's open.
  setInterval(() => { if (tab === 'home' && !document.hidden) render(); }, 30000);

  // Switching on and off. main.rs calls these as it shows the window and before it hides it. One listener, and it
  // only acts on the animation that's playing now: a close cut short (the window hides on the last frame, which
  // pauses it) must never finish later and blank the panel it just reopened.
  const body = $('frame');
  body.addEventListener('animationend', (e) => {
    if (e.target !== body) return;
    if (e.animationName === 'crt-on' && body.classList.contains('opening')) body.classList.remove('opening');
    else if (e.animationName === 'crt-off' && body.classList.contains('shutting')) { body.classList.remove('shutting'); body.classList.add('shut'); }
  });
  window.__panelOpen = (fromBottom = false) => {
    body.classList.remove('shut', 'shutting', 'opening');
    // The Roamie switches on with the panel, and waves if it's been a while.
    if (avatar) { avatar.kit.vanish(null, true); setTimeout(() => { avatar.appear(); if (Date.now() - seen.opened > 10 * 60e3) setTimeout(() => avatar.act('wave'), 500); seen.opened = Date.now(); }, REDUCED.matches ? 0 : 120); }
    body.classList.toggle('from-bottom', !!fromBottom);
    const held = askHeld;
    if (REDUCED.matches) { render(null, false); if (held) askSheet(held); return; }
    void body.offsetWidth;
    body.classList.add('opening');
    render(null, true);
    if (held) askSheet(held);
  };
  window.__panelShut = () => {
    disarm(); ui.key = null; unarmQuit(); meterWanted(false);
    if (askNow) { askHeld = askNow.m; closeAsk(askNow.id, false); }
    body.classList.remove('opening');
    if (REDUCED.matches) { body.classList.add('shut'); return; }
    body.classList.add('shutting');
  };
  // A click anywhere else puts an armed Confirm back.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#head-quit')) unarmQuit();
    if (ui.arm && !e.target.closest?.('.arm[aria-pressed="true"], .ibtn[aria-pressed="true"]')) {
      const text = document.querySelector('.pane .arm[aria-pressed="true"]');
      disarm(); calmIcons(); if (text) render(); // a tick or X goes back in place, so it can ease back
    }
  }, true);

  window.__panel = (m) => {
    if (m.kind === 'state') {
      const first = !state; state = m.state;
      if (ui.arm && !document.querySelector(`[data-k="${CSS.escape(ui.arm)}"]`)) ui.arm = null;
      render(null, first);
      if (m.state.tab) show(m.state.tab, true); // opened for a reason (asked with nothing signed in: the Model page)
    }
    else if (m.kind === 'note') note(m.text, m.bad, m.copy);
    else if (m.kind === 'ask') askSheet(m);
    else if (m.kind === 'cancel_ask') { if (askHeld?.id === m.id) askHeld = null; closeAsk(m.id, true); }
    else if (m.kind === 'clap_level') clapLevel(m);
    else if (m.kind === 'copied' && m.which === 'problem') note(m.ok ? 'Copied the error details. Paste them into your report.' : "Couldn't copy the error details. Try Save diagnostics.", !m.ok);
    else if (m.kind === 'copied') {
      if (!m.ok && state?.bind?.[m.which]) { ui.bindShown.add(m.which); render(`bind-${m.which}`); }
      note(m.ok ? 'Copied. Paste it into a new custom shortcut.' : "Couldn't copy it. Select the command and copy it instead.", !m.ok);
    }
  };
  send({ type: 'panel_open' });
  // The first show: the window was made hidden, so the switch-on is played here (main.rs's call may land
  // before this script has run).
  window.__panelOpen();

  // ---------------------------------------------------------------- browser preview
  function preview() {
    document.title = 'Hydra panel (preview with sample data)';
    const at = Date.now(), q = new URLSearchParams(location.search);
    const CLAUDE_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
    const s = {
      version: '1.0.0', os: /Win/.test(navigator.platform) ? 'win' : 'mac',
      status: { state: 'ready', text: 'Ready' }, busy: false, canNew: true,
      model: { provider: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', providerLabel: 'Anthropic' },
      providers: [
        { id: 'anthropic', label: 'Anthropic', on: !q.has('signedout'), method: 'oauth', key: true, signedIn: !q.has('signedout'), models: [{ id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', levels: CLAUDE_LEVELS }, { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', levels: CLAUDE_LEVELS }] },
        { id: 'openai', label: 'OpenAI', on: false, method: 'oauth', key: true, models: [] },
        { id: 'gemini', label: 'Gemini', on: true, method: 'key', key: true, keySaved: true, models: [{ id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', levels: ['high'] }] },
        { id: 'moonshot', label: 'Kimi (Moonshot)', on: false, method: 'key', models: [], kinds: [
          { id: 'kimi-code', label: 'Kimi Code', billing: 'Uses your Kimi Code plan. Create the key in the Kimi Code Console.' },
          { id: 'moonshot', label: 'Moonshot', billing: 'Pay-per-token from platform.moonshot.ai.' }] },
        { id: 'local', label: 'Local models', on: q.has('local'), method: 'local', models: q.has('local') ? [{ id: 'local/ollama/qwen3-vl:8b', name: 'qwen3-vl:8b (Ollama)', levels: [] }] : [],
          // A coding model that can't see images: only the subagent pickers offer it.
          textModels: q.has('local') ? [{ id: 'local/ollama/qwen3-coder:30b', name: 'qwen3-coder:30b (Ollama)', levels: [] }] : [] },
        ...['xAI', 'GLM (Z.ai)', 'MiniMax', 'Xiaomi', 'DeepSeek', 'Sakana', 'OpenRouter', 'Hugging Face'].map((label) => ({ id: label.toLowerCase().replace(/\W/g, ''), label, on: false, method: 'key', models: [] })),
      ],
      // ?local: Ollama connected, LM Studio not running, and an added server whose models can't see images.
      localServers: [
        { id: 'ollama', label: 'Ollama', custom: false, baseUrl: null, on: q.has('local'), note: '' },
        { id: 'lmstudio', label: 'LM Studio', custom: false, baseUrl: null, on: q.has('local'), note: q.has('local') ? "LM Studio isn't running." : '' },
        ...(q.has('local') ? [{ id: 'gpu-box', label: 'GPU box', custom: true, baseUrl: 'http://192.168.1.40:8000/v1', on: true, note: 'None marked as seeing images. Re-add to change.' }] : []),
      ],
      loggingIn: null,
      recent: [
        { at: at - 20e3, kind: 'did', text: 'Saved to memory' },
        { at: at - 25e3, kind: 'did', text: 'Searched the web' },
        { at: at - 30e3, kind: 'ask', text: "what's a good name for the new release?" },
        { at: at - 9 * 60e3, kind: 'bad', text: "Couldn't finish: read budget.xlsx" },
        { at: at - 9.2 * 60e3, kind: 'did', text: 'Looked at your screen' },
        { at: at - 9.4 * 60e3, kind: 'ask', text: 'what does this error mean' },
      ],
      usage: { requests: 14, tokens: 31240 },
      facts: [{ id: 'f1', text: 'Prefers short answers in the morning' }, { id: 'f2', text: 'Working on the Hydra 1.0 launch, due end of month' }, { id: 'f3', text: 'Has a cat called Miso', ...(q.has('replaced') ? { replaced: true } : {}) }],
      commitments: [{ id: 'c1', text: 'Send the launch email', when: 'Fri 7 Nov, 10:00', overdue: false }, { id: 'c2', text: 'Book the dentist', when: 'Mon 3 Nov, 09:00', overdue: true }],
      deleted: [{ id: 'd1a2b3c4d', kind: 'Fact', title: 'Lives in Lisbon', when: 'Today, 09:12' }, { id: 'd5e6f7a8b', kind: 'Skill', title: 'Weekly invoice', when: 'Tue 4 Nov, 17:40' },
        { id: 'd9c8b7a6f', kind: 'File before it was changed', title: '/Users/you/Documents/notes.md', when: 'Mon 3 Nov, 11:05' }],
      jobs: [{ id: 'j1a2b3c', title: 'Tech news', paused: false, next: 'Thu 6 Nov, 08:00', repeat: 'weekdays', last: 'Last: Summed up 6 stories on AI chips and a Mac update', bad: false },
        { id: 'j4d5e6f', title: 'Tidy Downloads', paused: true, next: 'Paused', repeat: 'Fri', last: "Didn't run: Allow File Edits & Commands is off", bad: true }],
      skills: [{ slug: 'export-figma-frames', name: 'Export Figma frames', description: 'When they want frames out of Figma as PNGs at 2x.' },
        { slug: 'weekly-invoice', name: 'Weekly invoice', description: 'When making the Friday invoice in Numbers from the hours sheet.' }], learnSkills: true,
      connections: [{ name: 'linear', remote: true, where: 'https://mcp.linear.app/mcp', enabled: true, state: 'connected', toolCount: 23, error: null },
        { name: 'notion', remote: true, where: 'https://mcp.notion.com/mcp', enabled: true, state: 'needs-login', toolCount: 0, error: 'Requires login.' },
        { name: 'everything', remote: false, where: 'npx -y @modelcontextprotocol/server-everything', enabled: true, state: 'error', toolCount: 0, error: 'spawn npx ENOENT' },
        { name: 'files', remote: false, where: 'npx -y @modelcontextprotocol/server-filesystem ~/Desktop', enabled: false, state: 'off', toolCount: 0, error: null }],
      name: 'Hydra', look: 'hydra', looks: [['hydra', 'Hydra']], size: 'default', sizes: [['small', 'Small'], ['default', 'Medium'], ['large', 'Large']],
      // ?fish: a Fish Audio key is saved (else Hydra speaks in the Mac's voice). ?asleep: the agent is asleep.
      replies: 'voice', fishKey: q.has('fish'), fishModel: 'drama-3', fishFree: false,
      hydra: { olderData: q.has('older') ? '~/Roamies' : null, detached: q.has('detached'), asleep: q.has('asleep'), sleepWord: 'Hydra, sleep', clap: 0.5, wake: true, url: q.has('paired') ? 'https://hydra-olive-one.vercel.app' : '', link: q.has('paired') ? 'ready' : 'off', tools: 0 },
      // ?tts=gemini: Gemini as the voice, its key saved.
      tts: new URLSearchParams(location.search).get('tts') === 'gemini' ? 'gemini' : 'fish', geminiKey: new URLSearchParams(location.search).get('tts') === 'gemini', geminiVoice: 'Kore',
      geminiVoices: [['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm']].map(([id, style]) => ({ id, style })),
      // &shared: speaking with the AI's Gemini key, none saved for the voice.
      geminiShared: new URLSearchParams(location.search).has('shared'), geminiModel: 'gemini-3.8-flash-lite-tts',
      geminiModels: [{ id: 'gemini-3.8-flash-lite-tts', name: 'Flash Lite', per10s: 0.0015 }, { id: 'gemini-3.8-flash-tts', name: 'Flash', per10s: 0.00225 }],
      fishModels: [{ id: 'drama-3', name: 'Drama 3', perM: 50, promo: { perM: 10, until: '2026-12-01T08:00:00Z' } }, { id: 's2.1-pro', name: 'S2.1 Pro', perM: 15 }],
      // Hybrid models: a job on a model picked here (the sidecar sends these; active is the one a heavy job is on right now).
      hybrid: { on: true, jobs: [
        { kind: 'code', label: 'Coding and commands', value: '' },
        { kind: 'computer', label: 'Computer use', value: 'anthropic:claude-sonnet-5' },
        { kind: 'web', label: 'Web research', value: '' },
        { kind: 'draw', label: 'Drawing', value: '' },
        { kind: 'agents', label: 'Background agents', value: '' } ], active: '' },
      // Subagents: Scout has its own model, Builder follows hybrid's coding model (none set here, so it is off the crew).
      subagents: { on: true, delegate: 'auto', crew: [
        { id: 'scout', label: 'Scout', hint: 'Web research.', value: 'gemini:gemini-3.8-flash', via: 'own', uses: 'gemini:gemini-3.8-flash' },
        { id: 'builder', label: 'Builder', hint: 'Code, pages and scripts.', value: '', via: 'hybrid', uses: 'anthropic:claude-sonnet-5' },
        { id: 'writer', label: 'Writer', hint: 'Documents, slides and copy.', value: '', via: '', uses: '' } ] },
      // If a limit is reached: backups 1 and 2 (the Gemini model is free while Claude is at its limit, so it's in use).
      fallbacks: { on: true, slots: ['gemini:gemini-3.8-flash', ''], limited: [{ label: 'Claude', until: at + 40 * 60e3 }], using: 'gemini:gemini-3.8-flash' },
      // Effort per slot: '' is automatic (low); computer use is set to High, and backup 1 (Gemini, which only thinks at High) too.
      efforts: { default: '', computer: 'high', code: '', agents: '', draw: '', web: '', backup1: 'high', backup2: '' },
      voice: { on: true, keys: '⌃⌥', ready: true, mac: true, lang: 'auto', langOnline: null, studioSpeak: 'short', mute: true, autoListen: q.has('listen'), listenEvery: false, listenSecs: 8, listenChoices: [3, 5, 8, 10, 15], mics: [{ id: 'BuiltIn', name: 'MacBook Pro Microphone' }, { id: 'airpods', name: 'AirPods Pro' }], mic: '', micAuto: 'MacBook Pro Microphone', wake: !q.has('nowake'), wakeWord: true, wakeName: 'Hydra', wakePhrase: 'Hey Hydra', clapTalk: true, barge: !q.has('nobarge'), bargeNA: q.has('nobarge'), sleepWord: 'Hydra, sleep', download: null }, askKeys: '⌥⌘', brief: { on: true, todoist: false, canTodoist: true }, focus: { until: null, task: '', list: ['YouTube', 'Reddit', 'X', 'Steam', 'Netflix'], custom: false }, sync: { dir: '', at: null, error: null, paused: false }, shortcuts: { talk: { value: 'control+option', pairs: [['control+option', 'Control+Option'], ['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] }, keys: [{ id: 'summon', words: 'Control+Option+S' }, { id: 'snap', words: 'Control+Option+A' }, { id: 'list', words: 'Control+Option+L' }] }, writeKeys: { value: 'option+command', pairs: [['option+command', 'Option+Command'], ['control+command', 'Control+Command'], ['control+shift', 'Control+Shift'], ['option+shift', 'Option+Shift']] },
      sound: true, notch: q.has('notch') || q.has('capsule') ? 'drop' : null, notchReal: q.has('notch'), actions: q.has('actions'), login: { on: true },
      update: { available: new URLSearchParams(location.search).has('update') && new URLSearchParams(location.search).get('update') !== 'failed' ? '0.9.1' : null, installing: false, checking: false, result: null },
      intro: false,
    };
    if (q.has('busy')) Object.assign(s, { busy: true, status: { state: 'busy', text: 'Reading notes.md' } });
    if (q.has('empty')) Object.assign(s, { recent: [], facts: [], commitments: [], jobs: [], skills: [], connections: [], deleted: [], usage: null });
    if (q.has('many')) {
      const things = ['Prefers short answers', 'Drinks oat flat whites', 'Works late on Thursdays', 'Has a cat called Miso', 'Training for a 10k in March', 'Learning Japanese', 'Uses Figma for design', 'Ships on Fridays', 'Allergic to peanuts', 'Sister is called Ana'];
      s.facts = Array.from({ length: 100 }, (_, i) => ({ id: `f${i}`, text: `${things[i % things.length]}${i >= things.length ? ` (${Math.floor(i / things.length) + 1})` : ''}`, ...(q.has('replaced') && i === 2 ? { replaced: true } : {}) }));
      s.commitments = Array.from({ length: 14 }, (_, i) => ({ id: `c${i}`, text: `Follow up on item ${i + 1}`, when: 'Fri 7 Nov, 10:00', overdue: i < 2 }));
      s.recent = Array.from({ length: 30 }, (_, i) => ({ ...s.recent[i % s.recent.length], at: at - i * 70e3 }));
    }
    // ?problem: an error was shown earlier (About gets Copy last error). ?note=bad: a failed save, with Copy details.
    // ?update=failed: the last check for updates failed (the button's tooltip says why).
    if (q.has('problem') || q.get('note') === 'bad') s.problem = { code: 'E30', at };
    if (q.get('note') === 'bad') setTimeout(() => window.__panel({ kind: 'note', text: "That key didn't save (E30). Try again.", bad: true, copy: true }), 400);
    if (q.get('update') === 'failed') s.update.result = { ok: false, error: "Couldn't check for updates. Check your internet." };
    if (q.has('checking')) s.update.checking = true;
    // ?studio: VoiceStudio is the voice provider (?studio=off: it isn't running; ?studio=engine: its engine isn't ready; ?studio=empty: no saved voices).
    const STUDIO = {
      on: { ok: true, engine: 'OmniVoice', voices: [{ id: 'a642d572', name: 'Ben' }, { id: 'fa08aff1', name: 'British · Female · Young Adult · High' }], voice: 'fa08aff1' },
      empty: { ok: true, engine: 'KittenTTS', voices: [], voice: null },
      off: { ok: false, reason: 'offline', message: 'Run VoiceStudio first.' },
      engine: { ok: false, reason: 'engine', message: "VoiceStudio's voice engine isn't ready (CosyVoice): not installed. Pick or install an engine in VoiceStudio, then press Check again." },
    };
    if (q.has('studio')) Object.assign(s, { tts: 'voicestudio', studio: STUDIO[q.get('studio')] ?? STUDIO.on });
    if (q.has('uptodate')) s.update.result = { ok: true, at: Date.now() + 60e3 };
    // ?v=0.1.36&from=0.1.35: What's new as it looks just after updating from one version to the other.
    if (q.get('v')) s.version = q.get('v');
    if (q.get('from')) s.whatsNewFrom = q.get('from');
    if (q.get('tab')) setTimeout(() => { if (q.get('mtab')) ui.mtab = q.get('mtab'); if (q.get('atab')) ui.tabs.abilities = q.get('atab'); if (q.get('ltab')) ui.tabs.listening = q.get('ltab'); show(q.get('tab')); }, 0);
    setTimeout(() => window.__panel({ kind: 'state', state: s }), 0);
    return async (cmd, args) => {
      if (cmd !== 'sidecar_send') return null;
      console.log('[preview] would send', JSON.stringify(args.msg));
      // A look change comes back as new state, as from the sidecar, so the Roamie's reaction can be seen.
      if (args.msg?.type === 'copy_problem') setTimeout(() => window.__panel({ kind: 'copied', which: 'problem', ok: q.get('copy') !== 'fail' }), 150);
      const id = args.msg?.id ?? '';
      if (id.startsWith('size:')) { s.size = id.slice(5); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('tts:')) { s.tts = id.slice(4); s.studio = s.tts === 'voicestudio' ? STUDIO[q.get('studio')] ?? STUDIO.on : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('studiovoice:') && s.studio) { s.studio.voice = id.slice(12) === 'default' ? null : id.slice(12); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'lite') { s.lite = !s.lite; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'hybrid') { s.hybrid.on = !s.hybrid.on; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id === 'backups') { s.fallbacks.on = !s.fallbacks.on; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (id.startsWith('effort_')) { const at = id.indexOf(':'); s.efforts[id.slice(7, at)] = id.slice(at + 1); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && ['autolisten', 'listenevery'].includes(id)) { const k = id === 'autolisten' ? 'autoListen' : 'listenEvery'; s.voice[k] = !s.voice[k]; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && id.startsWith('speechlang:')) { s.voice.lang = id.slice(11); s.voice.langOnline = ['ar-SA', 'he-IL'].includes(s.voice.lang) ? true : null; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      if (s.voice && id.startsWith('listensecs:')) { s.voice.listenSecs = Number(id.slice(11)); setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      // Removing a row (a skill, connection, job, fact or commitment) comes back as new state, as from the sidecar.
      const gone = [[/^skill:forget:(.+)$/, 'skills', (x, v) => x.slug === v], [/^mcp:remove:(.+)$/, 'connections', (x, v) => x.name === v], [/^job:remove:(.+)$/, 'jobs', (x, v) => x.id === v],
        [/^forget:(.+)$/, 'facts', (x, v) => x.id === v], [/^(?:done|drop):(.+)$/, 'commitments', (x, v) => x.id === v], [/^bin:restore:(.+)$/, 'deleted', (x, v) => x.id === v]].find(([re]) => re.test(id));
      if (gone) { const v = id.match(gone[0])[1]; s[gone[1]] = s[gone[1]].filter((x) => !gone[2](x, v)); setTimeout(() => window.__panel({ kind: 'state', state: s }), Number(q.get('lag') ?? 120)); }
      if (id.startsWith('look:')) { s.look = id.slice(5); s.name = s.looks.find(([v]) => v === s.look)?.[1] ?? s.name; setTimeout(() => window.__panel({ kind: 'state', state: s }), 120); }
      return null;
    };
  }
})();
