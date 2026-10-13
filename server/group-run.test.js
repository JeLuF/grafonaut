import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupPhases, runGroupAction } from './group-run.js';

const entries = [{ entryId: '1', label: 'Lower third' }, { entryId: '2', label: 'Coming next' }, { entryId: '3', label: 'Bug' }];

// Records when each step starts and finishes; steps take `duration` ms of simulated time.
function recorder({ duration = 10, fail = () => false } = {}) {
  const events = [];
  const execute = async (entry, step) => {
    events.push(`start ${step.type} ${entry.entryId}`);
    await new Promise((resolve) => setTimeout(resolve, duration));
    events.push(`end ${step.type} ${entry.entryId}`);
    if (fail(entry, step)) throw new Error(`${step.type} failed`);
  };
  const sleep = async (ms) => { events.push(`sleep ${ms}`); };
  return { events, execute, sleep };
}

test('sleep steps split a group into phases', () => {
  assert.deepEqual(groupPhases([{ type: 'stop', entryId: '1' }, { type: 'play', entryId: '2' }, { type: 'sleep', ms: 500 }, { type: 'play', entryId: '3' }, { type: 'sleep', ms: 100 }]),
    [[{ type: 'stop', entryId: '1' }, { type: 'play', entryId: '2' }], { sleep: 500 }, [{ type: 'play', entryId: '3' }], { sleep: 100 }]);
  assert.deepEqual(groupPhases([]), []);
});

test('steps of one phase start together; the next phase waits for the sleep', async () => {
  const run = recorder();
  const result = await runGroupAction({ steps: [{ type: 'stop', entryId: '1' }, { type: 'play', entryId: '2' }, { type: 'sleep', ms: 500 }, { type: 'play', entryId: '3' }] },
    { entries, execute: run.execute, sleep: run.sleep });
  assert.deepEqual(run.events, ['start stop 1', 'start play 2', 'end stop 1', 'end play 2', 'sleep 500', 'start play 3', 'end play 3']);
  assert.deepEqual(result, { ran: 3, failures: [] });
});

test('steps on the same graphic keep their order', async () => {
  const run = recorder();
  await runGroupAction({ steps: [{ type: 'update', entryId: '1' }, { type: 'play', entryId: '2' }, { type: 'play', entryId: '1' }] },
    { entries, execute: run.execute, sleep: run.sleep });
  assert.deepEqual(run.events, ['start update 1', 'start play 2', 'end update 1', 'start play 1', 'end play 2', 'end play 1']);
});

test('failing steps and missing graphics are reported without stopping the others', async () => {
  const run = recorder({ fail: (entry) => entry.entryId === '2' });
  const result = await runGroupAction({ steps: [{ type: 'play', entryId: '2' }, { type: 'play', entryId: '9' }, { type: 'sleep', ms: 0 }, { type: 'play', entryId: '3' }] },
    { entries, execute: run.execute, sleep: run.sleep });
  assert.equal(result.ran, 3);
  assert.deepEqual(result.failures.map(({ entry, message }) => [entry?.entryId ?? null, message]).sort(),
    [['2', 'play failed'], [null, 'the graphic is no longer in this rundown']].sort());
  assert.ok(run.events.includes('end play 3'));
});
