import test from 'node:test';
import assert from 'node:assert/strict';
import { startDisplayUpdates } from '../lib/display-updates.mjs';
const config = { displayOnly: true, origin: 'https://bemine.cc.cd',
  indexBaseUrl: 'https://bemine.cc.cd/bemine-v4/api/chain-index' };
function fixture() {
  let stream, count = 0, paused = false; const queue = new Map(); let id = 0;
  class Source {
    constructor(url) { this.url = url; stream = this; }
    addEventListener(name, callback) { this.callback = callback; assert.equal(name, 'update'); }
    removeEventListener() {} close() { this.closed = true; }
    emit(revision) { this.callback({ data: JSON.stringify({ revision }) }); }
  }
  const stop = startDisplayUpdates(config, { EventSourceImpl: Source, onUpdate: () => count++,
    isPaused: () => paused, documentObject: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    schedule: callback => { queue.set(++id, callback); return id; }, unschedule: n => queue.delete(n),
  });
  return { stream, stop, queue, count: () => count, pause: v => { paused = v; },
    flush() { const [key, callback] = queue.entries().next().value; queue.delete(key); callback(); } };
}
test('push notifications coalesce changes and skip the initial/repeated revision', () => {
  const f = fixture(); assert.match(f.stream.url, /\/v1\/display\/events$/);
  f.stream.emit('1'); f.stream.emit('1'); assert.equal(f.queue.size, 0);
  f.stream.emit('2'); f.stream.emit('3'); assert.equal(f.queue.size, 1);
  f.flush(); assert.equal(f.count(), 1); f.stop(); assert.equal(f.stream.closed, true);
});
test('active wallet confirmation postpones display updates; cleanup prevents late updates', () => {
  const f = fixture(); f.stream.emit('1'); f.pause(true); f.stream.emit('2'); f.flush();
  assert.equal(f.count(), 0); assert.equal(f.queue.size, 1);
  f.pause(false); f.flush(); assert.equal(f.count(), 1);
  f.stream.emit('3'); f.stop(); assert.equal(f.queue.size, 0);
});
