import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateUsage, formatStatusReport } from '../src/estimate.js';

test('estimates remaining runtime from current Layer3 balance', () => {
  const result = estimateUsage(50_100, 22.37702, 1);
  assert.ok(Math.abs(result.remainingHours - 2238.90) < 0.1);
  assert.ok(Math.abs(result.estimatedYears - 6.13) < 0.02);
});

test('formats Telegram HTML status safely', () => {
  const text = formatStatusReport(
    { balance: 50100, instanceStatus: 'STOPPED' },
    { instanceName: 'vm<&>', hourlyPrice: 22.37702, estimatedHoursPerDay: 1 },
  );
  assert.match(text, /vm&lt;&amp;&gt;/);
  assert.match(text, /STOPPED/);
  assert.match(text, /50,100\.00/);
});
