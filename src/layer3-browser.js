import fs from 'node:fs/promises';
import { chromium } from 'playwright';

const STATUS_PATTERNS = [
  ['RUNNING', /\b(running|active)\b/i],
  ['STOPPED', /\b(stopped|shut\s*off|powered\s*off)\b/i],
  ['STARTING', /\b(starting|booting)\b/i],
  ['STOPPING', /\b(stopping|shutting\s*down)\b/i],
  ['SUSPENDED', /\b(suspended|paused|shelved)\b/i],
];

export class LoginRequiredError extends Error {}

export function buildInstanceUrl(consoleOrigin, projectSlug, instanceName) {
  return `${consoleOrigin}/app/projects/${encodeURIComponent(projectSlug)}/${encodeURIComponent(instanceName)}/overview`;
}

function parseNgn(text, labelPattern) {
  const match = text.match(new RegExp(`NGN\\s*([\\d,.]+)[\\s\\S]{0,80}?${labelPattern}`, 'i'))
    || text.match(new RegExp(`${labelPattern}[\\s\\S]{0,80}?NGN\\s*([\\d,.]+)`, 'i'));
  return match ? Number(match[1].replaceAll(',', '')) : null;
}

function parseInstanceCounts(text) {
  const match = text.match(/(\d+)\s+Total\s+(\d+)\s+Running\s+(\d+)\s+Stopped\s+(\d+)\s+Error/i);
  if (!match) return null;
  return {
    total: Number(match[1]),
    running: Number(match[2]),
    stopped: Number(match[3]),
    error: Number(match[4]),
  };
}

