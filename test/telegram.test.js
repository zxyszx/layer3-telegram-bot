import test from 'node:test';
import assert from 'node:assert/strict';
import { statusKeyboard } from '../src/telegram.js';

function buttonLabels(status) {
  return statusKeyboard(status).inline_keyboard.flat().map((button) => button.text);
}

test('stopped machines never show a shutdown button', () => {
  const labels = buttonLabels('STOPPED');
  assert.deepEqual(labels, ['刷新状态', '启动', '启动 1 小时']);
  assert.ok(!labels.includes('立即关机'));
});

test('running machines show shutdown but not redundant start', () => {
  assert.deepEqual(buttonLabels('RUNNING'), ['刷新状态', '启动 1 小时', '立即关机']);
});

test('transitional states only allow refresh', () => {
  assert.deepEqual(buttonLabels('STOPPING'), ['刷新状态']);
});
