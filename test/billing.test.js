import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BillingTracker,
  calculateSessionCosts,
  formatFinalBillingReport,
  subtractMoney,
} from '../src/billing.js';
import { createBillingAwareLayer3 } from '../src/lifecycle.js';

function memoryStore(initial = {}) {
  let state = structuredClone(initial);
  return {
    read: async () => structuredClone(state),
    write: async (value) => { state = structuredClone(value); },
  };
}

function harness({ balances = [], initial = {}, status = 'STOPPED' } = {}) {
  let currentTime = new Date('2026-08-16T14:03:12.000Z');
  const notifications = [];
  const logs = [];
  const timers = [];
  const layer3 = {
    balanceText: async () => {
      const value = balances.shift();
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error('missing balance');
      return value;
    },
    status: async () => ({ balance: 50003.16, instanceStatus: status }),
  };
  const store = memoryStore(initial);
  const config = {
    instanceName: 'vm-test',
    postShutdownBillingCheckSeconds: 300,
  };
  const logger = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };
  const tracker = new BillingTracker({
    config,
    layer3,
    store,
    notify: async (message) => notifications.push(message),
    logger,
    now: () => new Date(currentTime),
    setTimer: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimer() {},
  });
  return {
    tracker,
    store,
    layer3,
    notifications,
    logs,
    timers,
    setTime: (value) => { currentTime = new Date(value); },
  };
}

test('uses exact decimal subtraction for Layer3 balances', () => {
  assert.equal(subtractMoney('50003.16', '49978.16'), '25.00000');
  assert.equal(subtractMoney('49978.16', '49977.66'), '0.50000');
});

test('reuses one active billing run instead of creating duplicates', async () => {
  const h = harness({ balances: ['50003.16000'] });
  const first = await h.tracker.beginRun();
  const second = await h.tracker.beginRun();
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.session.run_id, first.session.run_id);
  assert.equal((await h.store.read()).active.run_id, first.session.run_id);
});

test('records a complete billing lifecycle and post-shutdown charge', async () => {
  const h = harness({ balances: ['50003.16', '49978.16', '49978.16', '49977.66'] });
  const { session } = await h.tracker.beginRun();
  await h.tracker.markStarted(session.run_id);
  h.setTime('2026-08-16T15:03:25.000Z');
  await h.tracker.beforeShutdownAttempt();
  await h.tracker.markShutdownSucceeded('STOPPED');
  h.setTime('2026-08-16T15:08:25.000Z');
  const completed = await h.tracker.runPostShutdownCheck(session.run_id);

  assert.equal(completed.runtime_seconds, 3613);
  assert.equal(completed.runtime_minutes, '60.22');
  assert.equal(completed.cost_until_shutdown, '25.00000');
  assert.equal(completed.cost_after_shutdown, '0.50000');
  assert.equal(completed.total_observed_cost, '25.50000');
  assert.equal(completed.estimated_hourly_cost, '25.40825');
  assert.equal(completed.post_shutdown_billing_detected, true);
  assert.equal(completed.final_server_status, 'STOPPED');
  assert.equal((await h.store.read()).history.length, 1);
  assert.match(h.notifications.at(-1), /检测到关机后余额继续下降/);
});

test('reports delayed billing without claiming a zero hourly price', () => {
  const session = calculateSessionCosts({
    run_id: 'run-zero',
    server_id: 'vm-test',
    started_at: '2026-08-16T14:00:00.000Z',
    shutdown_at: '2026-08-16T15:00:00.000Z',
    balance_before_start: '50003.16000',
    balance_before_shutdown: '50003.16000',
    balance_after_shutdown: '50003.16000',
    balance_5min_after_shutdown: '50003.16000',
    shutdown_retry_count: 0,
    final_server_status: 'STOPPED',
  });
  const report = formatFinalBillingReport(session);
  assert.equal(session.estimated_hourly_cost, null);
  assert.match(report, /暂无法计算/);
  assert.match(report, /可能存在账单延迟/);
  assert.doesNotMatch(report, /NGN 0\.00 \/ 小时/);
});

