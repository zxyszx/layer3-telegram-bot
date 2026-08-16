import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateHandler } from '../src/update-handler.js';

function createHarness() {
  const calls = [];
  const telegram = {
    isAllowed: (chatId) => chatId === 7,
    send: async (...args) => calls.push(['send', ...args]),
    answerCallback: async (...args) => calls.push(['answer', ...args]),
  };
  const layer3 = {
    status: async () => {
      calls.push(['layer3-status']);
      return { balance: 100, instanceStatus: 'STOPPED' };
    },
    start: async () => {
      calls.push(['layer3-start']);
      return { changed: true, status: 'RUNNING' };
    },
    stop: async () => {
      calls.push(['layer3-stop']);
      return { changed: true, status: 'STOPPED' };
    },
  };
  const scheduler = {
    dueAt: async () => null,
    cancel: async () => calls.push(['cancel-schedule']),
    schedule: async (minutes) => {
      calls.push(['schedule', minutes]);
      return '2026-08-16T16:00:00.000Z';
    },
  };
  const logger = { warn: (...args) => calls.push(['warn', ...args]) };
  const config = {
    instanceName: 'vm-test',
    hourlyPrice: 22.37702,
    estimatedHoursPerDay: 1,
    autoStopMinutes: 60,
  };
  return {
    calls,
    handler: createUpdateHandler({ config, logger, telegram, layer3, scheduler }),
  };
}

function message(text) {
  return { message: { chat: { id: 7 }, text } };
}

function callback(data) {
  return { callback_query: { id: 'query-1', data, message: { chat: { id: 7 } } } };
}

test('serves menu and status commands with state-aware controls', async () => {
  const { handler, calls } = createHarness();
  await handler(message('/start'));
  await handler(message('/status'));
  const sent = calls.filter((call) => call[0] === 'send');
  assert.match(sent[0][2], /Layer3 机器控制/);
  assert.match(sent[1][2], /状态：<b>已关机<\/b>/);
  assert.deepEqual(
    sent[1][3].inline_keyboard.flat().map((button) => button.text),
    ['刷新状态', '启动', '启动 1 小时'],
  );
});

test('returns confirmations for every power command', async () => {
  const { handler, calls } = createHarness();
  await handler(message('/startvm'));
  await handler(message('/start1h'));
  await handler(message('/stopvm'));
  assert.deepEqual(
    calls.map((call) => call[3].inline_keyboard[0][0].callback_data),
    ['start_confirm', 'start1h_confirm', 'stop_confirm'],
  );
});

test('executes start, timed start, stop, cancel and refresh callbacks', async () => {
  const { handler, calls } = createHarness();
  await handler(callback('start_confirm'));
  await handler(callback('start1h_confirm'));
  await handler(callback('stop_confirm'));
  await handler(callback('cancel'));
  await handler(callback('status'));
  assert.equal(calls.filter((call) => call[0] === 'answer').length, 5);
  assert.equal(calls.filter((call) => call[0] === 'layer3-start').length, 2);
  assert.equal(calls.filter((call) => call[0] === 'layer3-stop').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'layer3-status').length, 1);
  assert.equal(calls.filter((call) => call[0] === 'cancel-schedule').length, 2);
  assert.deepEqual(calls.find((call) => call[0] === 'schedule'), ['schedule', 60]);
  assert.ok(calls.some((call) => call[0] === 'send' && call[2] === '操作已取消。'));
});

test('ignores unauthorized chats', async () => {
  const { handler, calls } = createHarness();
  await handler({ message: { chat: { id: 8 }, text: '/status' } });
  assert.equal(calls[0][0], 'warn');
  assert.equal(calls.some((call) => call[0] === 'send'), false);
});
