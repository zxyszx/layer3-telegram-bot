import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { escapeHtml, formatInstanceStatus } from './estimate.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const EMPTY_LEDGER = Object.freeze({ version: 1, active: null, pending: [], history: [] });

function normalizeLedger(value) {
  return {
    version: 1,
    active: value?.active || null,
    pending: Array.isArray(value?.pending) ? value.pending : [],
    history: Array.isArray(value?.history)
      ? value.history.map((session) => (
        session.billing_session_status === 'completed'
          ? calculateSessionCosts(session)
          : session
      ))
      : [],
  };
}

function decimal(value) {
  return value === null || value === undefined || value === ''
    ? null
    : new Decimal(String(value).replaceAll(',', ''));
}

function storedMoney(value) {
  const amount = decimal(value);
  return amount === null ? null : amount.toDecimalPlaces(5).toFixed(5);
}

export function subtractMoney(minuend, subtrahend) {
  const left = decimal(minuend);
  const right = decimal(subtrahend);
  if (left === null || right === null) return null;
  return storedMoney(left.minus(right));
}

export function formatMoney(value) {
  const amount = decimal(value);
  if (amount === null) return '不可用';
  const [integer, fraction] = amount.toDecimalPlaces(2).toFixed(2).split('.');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '不可用';
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return `${minutes} 分 ${remainder} 秒`;
}

