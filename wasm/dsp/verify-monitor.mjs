// Exercise the actual WASI monitor exports, independently of the parameter ABI.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { WASI } from 'node:wasi';
const path = process.argv[2];
assert.ok(path, 'supply the WASI reactor');
const wasi = new WASI({ version: 'preview1', args: [], env: {}, preopens: {} });
const { instance } = await WebAssembly.instantiate(await readFile(path), wasi.getImportObject());
wasi.initialize(instance);
const e = instance.exports;
assert.equal(e.aurialis_control_count(1), 81);
assert.equal(e.aurialis_control_count(2), 82);
for (const rate of [8000, 44100, 48000, 192000]) {
 assert.equal(e.aurialis_init(rate), 1);
 assert.equal(e.aurialis_set_monitor_mode(3), 0);
 assert.equal(e.aurialis_monitor_buffer(4), 0);
 assert.equal(e.aurialis_set_monitor_mode(1), 1);
 const length = Math.round(rate * .01);
 let frame = 0;
 while (frame < length + 128) {
  const memory = e.memory.buffer;
  const views = [0,1,2,3].map(c => new Float32Array(memory, e.aurialis_monitor_buffer(c) >>> 0, 128));
  views.forEach((v,c) => v.fill(c % 2 === 0 ? 1 : -1));
  assert.equal(e.aurialis_monitor_process(), 128);
  for (let i=0;i<128;i++,frame++) {
   const expected = Math.fround(1-Math.min(1,(frame+1)/length));
   assert.ok(Math.abs(views[0][i]-expected) < 1e-6);
   assert.equal(views[0][i],views[2][i]);
   assert.equal(views[1][i],views[3][i]);
  }
 }
 assert.equal(e.aurialis_set_monitor_mode(2), 1);
 assert.equal(e.aurialis_live_reset(), 1);
 const views = [0,1,2,3].map(c => new Float32Array(e.memory.buffer,e.aurialis_monitor_buffer(c) >>> 0,128));
 views.forEach((v,c) => v.fill(c % 2 === 0 ? 1 : -1));
 assert.equal(e.aurialis_monitor_process(),128);
 views.forEach(v => assert.ok(v.every(s=>s===1), 'side/reset polarity'));
}
console.log('WASI monitor exports: ABI, rates, 10ms fade, pair alignment, side polarity and reset passed');