function parseRowDetails(text) {
  const ip = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] || '';
  const cpu = text.match(/\b\d+\s+CORE\b/i)?.[0] || '';
  const memoryStorage = [...text.matchAll(/(\d+(?:\.\d+)?)\s*\(GB\)/gi)].map((match) => `${match[1]} GB`);
  const region = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Nigeria\b/)?.[0] || '';
  return {
    ip,
    cpu,
    ram: memoryStorage[0] || '',
    storage: memoryStorage[1] || '',
    region,
  };
}

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
    await this.page.waitForTimeout(1800);
    await this.tryAutomaticLogin();
    await this.waitForConsoleLoaded();

    const currentUrl = this.page.url();
    const body = await this.page.locator('body').innerText().catch(() => '');
    if (/login|sign-?in/i.test(currentUrl) || /sign in|log in|login/i.test(body.slice(0, 500))) {
      throw new LoginRequiredError('Layer3 login expired. Run npm run login or configure login credentials.');
    }
  }

  async waitForConsoleLoaded() {
    const deadline = Date.now() + 25_000;
    let body = '';
    while (Date.now() < deadline) {
      body = await this.page.locator('body').innerText().catch(() => '');
      if (body && !/Connecting to the cloud/i.test(body) && /Infra Credits|Instances|Dashboard|Virtual Machine/i.test(body)) {
        return;
      }
      await this.page.waitForTimeout(1000);
    }
    this.logger.warn('Layer3 console still looked busy after waiting', { body: body.slice(0, 120) });
  }

  async tryAutomaticLogin() {
    const password = this.page.locator('input[type="password"]').first();
    if (!await password.isVisible().catch(() => false)) return;
    if (!this.config.email || !this.config.password) return;

    const email = this.page.locator('input[type="email"], input[name*="email" i], input[name*="user" i]').first();
    if (!await email.isVisible().catch(() => false)) return;

    this.logger.info('Refreshing Layer3 login session');
    await email.fill(this.config.email);
    await password.fill(this.config.password);
    const submit = this.page.getByRole('button', { name: /sign in|log in|login/i }).first();
    await submit.click();
    await this.page.waitForTimeout(2200);
  }

  async readBalance() {
    const text = await this.page.locator('body').innerText();
    const match = text.match(/Infra Credits[\s\S]{0,120}?NGN\s*([\d,.]+)/i)
      || text.match(/NGN\s*([\d,.]+)[\s\S]{0,80}?Infra Credits/i);
    if (!match) throw new Error('Could not read Infra Credits balance from Layer3 console');
    return Number(match[1].replaceAll(',', ''));
  }

  async listInstances() {
    return this.serial(async () => {
      await this.ensureReady(this.config.instancesUrl);
      await this.page.locator('a[href*="/app/projects/"]').first().waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});
      const body = await this.page.locator('body').innerText();
      const balance = await this.readBalance().catch(() => null);
      const counts = parseInstanceCounts(body);
      const links = await this.page.locator('a').evaluateAll((anchors) => anchors.map((anchor) => {
        const row = anchor.closest('tr')?.innerText
          || anchor.closest('[class]')?.parentElement?.innerText
          || anchor.closest('tr')?.innerText
          || anchor.parentElement?.innerText
          || anchor.textContent
          || '';
        return {
          href: anchor.href,
          text: anchor.textContent || '',
          row,
        };
      }));
      const seen = new Set();
      const instances = links.flatMap((link) => {
        const match = link.href.match(/\/app\/projects\/([^/]+)\/(vm-[^/]+)\/overview/i);
        if (!match || seen.has(link.href)) return [];
        seen.add(link.href);
        return [{
          name: decodeURIComponent(match[2]),
          projectSlug: decodeURIComponent(match[1]),
          instanceUrl: link.href,
          ...parseRowDetails(link.row),
        }];
      });
      if (instances.length === 0) {
        this.logger.warn('No Layer3 instances discovered', {
          url: this.page.url(),
          title: await this.page.title().catch(() => ''),
          body: body.slice(0, 500),
        });
      }

      for (const instance of instances) {
        await this.ensureReady(instance.instanceUrl);
        const detailText = await this.page.locator('body').innerText();
        instance.status = await this.readInstanceStatus();
        instance.allTimeConsumption = parseNgn(detailText, 'All Time Consumption');
      }

      return { balance, counts, instances };
    });
  }

  async openInstance() {
    if (!this.config.instanceUrl) {
      throw new Error('Layer3 instance is not bound');
    }
    await this.ensureReady(this.config.instanceUrl);
    const instance = this.page.getByText(this.config.instanceName, { exact: true }).first();
    if (!await instance.isVisible().catch(() => false)) {
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
      return {
        balance: await this.readBalance(),
        instanceStatus: await this.readInstanceStatus(),
      };
    });
  }

  async clickPowerControl(kind) {
    const status = this.page.getByText(/^Status:/i).first();
    if (!await status.isVisible().catch(() => false)) {
      throw new Error('Could not locate the Layer3 power control area');
    }

    const actionPanel = status.locator('xpath=../..');
    const powerControl = actionPanel.locator('button').nth(3);
    if (!await powerControl.isVisible().catch(() => false)) {
      throw new Error('Could not locate the Layer3 power button');
    }

    await powerControl.hover();
    await this.page.waitForTimeout(250);
    const tooltip = this.page.getByRole('tooltip').last();
    const label = await tooltip.innerText().catch(() => '');
    const expected = kind === 'start' ? /power on|start|run/i : /power off|shut down|shutdown|stop/i;
    if (!expected.test(label)) {
      throw new Error(`Unexpected Layer3 power action: ${label || 'unlabelled button'}`);
    }

    await powerControl.click();
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
    while (Date.now() < deadline) {
      await this.page.waitForTimeout(3000);
      await this.ensureReady(this.config.instanceUrl);
      last = await this.readInstanceStatus();
      if (last === expected) return last;
    }
    throw new Error(`Timed out waiting for ${expected}; last status was ${last}`);
  }

  async start() {
    return this.serial(async () => {
      await this.openInstance();
      const current = await this.readInstanceStatus();
      if (current === 'RUNNING') return { changed: false, status: current };
      await this.clickPowerControl('start');
      return { changed: true, status: await this.waitForStatus('RUNNING', 3 * 60_000) };
    });
  }

  async stop() {
    return this.serial(async () => {
      await this.openInstance();
      const current = await this.readInstanceStatus();
      if (current === 'STOPPED') return { changed: false, status: current };
      await this.clickPowerControl('stop');
      return { changed: true, status: await this.waitForStatus('STOPPED', 11 * 60_000) };
    });
  }
}