test('uses a delayed charge in the total cost and hourly estimate without contradictory text', () => {
  const session = calculateSessionCosts({
    run_id: 'run-delayed',
    server_id: 'vm-test',
    started_at: '2026-08-16T15:27:48.000Z',
    shutdown_at: '2026-08-16T15:29:33.000Z',
    balance_before_start: '50003.16000',
    balance_before_shutdown: '50003.16000',
    balance_after_shutdown: '50003.16000',
    balance_5min_after_shutdown: '49980.78000',
    shutdown_retry_count: 0,
    final_server_status: 'STOPPED',
  });
  const report = formatFinalBillingReport(session);
  assert.equal(session.cost_until_shutdown, '0.00000');
  assert.equal(session.cost_after_shutdown, '22.38000');
  assert.equal(session.total_observed_cost, '22.38000');
  assert.equal(session.estimated_hourly_cost, '767.31429');
  assert.match(report, /总观察余额变化：NGN 22\.38/);
  assert.match(report, /NGN 767\.31 \/ 小时/);
  assert.doesNotMatch(report, /当前暂未观察到余额变化/);
});

test('balance failures never block start or shutdown', async () => {
  const h = harness({ balances: [new Error('balance timeout'), new Error('balance timeout'), new Error('balance timeout')] });
  let starts = 0;
  let stops = 0;
  const rawLayer3 = {
    ...h.layer3,
    start: async () => {
      starts += 1;
      return { changed: true, status: 'RUNNING' };
    },
    stop: async () => {
      stops += 1;
      return { changed: true, status: 'STOPPED' };
    },
  };
  h.tracker.layer3 = rawLayer3;
  const lifecycle = createBillingAwareLayer3(rawLayer3, h.tracker);
  await lifecycle.start();
  await lifecycle.stop();
  const ledger = await h.store.read();
  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(ledger.active, null);
  assert.equal(ledger.pending.length, 1);
  assert.equal(ledger.pending[0].balance_before_start, null);
  assert.match(h.notifications[0], /余额查询失败/);
});

test('unexpected billing hook failures never change power results', async () => {
  const rawLayer3 = {
    status: async () => ({ instanceStatus: 'STOPPED' }),
    start: async () => ({ changed: true, status: 'RUNNING' }),
    stop: async () => ({ changed: true, status: 'STOPPED' }),
  };
  const failingBilling = new Proxy({}, {
    get: () => async () => { throw new Error('broken billing store'); },
  });
  const errors = [];
  const lifecycle = createBillingAwareLayer3(rawLayer3, failingBilling, {
    error: (...args) => errors.push(args),
  });
  assert.deepEqual(await lifecycle.start(), {
    changed: true,
    status: 'RUNNING',
    billingRunId: null,
  });
  assert.deepEqual(await lifecycle.stop(), { changed: true, status: 'STOPPED' });
  assert.ok(errors.length >= 4);
});

test('shutdown retry count remains attached until a real stop succeeds', async () => {
  const h = harness({ balances: ['50003.16', '49978.16', '49978.16'] });
  let stopAttempts = 0;
  const rawLayer3 = {
    ...h.layer3,
    start: async () => ({ changed: true, status: 'RUNNING' }),
    stop: async () => {
      stopAttempts += 1;
      if (stopAttempts === 1) throw new Error('temporary stop failure');
      return { changed: true, status: 'STOPPED' };
    },
  };
  h.tracker.layer3 = rawLayer3;
  const lifecycle = createBillingAwareLayer3(rawLayer3, h.tracker);
  await lifecycle.start();
  await assert.rejects(() => lifecycle.stop(), /temporary stop failure/);
  assert.equal((await h.store.read()).active.shutdown_retry_count, 1);
  await lifecycle.stop();
  const ledger = await h.store.read();
  assert.equal(ledger.active, null);
  assert.equal(ledger.pending[0].shutdown_retry_count, 1);
});

