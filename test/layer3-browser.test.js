import test from 'node:test';
import assert from 'node:assert/strict';
import { isExpectedPowerAction } from '../src/layer3-browser.js';

test('matches only explicit Layer3 power actions', () => {
  assert.equal(isExpectedPowerAction('start', 'Power On'), true);
  assert.equal(isExpectedPowerAction('stop', 'Power Off'), true);
  assert.equal(isExpectedPowerAction('stop', 'Shut down'), true);
  assert.equal(isExpectedPowerAction('start', 'Destroy'), false);
  assert.equal(isExpectedPowerAction('stop', 'Destroy'), false);
  assert.equal(isExpectedPowerAction('start', 'Restart'), false);
});
