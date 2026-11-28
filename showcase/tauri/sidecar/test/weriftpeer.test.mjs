// The Mac's WebRTC peer for the phone view (RV plan D0): werift is pinned and loads here (peerAvailable), and the
// real weriftPeer answers a werift offer in this process: the phone side makes `ctl` and `scr`, the Mac answers with
// one SDP (no trickle), both channels open over loopback, and text goes both ways and binary to the phone. No screen,
// no helper, no server. Run: npm test
// Loopback only: werift offers host candidates from os.networkInterfaces, and a Mac whose firewall or network drops
// UDP to its own LAN address never connects to itself that way. lo0 is listed as not internal (werift skips internal
// ones), before werift loads.
import assert from 'node:assert/strict';
import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.networkInterfaces = () => ({ lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '127.0.0.1/8' }] });
syncBuiltinESMExports();
const { peerAvailable, weriftPeer } = await import('../remoteview.mjs');

assert.equal(await peerAvailable(), true, 'werift loads: Phone View can show');
const { RTCPeerConnection } = await import('werift');

const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: not in ${ms} ms`)), ms))]);
const gathered = (pc) => new Promise((r) => { if (pc.iceGatheringState === 'complete') r(); pc.iceGatheringStateChange.subscribe((s) => s === 'complete' && r()); });

// The phone (the offer side, as iPhone Safari does it).
const phone = new RTCPeerConnection({ iceServers: [] });
const ctl = phone.createDataChannel('ctl', { ordered: true });
const scr = phone.createDataChannel('scr', { ordered: true });
await phone.setLocalDescription(await phone.createOffer());
await within(Promise.race([gathered(phone), new Promise((r) => setTimeout(r, 2_000))]), 5_000, 'phone ICE');

const mac = await within(weriftPeer({ offer: phone.localDescription.sdp, iceServers: [] }), 10_000, 'mac answer');
assert.match(mac.answer, /^v=0/, 'one SDP answer');
const states = [], fromPhone = [];
mac.onState((s) => states.push(s));
mac.onMessage((t) => fromPhone.push(t));
const opened = new Promise((r) => { const t = setInterval(() => { if (states.includes('open')) { clearInterval(t); r(); } }, 20); });
await phone.setRemoteDescription({ type: 'answer', sdp: mac.answer });
await within(opened, 15_000, 'both channels open');

// ctl both ways, scr to the phone.
const gotCtl = new Promise((r) => ctl.onMessage.subscribe((d) => r(typeof d === 'string' ? d : Buffer.from(d).toString('utf8'))));
const gotScr = new Promise((r) => scr.onMessage.subscribe((d) => r(Buffer.from(d))));
ctl.send(JSON.stringify({ t: 'hello', v: 1 }));
mac.send(JSON.stringify({ t: 'pong', id: 1, at: 2 }));
const frame = Buffer.alloc(1_000, 7); frame[0] = 1;
mac.sendScr(frame);
assert.deepEqual(JSON.parse(await within(gotCtl, 5_000, 'ctl to the phone')), { t: 'pong', id: 1, at: 2 });
assert.ok((await within(gotScr, 5_000, 'scr to the phone')).equals(frame), 'the binary frame arrives whole');
await within(new Promise((r) => { const t = setInterval(() => { if (fromPhone.length) { clearInterval(t); r(); } }, 20); }), 5_000, 'ctl to the Mac');
assert.deepEqual(JSON.parse(fromPhone[0]), { t: 'hello', v: 1 });
assert.equal(typeof mac.bufferedAmount(), 'number');

mac.close();
await phone.close();
console.log('weriftpeer ok');
process.exit(0); // werift keeps a socket timer; the test is done
