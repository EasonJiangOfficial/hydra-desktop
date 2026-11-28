// Exercise werift's setLocalDescription gathering boundary without binding sockets or contacting an ICE server.
import assert from 'node:assert/strict';
import { RTCPeerConnection, SessionDescription } from 'werift';
import { weriftPeer } from '../remoteview.mjs';
import { fakeClock, flush } from './fakeremote.mjs';

const SDP = [
  'v=0', 'o=- 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'a=mid:0', 'a=sctp-port:5000', 'a=ice-ufrag:test', 'a=ice-pwd:localtestcredential', '',
].join('\r\n');

let pc, finish, fail, closes;
Object.defineProperty(RTCPeerConnection.prototype, 'localDescription', { get: () => ({ type: 'answer', sdp: SDP }) });
RTCPeerConnection.prototype.setRemoteDescription = async () => {};
RTCPeerConnection.prototype.createAnswer = async () => ({ type: 'answer', sdp: SDP });
RTCPeerConnection.prototype.setLocalDescription = function () {
  pc = this;
  return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
};
RTCPeerConnection.prototype.close = async () => { closes += 1; };

{
  const clock = fakeClock();
  let made;
  closes = 0;
  const pending = weriftPeer({ offer: SDP }, clock).then((peer) => { made = peer; });
  await flush();
  const candidate = { sdpMid: '0', sdpMLineIndex: 0, candidate: 'candidate:host 1 udp 100 127.0.0.1 12345 typ host' };
  pc.onIceCandidate.execute(candidate);
  pc.onIceCandidate.execute(candidate);
  await clock.advance(1_999);
  assert.equal(made, undefined);
  await clock.advance(1);
  assert.ok(made, 'setLocalDescription still gathering at two seconds must return the partial answer');
  await pending;
  const candidates = SessionDescription.parse(made.answer).media[0].iceCandidates;
  assert.deepEqual(candidates.map((c) => [c.foundation, c.ip, c.port]), [['host', '127.0.0.1', 12345]]);
  assert.equal(clock.pending(), 0);
  assert.equal(closes, 0, 'the partial answer still belongs to an open peer');
  fail(new Error('gathering failed late'));
  await flush();
  assert.equal(closes, 1, 'late gathering failure closes the peer once');
  made.close();
  assert.equal(closes, 1);
}

{
  const clock = fakeClock(), controller = new AbortController();
  closes = 0;
  const pending = assert.rejects(weriftPeer({ offer: SDP, signal: controller.signal }, clock), { name: 'AbortError' });
  await flush();
  controller.abort();
  await pending;
  assert.equal(clock.pending(), 0);
  assert.equal(closes, 1);
  finish();
}

{
  const clock = fakeClock();
  closes = 0;
  const pending = weriftPeer({ offer: SDP }, clock);
  await flush();
  finish();
  const made = await pending;
  assert.equal(made.answer, SDP);
  assert.equal(clock.pending(), 0);
  made.close();
  assert.equal(closes, 1);
}
console.log('weriftdeadline ok');
