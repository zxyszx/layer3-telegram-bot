import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const STATUS_PATTERNS = [
  ['RUNNING', /\b(running|active)\b/i],
  ['STOPPED', /\b(stopped|shut\s*off|powered\s*off)\b/i],
  ['STARTING', /\b(starting|booting)\b/i],
  ['STOPPING', /\b(stopping|shutting\s*down)\b/i],
  ['SUSPENDED', /\b(suspended|paused|shelved)\b/i],
];

const POWER_ACTION_PATTERNS = {
  start: /^(Power On|Start|Run)$/i,
  stop: /^(Power Off|Shut down|Shutdown|Stop)$/i,
};

export function isExpectedPowerAction(kind, label) {
  return Boolean(POWER_ACTION_PATTERNS[kind]?.test(label.trim()));
}

export function expectedPowerControlForStatus(status) {
  if (status === 'RUNNING') return 'stop';
  if (status === 'STOPPED') return 'start';
  return null;
}

export class LoginRequiredError extends Error {}

export class Layer3Browser {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.page = null;
    this.operation = Promise.resolve();
  }

  async init() {
    await fs.mkdir(this.config.profileDir, { recursive: true, mode: 0o700 });
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: this.config.headless,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
  }

  async close() {
    await this.context?.close();
  }

  serial(task) {
    const next = this.operation.then(task, task);
    this.operation = next.catch(() => {});
    return next;
  }

  async ensureReady(targetUrl = this.config.instancesUrl) {
    if (!this.context) await this.init();
    await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await this.waitForPortalReady();

    const initialUrl = this.page.url();
    const initialBody = await this.page.locator('body').innerText().catch(() => '');
    if (/login|sign-?in/i.test(initialUrl) || /sign in|log in|login/i.test(initialBody.slice(0, 500))) {
      await this.page.locator('input[type="password"]').first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .catch(() => {});
    }
    const loggedIn = await this.tryAutomaticLogin();

    if (loggedIn) {
      await this.page.waitForFunction(
        () => !document.querySelector('input[type="password"]'),
        null,
        { timeout: 30_000 },
      ).catch(() => {});

      if (new URL(this.page.url()).pathname !== new URL(targetUrl).pathname) {
        await this.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      }
      await this.waitForPortalReady();
    }

    const currentUrl = this.page.url();
    const body = await this.page.locator('body').innerText().catch(() => '');
    if (/login|sign-?in/i.test(currentUrl) || /sign in|log in|login/i.test(body.slice(0, 500))) {
      throw new LoginRequiredError('Layer3 login expired. Run npm run login or configure login credentials.');
    }
  }

  async waitForPortalReady() {
    await this.page.waitForFunction(
      (instanceName) => {
        const body = document.body?.innerText || '';
        return Boolean(document.querySelector('input[type="password"]'))
          || body.includes(instanceName)
          || /Infra Credits/i.test(body)
          || /sign in|log in|login/i.test(body.slice(0, 500));
      },
      this.config.instanceName,
      { timeout: 45_000 },
    ).catch(() => {});
  }

  async tryAutomaticLogin() {
    const password = this.page.locator('input[type="password"]').first();
    if (!await password.isVisible().catch(() => false)) return false;
    if (!this.config.email || !this.config.password) return false;

    const email = this.page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first();
    if (!await email.isVisible().catch(() => false)) return false;

    this.logger.info('Refreshing Layer3 login session');
    await email.fill(this.config.email);
    await password.fill(this.config.password);
    const submit = this.page.getByRole('button', { name: /sign in|log in|login/i }).first();
    await submit.click();
    return true;
  }

  async readBalanceText() {
    const text = await this.page.locator('body').innerText();
    const match = text.match(/Infra Credits[\s\S]{0,120}?NGN\s*([\d,.]+)/i)
      || text.match(/NGN\s*([\d,.]+)[\s\S]{0,80}?Infra Credits/i);
    if (!match) throw new Error('Could not read Infra Credits balance from Layer3 console');
    return match[1].replaceAll(',', '');
  }

  async readBalance() {
    return Number(await this.readBalanceText());
  }

  async openInstance() {
    await this.ensureReady(this.config.instanceUrl);
    await this.page.waitForFunction(
      (instanceName) => (document.body?.innerText || '').includes(instanceName),
      this.config.instanceName,
      { timeout: 45_000 },
    ).catch(() => {});
    const body = await this.page.locator('body').innerText().catch(() => '');
    if (!body.includes(this.config.instanceName)) {
      throw new Error(`Instance not found: ${this.config.instanceName}`);
    }
  }

  async readInstanceStatus() {
    const body = await this.page.locator('body').innerText();
    const explicit = body.match(/Status:\s*(Running|Active|Stopped|Starting|Booting|Stopping|Shutting down|Suspended|Paused|Shelved)/i);
    if (explicit) {
      for (const [status, pattern] of STATUS_PATTERNS) {
        if (pattern.test(explicit[1])) return status;
      }
    }
    const anchor = body.toLowerCase().indexOf(this.config.instanceName.toLowerCase());
    const nearby = anchor >= 0 ? body.slice(Math.max(0, anchor - 300), anchor + 900) : body;
    for (const [status, pattern] of STATUS_PATTERNS) {
      if (pattern.test(nearby)) return status;
    }
    return 'UNKNOWN';
  }

  async status() {
    return this.serial(async () => {
      await this.openInstance();
      const balanceText = await this.readBalanceText();
      return {
        balance: Number(balanceText),
        balanceText,
        instanceStatus: await this.readInstanceStatus(),
      };
    });
  }

  async balanceText() {
    return this.serial(async () => {
      await this.openInstance();
      return this.readBalanceText();
    });
  }

  async findPowerControl(kind) {
    const status = this.page.getByText(/^Status:/i).first();
    if (!await status.isVisible().catch(() => false)) {
      throw new Error('Could not locate the Layer3 power control area');
    }

    const observedLabels = new Set();
    for (const depth of [2, 3, 4]) {
      const ancestor = Array.from({ length: depth }, () => '..').join('/');
      const buttons = status.locator(`xpath=${ancestor}`).locator('button');
      const count = Math.min(await buttons.count(), 30);

      for (let index = 0; index < count; index += 1) {
        const candidate = buttons.nth(index);
        if (!await candidate.isVisible().catch(() => false)) continue;

        await candidate.hover().catch(() => {});
        await this.page.waitForTimeout(250);
        const labels = await this.page.locator('[role="tooltip"]:visible').allInnerTexts().catch(() => []);
        const label = labels.at(-1)?.trim() || '';
        if (label) observedLabels.add(label);
        if (isExpectedPowerAction(kind, label)) {
          return { control: candidate, label };
        }
      }
    }

    const expected = kind === 'start' ? 'Power On' : 'Power Off';
    const observed = [...observedLabels].join(', ') || 'none';
    throw new Error(`Could not locate the Layer3 ${expected} control (seen: ${observed})`);
  }

  async clickPowerControl(kind) {
    const { control, label } = await this.findPowerControl(kind);
    this.logger.info('Layer3 power control located', { kind, label });
    await control.click();
    await this.page.waitForTimeout(350);
    const dialog = this.page.getByRole('dialog').last();
    if (await dialog.isVisible().catch(() => false)) {
      const confirmPattern = kind === 'start'
        ? /^(Power On|Start|Run|Confirm|Yes)$/i
        : /^(Power Off|Shut down|Shutdown|Stop|Confirm|Yes)$/i;
      await dialog.getByRole('button', { name: confirmPattern }).last().click();
    }
  }

  async waitForStatus(expected, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last = 'UNKNOWN';
    let confirmations = 0;
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3000);
      await this.ensureReady(this.config.instanceUrl);
      last = await this.readInstanceStatus();
      const expectedPowerKind = expectedPowerControlForStatus(expected);
      if (last !== expected || !expectedPowerKind) {
        confirmations = 0;
        continue;
      }

      try {
        const { label } = await this.findPowerControl(expectedPowerKind);
        confirmations += 1;
        this.logger.info('Layer3 status verification passed', {
          status: last,
          powerControl: label,
          confirmation: confirmations,
        });
        if (confirmations >= 2) return last;
      } catch (error) {
        confirmations = 0;
        this.logger.warn('Layer3 status verification disagreed', {
          status: last,
          error: error.message,
        });
      }
    }
    throw new Error(`Timed out waiting for verified ${expected}; last status was ${last}`);
  }

  async start() {
    return this.serial(async () => {
      await this.openInstance();
      const current = await this.readInstanceStatus();
      if (current === 'RUNNING') {
        return { changed: false, status: await this.waitForStatus('RUNNING', 60_000) };
      }
      await this.clickPowerControl('start');
      return { changed: true, status: await this.waitForStatus('RUNNING', 3 * 60_000) };
    });
  }

  async stop() {
    return this.serial(async () => {
      await this.openInstance();
      const current = await this.readInstanceStatus();
      if (current === 'STOPPED') {
        return { changed: false, status: await this.waitForStatus('STOPPED', 60_000) };
      }
      await this.clickPowerControl('stop');
      return { changed: true, status: await this.waitForStatus('STOPPED', 11 * 60_000) };
    });
  }
}
