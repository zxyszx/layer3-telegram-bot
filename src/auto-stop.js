export class AutoStopScheduler {
  constructor(store, stopAction, notify, logger, retryDelayMs = 5 * 60_000) {
    this.store = store;
    this.stopAction = stopAction;
    this.notify = notify;
    this.logger = logger;
    this.retryDelayMs = retryDelayMs;
    this.timer = null;
  }

  async restore() {
    const state = await this.store.read();
    if (state.autoStopAt) await this.arm(state.autoStopAt, false);
  }

  async schedule(minutes) {
    return this.scheduleSeconds(minutes * 60);
  }

  async scheduleSeconds(seconds) {
    const autoStopAt = new Date(Date.now() + seconds * 1000).toISOString();
    await this.arm(autoStopAt, true);
    return autoStopAt;
  }

  async arm(autoStopAt, persist) {
    if (this.timer) clearTimeout(this.timer);
    if (persist) await this.store.write({ autoStopAt });
    const delay = Math.max(0, new Date(autoStopAt).getTime() - Date.now());
    this.logger.info('Auto-stop armed', { autoStopAt, delayMs: delay });
    this.timer = setTimeout(() => this.execute(), Math.min(delay, 2_147_000_000));
  }

  async execute() {
    try {
      const state = await this.store.read();
      if (!state.autoStopAt) return;
      const remaining = new Date(state.autoStopAt).getTime() - Date.now();
      if (remaining > 1000) {
        await this.arm(state.autoStopAt, false);
        return;
      }
      await this.stopAction();
      await this.store.write({});
      await this.notify('定时任务已执行：机器已关机。');
    } catch (error) {
      this.logger.error('Auto-stop failed', { error: error.message });
      const state = await this.store.read().catch(() => ({}));
      if (state.autoStopAt) {
        this.timer = setTimeout(() => this.execute(), this.retryDelayMs);
        this.logger.warn('Auto-stop retry armed', { retryDelayMs: this.retryDelayMs });
      }
      const retryMinutes = Math.round(this.retryDelayMs / 60_000);
      await this.notify(`自动关机失败：${error.message}\n机器人将在 ${retryMinutes} 分钟后自动重试，请留意状态。`);
    }
  }

  async cancel() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.store.write({});
  }

  async dueAt() {
    return (await this.store.read()).autoStopAt || null;
  }
}