function formatDateTime(value) {
  if (!value) return '不可用';
  return new Date(value).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function formatTime(value) {
  if (!value) return '不可用';
  return new Date(value).toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function postCheckLabel(session) {
  const seconds = session.post_shutdown_check_seconds || 300;
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`;
}

export function calculateSessionCosts(session) {
  const result = { ...session };
  if (session.started_at && session.shutdown_at) {
    result.runtime_seconds = Math.max(
      0,
      Math.floor((new Date(session.shutdown_at).getTime() - new Date(session.started_at).getTime()) / 1000),
    );
    result.runtime_minutes = new Decimal(result.runtime_seconds).div(60).toDecimalPlaces(2).toFixed(2);
  }

  result.cost_until_shutdown = subtractMoney(
    session.balance_before_start,
    session.balance_after_shutdown,
  );
  result.cost_after_shutdown = subtractMoney(
    session.balance_after_shutdown,
    session.balance_5min_after_shutdown,
  );
  result.total_observed_cost = subtractMoney(
    session.balance_before_start,
    session.balance_5min_after_shutdown,
  );

  // The final hourly estimate uses the whole observed balance change. Layer3 can
  // post the VM charge only after shutdown, so the immediate snapshot alone is
  // not a reliable cost boundary.
  const cost = decimal(result.total_observed_cost);
  if (cost?.gt(0) && result.runtime_seconds > 0) {
    result.estimated_hourly_cost = storedMoney(
      cost.div(result.runtime_seconds).times(3600),
    );
  } else {
    result.estimated_hourly_cost = null;
  }

  const postShutdownCost = decimal(result.cost_after_shutdown);
  result.post_shutdown_billing_detected = postShutdownCost === null ? null : postShutdownCost.gt(0);
  return result;
}

export function formatFinalBillingReport(session) {
  const noObservedCharge = decimal(session.total_observed_cost)?.eq(0);
  const postBilling = session.post_shutdown_billing_detected;
  const costLines = postBilling
    ? [
      `• 运行阶段观察扣费：NGN ${formatMoney(session.cost_until_shutdown)}`,
      `• 关机后额外余额变化：NGN ${formatMoney(session.cost_after_shutdown)}`,
      `• 总观察余额变化：NGN ${formatMoney(session.total_observed_cost)}`,
      `• 折算小时成本：${session.estimated_hourly_cost ? `NGN ${formatMoney(session.estimated_hourly_cost)} / 小时` : '暂无法计算'}`,
    ]
    : [
      `• 本次观察扣费：NGN ${formatMoney(session.cost_until_shutdown)}`,
      `• 折算小时成本：${session.estimated_hourly_cost ? `NGN ${formatMoney(session.estimated_hourly_cost)} / 小时` : '暂无法计算'}`,
    ];
  const conclusion = postBilling === true
    ? [
      '⚠️ <b>检测到关机后余额继续下降</b>',
      '',
      '可能存在：',
      '• 账单延迟',
      '• Storage',
      '• IP',
      '• 其他保留资源费用',
      '',
      '仅记录现象，不自动判断具体计费项目。',
    ]
    : postBilling === false
      ? ['✅ <b>关机后未发现继续扣费</b>']
      : ['ℹ️ <b>关机后扣费检测数据不完整</b>'];
  const delayedBillingNote = noObservedCharge
    ? ['', 'ℹ️ 当前暂未观察到余额变化', 'Layer3 可能存在账单延迟，本结果仅代表当前查询结果。']
    : [];

  return [
    '✅ <b>Layer3 本次费用验收完成</b>',
    '',
    '🖥 <b>服务器</b>',
    `• 状态：${formatInstanceStatus(session.final_server_status)}`,
    `• Server ID：${escapeHtml(session.server_id)}`,
    '',
    '⏱ <b>运行情况</b>',
    `• 启动时间：${formatTime(session.started_at)}`,
    `• 关机时间：${formatTime(session.shutdown_at)}`,
    `• 实际运行：${formatDuration(session.runtime_seconds)}`,
    `• 自动关机重试：${session.shutdown_retry_count || 0} 次`,
    '',
    '💰 <b>余额变化</b>',
    `• 启动前：NGN ${formatMoney(session.balance_before_start)}`,
    `• 关机前：NGN ${formatMoney(session.balance_before_shutdown)}`,
    `• 关机成功后：NGN ${formatMoney(session.balance_after_shutdown)}`,
    `• 关机 ${postCheckLabel(session)}后：NGN ${formatMoney(session.balance_5min_after_shutdown)}`,
    '',
    '📊 <b>本次费用</b>',
    ...costLines,
    '',
    ...conclusion,
    ...delayedBillingNote,
    '',
    `Run ID：<code>${escapeHtml(session.run_id)}</code>`,
  ].join('\n');
}

export class BillingTracker {
  constructor({
    config,
    layer3,
    store,
    notify,
    logger,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    this.config = config;
    this.layer3 = layer3;
    this.store = store;
    this.notify = notify;
    this.logger = logger;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.operation = Promise.resolve();
    this.postCheckTimers = new Map();
  }

  serial(task) {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => {});
    return next;
  }

  async ledger() {
    return normalizeLedger(await this.store.read());
  }

  async save(ledger) {
    await this.store.write(normalizeLedger(ledger));
  }

  async safeNotify(message) {
    await this.notify(message).catch((error) => {
      this.logger.error('[BILLING] Telegram report failed', { error: error.message });
    });
  }

  async captureBalance(field, notifyFailure = false) {
    try {
      const value = storedMoney(await this.layer3.balanceText());
      return value;
    } catch (error) {
      this.logger.error(`[BILLING] ${field} failed`, { error: error.message });
      if (notifyFailure) {
        await this.safeNotify([
          '⚠️ <b>Layer3 余额查询失败</b>',
          '',
          '服务器仍将按照正常流程运行。',
          '本次费用验收数据可能不完整。',
        ].join('\n'));
      }
      return null;
    }
  }

  async beginRun() {
    const existing = await this.serial(async () => (await this.ledger()).active);
    if (existing) return { session: existing, created: false };

    const requestedAt = this.now().toISOString();
    const balance = await this.captureBalance('balance_before_start', true);
    try {
      return await this.serial(async () => {
        const ledger = await this.ledger();
        if (ledger.active) return { session: ledger.active, created: false };
        const session = {
          run_id: randomUUID(),
          server_id: this.config.instanceName,
          created_at: requestedAt,
          balance_before_start: balance,
          balance_before_shutdown: null,
          balance_after_shutdown: null,
          balance_5min_after_shutdown: null,
          start_requested_at: requestedAt,
          started_at: null,
          scheduled_shutdown_at: null,
          shutdown_requested_at: null,
          shutdown_at: null,
          runtime_seconds: null,
          runtime_minutes: null,
          cost_until_shutdown: null,
          cost_after_shutdown: null,
          total_observed_cost: null,
          estimated_hourly_cost: null,
          shutdown_retry_count: 0,
          final_server_status: null,
          post_shutdown_billing_detected: null,
          billing_session_status: 'start_requested',
          post_shutdown_check_seconds: this.config.postShutdownBillingCheckSeconds,
        };
        ledger.active = session;
        await this.save(ledger);
        this.logger.info(`[BILLING] run_id=${session.run_id} balance_before_start=${balance ?? 'unavailable'}`);
        return { session, created: true };
      });
    } catch (error) {
      this.logger.error('[BILLING] session creation failed', { error: error.message });
      await this.safeNotify('⚠️ 费用验收记录创建失败，但服务器仍将正常启动。');
      return { session: null, created: false };
    }
  }

  async markStarted(runId, scheduledShutdownAt = null) {
    if (!runId) return;
    await this.updateActive(runId, (session) => ({
      ...session,
      started_at: session.started_at || this.now().toISOString(),
      scheduled_shutdown_at: scheduledShutdownAt || session.scheduled_shutdown_at,
      billing_session_status: 'running',
    }), 'server_started');
  }

  async setScheduledShutdown(runId, scheduledShutdownAt) {
    if (!runId) return;
    await this.updateActive(runId, (session) => ({ ...session, scheduled_shutdown_at: scheduledShutdownAt }));
  }

  async markStartFailed(runId, error) {
    if (!runId) return;
    try {
      await this.serial(async () => {
        const ledger = await this.ledger();
        if (ledger.active?.run_id !== runId) return;
        const failed = {
          ...ledger.active,
          billing_session_status: 'start_failed',
          final_server_status: 'UNKNOWN',
          error: error.message,
          completed_at: this.now().toISOString(),
        };
        ledger.active = null;
        ledger.history = [failed, ...ledger.history].slice(0, 100);
        await this.save(ledger);
      });
    } catch (storeError) {
      this.logger.error('[BILLING] start failure persistence failed', { error: storeError.message });
    }
  }

  async beforeShutdownAttempt() {
    const active = await this.serial(async () => (await this.ledger()).active);
    if (!active) return;
    const requestedAt = this.now().toISOString();
    const balance = active.balance_before_shutdown === null
      ? await this.captureBalance('balance_before_shutdown')
      : active.balance_before_shutdown;
    await this.updateActive(active.run_id, (session) => ({
      ...session,
      balance_before_shutdown: session.balance_before_shutdown ?? balance,
      shutdown_requested_at: session.shutdown_requested_at || requestedAt,
      billing_session_status: 'shutdown_requested',
    }), balance ? `balance_before_shutdown=${balance}` : null);
  }

  async markShutdownFailure(error) {
    try {
      await this.serial(async () => {
        const ledger = await this.ledger();
        if (!ledger.active) return;
        ledger.active = {
          ...ledger.active,
          shutdown_retry_count: (ledger.active.shutdown_retry_count || 0) + 1,
          billing_session_status: 'shutdown_retrying',
          last_shutdown_error: error.message,
        };
        await this.save(ledger);
        this.logger.warn(`[BILLING] run_id=${ledger.active.run_id} shutdown_retry_count=${ledger.active.shutdown_retry_count}`);
      });
    } catch (storeError) {
      this.logger.error('[BILLING] shutdown retry persistence failed', { error: storeError.message });
    }
  }

  async markShutdownSucceeded(finalStatus = 'STOPPED') {
    const active = await this.serial(async () => (await this.ledger()).active);
    if (!active) return null;
    const shutdownAt = this.now().toISOString();
    const balance = await this.captureBalance('balance_after_shutdown');
    const checkAt = new Date(
      new Date(shutdownAt).getTime() + this.config.postShutdownBillingCheckSeconds * 1000,
    ).toISOString();
    let pending = null;
    try {
      pending = await this.serial(async () => {
        const ledger = await this.ledger();
        if (ledger.active?.run_id !== active.run_id) return null;
        const completedShutdown = calculateSessionCosts({
          ...ledger.active,
          balance_after_shutdown: balance,
          shutdown_at: shutdownAt,
          final_server_status: finalStatus,
          post_shutdown_check_at: checkAt,
          billing_session_status: 'post_shutdown_pending',
        });
        ledger.active = null;
        ledger.pending = [completedShutdown, ...ledger.pending.filter((item) => item.run_id !== completedShutdown.run_id)];
        await this.save(ledger);
        this.logger.info(`[BILLING] run_id=${completedShutdown.run_id} server_shutdown_success`);
        this.logger.info(`[BILLING] run_id=${completedShutdown.run_id} balance_after_shutdown=${balance ?? 'unavailable'}`);
        return completedShutdown;
      });
    } catch (error) {
      this.logger.error('[BILLING] shutdown success persistence failed', { error: error.message });
    }
    if (pending) this.armPostShutdownCheck(pending);
    return pending;
  }

  async updateActive(runId, updater, logSuffix = null) {
    try {
      await this.serial(async () => {
        const ledger = await this.ledger();
        if (ledger.active?.run_id !== runId) return;
        ledger.active = updater(ledger.active);
        await this.save(ledger);
        if (logSuffix) this.logger.info(`[BILLING] run_id=${runId} ${logSuffix}`);
      });
    } catch (error) {
      this.logger.error('[BILLING] active session update failed', { error: error.message });
    }
  }

  armPostShutdownCheck(session) {
    const existing = this.postCheckTimers.get(session.run_id);
    if (existing) this.clearTimer(existing);
    const delay = Math.max(0, new Date(session.post_shutdown_check_at).getTime() - this.now().getTime());
    const timer = this.setTimer(
      () => this.runPostShutdownCheck(session.run_id),
      Math.min(delay, 2_147_000_000),
    );
    this.postCheckTimers.set(session.run_id, timer);
    this.logger.info(`[BILLING] run_id=${session.run_id} post_shutdown_check_armed`, { delayMs: delay });
  }

  async runPostShutdownCheck(runId) {
    const pending = await this.serial(async () => (await this.ledger()).pending.find((item) => item.run_id === runId));
    if (!pending) return null;
    const remaining = new Date(pending.post_shutdown_check_at).getTime() - this.now().getTime();
    if (remaining > 1000) {
      this.armPostShutdownCheck(pending);
      return null;
    }

    const balance = await this.captureBalance('balance_5min_after_shutdown');
    if (balance === null) {
      const retryAt = new Date(this.now().getTime() + this.config.postShutdownBillingCheckSeconds * 1000).toISOString();
      let retrySession = pending;
      try {
        await this.serial(async () => {
          const ledger = await this.ledger();
          const index = ledger.pending.findIndex((item) => item.run_id === runId);
          if (index < 0) return;
          retrySession = {
            ...ledger.pending[index],
            post_shutdown_check_at: retryAt,
            post_shutdown_check_failures: (ledger.pending[index].post_shutdown_check_failures || 0) + 1,
          };
          ledger.pending[index] = retrySession;
          await this.save(ledger);
        });
      } catch (error) {
        this.logger.error('[BILLING] post-shutdown retry persistence failed', { error: error.message });
      }
      this.armPostShutdownCheck(retrySession);
      const delay = postCheckLabel(retrySession);
      await this.safeNotify(`⚠️ 关机后余额复查失败，机器人将在 ${delay}后继续重试。`);
      return null;
    }

    let completed = null;
    try {
      completed = await this.serial(async () => {
        const ledger = await this.ledger();
        const index = ledger.pending.findIndex((item) => item.run_id === runId);
        if (index < 0) return null;
        const session = calculateSessionCosts({
          ...ledger.pending[index],
          balance_5min_after_shutdown: balance,
          billing_session_status: 'completed',
          completed_at: this.now().toISOString(),
        });
        ledger.pending.splice(index, 1);
        ledger.history = [session, ...ledger.history].slice(0, 100);
        await this.save(ledger);
        return session;
      });
    } catch (error) {
      this.logger.error('[BILLING] history persistence failed', { error: error.message });
      return null;
    }
    this.postCheckTimers.delete(runId);
    if (!completed) return null;

    this.logger.info(`[BILLING] run_id=${runId} post_shutdown_check=${balance}`);
    this.logger.info(`[BILLING] run_id=${runId} observed_cost=${completed.total_observed_cost ?? 'unavailable'}`);
    this.logger.info(`[BILLING] run_id=${runId} hourly_cost=${completed.estimated_hourly_cost ?? 'unavailable'}`);
    this.logger.info(`[BILLING] run_id=${runId} completed`);
    await this.safeNotify(formatFinalBillingReport(completed));
    return completed;
  }

  async restore() {
    let ledger;
    try {
      ledger = await this.ledger();
    } catch (error) {
      this.logger.error('[BILLING] restore failed', { error: error.message });
      return;
    }
    for (const pending of ledger.pending) this.armPostShutdownCheck(pending);
    if (!ledger.active) return;

    try {
      const status = await this.layer3.status();
      if (status.instanceStatus === 'STOPPED') {
        await this.beforeShutdownAttempt();
        await this.markShutdownSucceeded('STOPPED');
      } else {
        this.logger.info(`[BILLING] run_id=${ledger.active.run_id} restored status=${status.instanceStatus}`);
      }
    } catch (error) {
      this.logger.error('[BILLING] active session status restore failed', { error: error.message });
    }
  }

  async activeStatus(currentBalance) {
    const active = await this.serial(async () => (await this.ledger()).active);
    if (!active) return '';
    const started = active.started_at ? new Date(active.started_at).getTime() : null;
    const elapsed = started ? Math.max(0, Math.floor((this.now().getTime() - started) / 1000)) : null;
    const current = storedMoney(currentBalance);
    const observed = subtractMoney(active.balance_before_start, current);
    return [
      '🧾 <b>当前费用验收</b>',
      `• 已运行：${elapsed === null ? '等待启动' : formatDuration(elapsed)}`,
      `• 启动前余额：NGN ${formatMoney(active.balance_before_start)}`,
      `• 当前余额：NGN ${formatMoney(current)}`,
      `• 当前观察余额变化：NGN ${formatMoney(observed)}`,
      `• Run ID：<code>${escapeHtml(active.run_id)}</code>`,
    ].join('\n');
  }

  async latestCostReport() {
    const ledger = await this.serial(async () => this.ledger());
    const session = ledger.history.find((item) => item.billing_session_status === 'completed');
    if (!session) return '💰 暂无已完成的 Layer3 费用验收记录。';
    return [
      '💰 <b>最近一次 Layer3 费用</b>',
      '',
      `• 时间：${formatDateTime(session.shutdown_at)}`,
      `• 实际运行：${formatDuration(session.runtime_seconds)}`,
      `• 启动前余额：NGN ${formatMoney(session.balance_before_start)}`,
      `• 关机后余额：NGN ${formatMoney(session.balance_after_shutdown)}`,
      `• 本次总观察扣费：NGN ${formatMoney(session.total_observed_cost)}`,
      `• 折算：${session.estimated_hourly_cost ? `NGN ${formatMoney(session.estimated_hourly_cost)} / 小时` : '暂无法计算'}`,
      `• 关机后继续扣费：${session.post_shutdown_billing_detected === true ? '是' : session.post_shutdown_billing_detected === false ? '否' : '数据不完整'}`,
      `• Run ID：<code>${escapeHtml(session.run_id)}</code>`,
    ].join('\n');
  }

  async recentCostsReport() {
    const ledger = await this.serial(async () => this.ledger());
    const sessions = ledger.history.filter((item) => item.billing_session_status === 'completed').slice(0, 5);
    if (sessions.length === 0) return '📊 暂无已完成的 Layer3 费用验收记录。';
    const lines = ['📊 <b>Layer3 最近费用记录</b>'];
    sessions.forEach((session, index) => {
      lines.push(
        '',
        `${index + 1}.`,
        `运行：${formatDuration(session.runtime_seconds)}`,
        `费用：NGN ${formatMoney(session.total_observed_cost)}`,
        `约：${session.estimated_hourly_cost ? `NGN ${formatMoney(session.estimated_hourly_cost)}/h` : '暂无法计算'}`,
      );
    });
    const valid = sessions.filter((session) => (
      session.runtime_seconds > 0 && decimal(session.total_observed_cost)?.gt(0)
        && decimal(session.estimated_hourly_cost)?.gt(0)
    ));
    if (valid.length >= 3) {
      const average = Decimal.sum(...valid.map((session) => decimal(session.estimated_hourly_cost)))
        .div(valid.length);
      lines.push('', '📈 <b>最近有效运行平均成本：</b>', `NGN ${formatMoney(average)} / 小时`);
    }
    return lines.join('\n');
  }

  async close() {
    for (const timer of this.postCheckTimers.values()) this.clearTimer(timer);
    this.postCheckTimers.clear();
  }
}

export { EMPTY_LEDGER };
