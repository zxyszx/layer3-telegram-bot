import test from 'node:test';
import assert from 'node:assert/strict';
import {
  expectedPowerControlForStatus,
  isExpectedPowerAction,
  Layer3Browser,
} from '../src/layer3-browser.js';

test('matches only explicit Layer3 power actions', () => {
  assert.equal(isExpectedPowerAction('start', 'Power On'), true);
  assert.equal(isExpectedPowerAction('stop', 'Power Off'), true);
  assert.equal(isExpectedPowerAction('stop', 'Shut down'), true);
  assert.equal(isExpectedPowerAction('start', 'Destroy'), false);
  assert.equal(isExpectedPowerAction('stop', 'Destroy'), false);
  assert.equal(isExpectedPowerAction('start', 'Restart'), false);
});

test('requires the opposite power control to verify a final state', () => {
  assert.equal(expectedPowerControlForStatus('RUNNING'), 'stop');
  assert.equal(expectedPowerControlForStatus('STOPPED'), 'start');
  assert.equal(expectedPowerControlForStatus('STARTING'), null);
  assert.equal(expectedPowerControlForStatus('UNKNOWN'), null);
});

test('requires two consecutive status and power-control confirmations', async () => {
  let powerChecks = 0;
  const warnings = [];
  const browser = {
    page: { waitForTimeout: async () => {} },
    config: { instanceUrl: 'https://example.test/instance' },
    logger: {
      info() {},
      warn: (...args) => warnings.push(args),
    },
    ensureReady: async () => {},
    readInstanceStatus: async () => 'RUNNING',
    findPowerControl: async (kind) => {
      powerChecks += 1;
      assert.equal(kind, 'stop');
      if (powerChecks === 1) throw new Error('stale control');
      return { label: 'Power Off' };
    },
  };
  const result = await Layer3Browser.prototype.waitForStatus.call(browser, 'RUNNING', 1000);
  assert.equal(result, 'RUNNING');
  assert.equal(powerChecks, 3);
  assert.equal(warnings.length, 1);
});