test('restore keeps the original active schedule and rearms pending checks', async () => {
  const active = {
    run_id: 'active-run',
    server_id: 'vm-test',
    scheduled_shutdown_at: '2026-08-16T15:03:12.000Z',
    billing_session_status: 'running',
  };
  const pending = {
    run_id: 'pending-run',
    server_id: 'vm-test',
    post_shutdown_check_at: '2026-08-16T14:08:12.000Z',
    billing_session_status: 'post_shutdown_pending',
  };
  const h = harness({
    initial: { version: 1, active, pending: [pending], history: [] },
    status: 'RUNNING',
  });
  await h.tracker.restore();
  const ledger = await h.store.read();
  assert.equal(ledger.active.scheduled_shutdown_at, '2026-08-16T15:03:12.000Z');
  assert.equal(h.timers.length, 1);
  assert.equal(h.timers[0].delay, 300000);
});

test('retries a failed post-shutdown balance check and later completes the run', async () => {
  const pending = {
    run_id: 'pending-retry',
    server_id: 'vm-test',
    started_at: '2026-08-16T13:00:00.000Z',
    shutdown_at: '2026-08-16T14:00:00.000Z',
    balance_before_start: '50003.16000',
    balance_after_shutdown: '49978.16000',
    post_shutdown_check_at: '2026-08-16T14:03:12.000Z',
    post_shutdown_check_seconds: 300,
    billing_session_status: 'post_shutdown_pending',
  };
  const h = harness({
    balances: [new Error('temporary query failure'), '49977.66000'],
    initial: { version: 1, active: null, pending: [pending], history: [] },
  });
  assert.equal(await h.tracker.runPostShutdownCheck(pending.run_id), null);
  let ledger = await h.store.read();
  assert.equal(ledger.pending[0].post_shutdown_check_failures, 1);
  assert.equal(ledger.history.length, 0);
  assert.equal(h.timers.length, 1);

  h.setTime('2026-08-16T14:08:12.000Z');
  const completed = await h.tracker.runPostShutdownCheck(pending.run_id);
  ledger = await h.store.read();
  assert.equal(completed.total_observed_cost, '25.50000');
  assert.equal(ledger.pending.length, 0);
  assert.equal(ledger.history.length, 1);
});

test('keeps only the newest 100 billing history records', async () => {
  const pending = {
    run_id: 'new-run',
    server_id: 'vm-test',
    started_at: '2026-08-16T13:00:00.000Z',
    shutdown_at: '2026-08-16T14:00:00.000Z',
    balance_before_start: '50003.16000',
    balance_after_shutdown: '49978.16000',
    post_shutdown_check_at: '2026-08-16T14:03:12.000Z',
    billing_session_status: 'post_shutdown_pending',
  };
  const oldHistory = Array.from({ length: 100 }, (_, index) => ({
    run_id: `old-${index}`,
    billing_session_status: 'completed',
  }));
  const h = harness({
    balances: ['49977.66000'],
    initial: { version: 1, active: null, pending: [pending], history: oldHistory },
  });
  await h.tracker.runPostShutdownCheck(pending.run_id);
  const ledger = await h.store.read();
  assert.equal(ledger.history.length, 100);
  assert.equal(ledger.history[0].run_id, 'new-run');
  assert.equal(ledger.history.at(-1).run_id, 'old-98');
});

test('cost history reports the latest five and averages valid recent runs', async () => {
  const history = [25, 24, 26].map((hourly, index) => ({
    run_id: `run-${index}`,
    server_id: 'vm-test',
    billing_session_status: 'completed',
    shutdown_at: `2026-08-1${6 - index}T15:00:00.000Z`,
    runtime_seconds: 3600,
    balance_before_start: '50000.00000',
    balance_after_shutdown: `${50000 - hourly}.00000`,
    cost_until_shutdown: `${hourly}.00000`,
    balance_5min_after_shutdown: `${50000 - hourly}.00000`,
    total_observed_cost: `${hourly}.00000`,
    estimated_hourly_cost: `${hourly}.00000`,
    post_shutdown_billing_detected: false,
  }));
  const h = harness({ initial: { version: 1, active: null, pending: [], history } });
  const report = await h.tracker.recentCostsReport();
  assert.match(report, /1\./);
  assert.match(report, /3\./);
  assert.match(report, /最近有效运行平均成本/);
  assert.match(report, /NGN 25\.00 \/ 小时/);
});
