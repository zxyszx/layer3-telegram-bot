import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

function withEnvironment(values, task) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_ALLOWED_CHAT_IDS: '7',
    LAYER3_INSTANCE_NAME: 'vm-test',
    LAYER3_PROJECT_SLUG: 'project-test',
    ...values,
  });
  try {
    return task();
  } finally {
    process.env = previous;
  }
}

test('uses explicit second-based lifecycle settings', () => {
  withEnvironment({
    AUTO_SHUTDOWN_SECONDS: '3600',
    POST_SHUTDOWN_BILLING_CHECK_SECONDS: '300',
  }, () => {
    const config = loadConfig();
    assert.equal(config.autoShutdownSeconds, 3600);
    assert.equal(config.autoStopMinutes, 60);
    assert.equal(config.postShutdownBillingCheckSeconds, 300);
    assert.match(config.billingHistoryPath, /billing_history\.json$/);
  });
});

test('keeps legacy AUTO_STOP_MINUTES compatibility', () => {
  withEnvironment({ AUTO_SHUTDOWN_SECONDS: '', AUTO_STOP_MINUTES: '15' }, () => {
    const config = loadConfig();
    assert.equal(config.autoShutdownSeconds, 900);
    assert.equal(config.autoStopMinutes, 15);
  });
});
