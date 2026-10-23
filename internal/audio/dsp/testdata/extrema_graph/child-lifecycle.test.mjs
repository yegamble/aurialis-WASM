import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createCounterCollector, finishChild } from './child-lifecycle.mjs';
const expected = { cases: 27, rate: 8000, baseFrames: 180687, numericWords: 6256332, outputBytes: 2354640, inputSHA256: 'a'.repeat(64) };
const line = `cases27 rate8000 baseFrames180687 numericWords6256332 outputBytes2354640 fixedGraphBytes1073080 inputSHA256${expected.inputSHA256}\n`;
test('bounded counter line survives split writes and validates unchanged limits', () => {
  const collector = createCounterCollector();
  collector.add(Buffer.from(line.slice(0, 40)));
  collector.add(Buffer.from(line.slice(40)));
  assert.equal(collector.verify(expected, 8000, 2354640).cases, 27);
});
test('missing/duplicate/overlong counter lines and mismatched frozen counters refuse', () => {
  assert.throws(() => createCounterCollector().verify(expected, 8000, 2354640));
  const collector = createCounterCollector();
  collector.add(Buffer.from(line));
  assert.throws(() => collector.add(Buffer.from(line)));
  assert.throws(() => collector.verify({ ...expected, cases: 26 }, 8000, 2354640));
  const overlong = createCounterCollector();
  overlong.add(Buffer.from('x'.repeat(2048) + line));
  assert.throws(() => overlong.verify(expected, 8000, 2354640));
});
test('completed Go exit closes receipt before explicit successful host exit', () => {
  const events = [];
  finishChild({ code: 0, receipt: { goExit: 0 },
    writeReceipt: () => { events.push('receipt-written', 'receipt-closed'); },
    writeError: () => assert.fail('success logged a failure'),
    exit: (code) => { assert.equal(code, 0); events.push('exit'); },
  });
  assert.deepEqual(events, ['receipt-written', 'receipt-closed', 'exit']);
});
test('failure writes synchronous diagnostic and exits1; receipt errors never exit0', () => {
  const events = [];
  finishChild({ code: 1, receipt: { failure: 'retained' },
    writeReceipt: () => events.push('receipt-closed'),
    writeError: (text) => { assert.match(text, /retained/); events.push('error-written'); },
    exit: (code) => { assert.equal(code, 1); events.push('exit'); },
  });
  assert.deepEqual(events, ['receipt-closed', 'error-written', 'exit']);
  assert.throws(() => finishChild({ code: 0, receipt: {}, writeReceipt: () => { throw new Error('disk'); }, exit: () => assert.fail('exited after failed receipt') }));
  assert.throws(() => finishChild({ code: 0, receipt: {}, writeReceipt: () => Promise.resolve(), exit: () => assert.fail('exited before asynchronous receipt') }));
});

test('actual Node exits only after synchronous receipt; a queued stale timer cannot override it', () => {
  const helper = new URL('./child-lifecycle.mjs', import.meta.url).href;
  const script = `import fs from 'node:fs';import {finishChild} from ${JSON.stringify(helper)};
    setTimeout(()=>{throw new Error('stale completed-Go timer')},0);
    await Promise.resolve();
    finishChild({code:0,receipt:{goExit:0},writeReceipt:()=>{fs.writeSync(1,'receipt-closed');},writeError:()=>{},exit:code=>process.exit(code)});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 2000, maxBuffer: 1024 });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.toString(), 'receipt-closed');
});
