import test from 'node:test';
import assert from 'node:assert/strict';
import { applyBotConfig, hasLayer3Binding } from '../src/config.js';

test('starts with telegram token only and applies telegram binding later', () => {
  const base = {
    telegramToken: 'token',
    allowedChatIds: new Set(),
    consoleOrigin: 'https://console.layer3.cloud',
    projectSlug: '',
    instanceName: '',
    email: '',
    password: '',
    hourlyPrice: 22.37702,
    autoStopMinutes: 60,
    estimatedHoursPerDay: 1,
  };

  assert.equal(hasLayer3Binding(applyBotConfig(base, {})), false);

  const config = applyBotConfig(base, {
    allowedChatIds: ['123'],
    email: 'user@example.com',
    passwordBase64: Buffer.from('secret').toString('base64'),
    projectSlug: 'default-828',
    instanceName: 'vm-f9k5yf10c',
    hourlyPrice: 30,
    autoStopMinutes: 45,
  });

  assert.equal(config.allowedChatIds.has('123'), true);
  assert.equal(config.password, 'secret');
  assert.equal(config.instanceUrl, 'https://console.layer3.cloud/app/projects/default-828/vm-f9k5yf10c/overview');
  assert.equal(config.autoStopMinutes, 45);
  assert.equal(hasLayer3Binding(config), true);
});
