import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoStopScheduler } from '../src/auto-stop.js';

function memoryStore(initial = {}) {
  let state = initial;
  return {
    read: async () => state,
    write: async (value) => { state = value; },
  };
}

const logger = { info() {}, warn() {}, error() {} };

test('executes a due auto-stop and clears persisted state', async () => {
  const store = memoryStore({ autoStopAt: new Date(Date.now() - 1000).toISOString() });
  let stopped = 0;
  const notifications = [];
  const scheduler = new AutoStopScheduler(
    store,
    async () => { stopped += 1; },
    async (message) => notifications.push(message),
    logger,
  );
  await scheduler.execute();
  assert.equal(stopped, 1);
  assert.deepEqual(await store.read(), {});
  assert.match(notifications[0], /机器已关机/);
});

test('retries an auto-stop after a transient failure', async () => {
  const store = memoryStore({ autoStopAt: new Date(Date.now() - 1000).toISOString() });
  let attempts = 0;
  const notifications = [];
  const scheduler = new AutoStopScheduler(
    store,
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('temporary portal error');
    },
    async (message) => notifications.push(message),
    logger,
    10,
  );
  await scheduler.execute();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 2);
  assert.deepEqual(await store.read(), {});
  assert.match(notifications[0], /自动重试/);
  assert.match(notifications[1], /机器已关机/);
});
