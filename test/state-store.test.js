import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonStateStore } from '../src/state-store.js';

test('persists scheduler state atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'layer3-bot-'));
  const store = new JsonStateStore(path.join(directory, 'runtime.json'));
  assert.deepEqual(await store.read(), {});
  await store.write({ autoStopAt: '2026-08-16T08:00:00.000Z' });
  assert.deepEqual(await store.read(), { autoStopAt: '2026-08-16T08:00:00.000Z' });
});
