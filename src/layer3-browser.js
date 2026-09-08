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
  if (match) {
    return {
      total: Number(match[1]),
      running: Number(match[2]),
      stopped: Number(match[3]),
      error: Number(match[4]),
    };
  }

  const compact = text.replace(/\s+/g, ' ');
  const alternate = compact.match(/Total\s+(\d+).*?Running\s+(\d+).*?Stopped\s+(\d+).*?Error\s+(\d+)/i);
  if (!alternate) return null;
  return {
    total: Number(alternate[1]),
    running: Number(alternate[2]),
    stopped: Number(alternate[3]),
    error: Number(alternate[4]),
  };
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/password["']?\s*[:=]\s*["'][^"']+["']/gi, 'password:"[redacted]"')
    .replace(/token["']?\s*[:=]\s*["'][^"']+["']/gi, 'token:"[redacted]"');
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

function deepStrings(value, results = []) {
  if (value == null) return results;
  if (typeof value === 'string' || typeof value === 'number') {
    results.push(String(value));
    return results;
  }
  if (Array.isArray(value)) {
    for (const item of value) deepStrings(item, results);
    return results;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) deepStrings(item, results);
  }
  return results;
}

function findFirstMatchingString(value, pattern) {
  return deepStrings(value).find((item) => pattern.test(item)) || '';
}

function isPublicIpv4(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

function normalizeStatus(value) {
  for (const [status, pattern] of STATUS_PATTERNS) {
    if (pattern.test(String(value || ''))) return status;
  }
  return '';
}

function parseApiInstance(vm, projectsById, consoleOrigin) {
  const name = vm.name || vm.slug || findFirstMatchingString(vm, /^vm-[a-z0-9-]+$/i);
  if (!name) return null;
  const project = vm.project || projectsById.get(vm.project_id) || {};
  const projectSlug = project.slug || vm.project_slug || findFirstMatchingString(project, /^default-\d+$/i);
  const strings = deepStrings(vm);
  const memoryStorage = strings
    .filter((item) => /^\d+(?:\.\d+)?\s*(?:GB|\(GB\))$/i.test(item))
    .map((item) => item.replace(/[()]/g, '').replace(/\s*GB$/i, ' GB'));
  const cpu = strings.find((item) => /^\d+\s+CORE$/i.test(item)) || '';
  const status = normalizeStatus(vm.status || vm.state || vm.power_state || vm.powerState || vm.service_status)
    || normalizeStatus(strings.join(' '));
  const ip = strings.find((item) => isPublicIpv4(item)) || findFirstMatchingString(vm, /^(?:\d{1,3}\.){3}\d{1,3}$/);

  return {
    name,
    projectSlug,
    instanceUrl: projectSlug ? buildInstanceUrl(consoleOrigin, projectSlug, name) : '',
    status,
    ip,
    cpu,
    ram: memoryStorage[0] || '',
    storage: memoryStorage[1] || '',
    region: vm.region?.name || vm.region?.display_name || '',
  };
}

export class Layer3Browser {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.context = null;
    this.page = null;
    this.operation = Promise.resolve();
    this.lastLoginResult = null;
    this.apiCache = {
      projects: null,
      virtualMachines: null,
      serviceSummary: null,
    };
  }

  async init() {
    await fs.mkdir(this.config.profileDir, { recursive: true, mode: 0o700 });
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      headless: this.config.headless,
      viewport: { width: 1440, height: 1000 },
      locale: 'en-US',
      timezoneId: 'Asia/Shanghai',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
      ],
    });
    this.page = this.context.pages()[0] || await this.context.newPage();
    this.trackApiResponses(this.page);
  }

  trackApiResponses(page) {
    page.on('response', async (response) => {
      const url = response.url();
      if (!/api-console\.layer3\.cloud\/api\//i.test(url)) return;
      let payload;
      try {
        payload = await response.json();
      } catch {
        return;
      }

      if (/\/api\/projects(?:[?#]|$)/i.test(url)) {
        this.apiCache.projects = payload;
      } else if (/\/api\/virtual-machines(?:[?#]|$)/i.test(url)) {
        this.apiCache.virtualMachines = payload;
      } else if (/\/api\/services\/Virtual%20Machine\/summary/i.test(url)) {
        this.apiCache.serviceSummary = payload;
      }
    });
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
    await this.tryAutomaticLogin();

    if (await this.isLoginPage()) {
      const body = await this.page.locator('body').innerText().catch(() => '');
      await this.saveDebugSnapshot('login-required');
      const message = this.buildLoginFailureMessage(body);
      throw new LoginRequiredError(message);
    }
  }

  buildLoginFailureMessage(body) {
    const combined = `${body || ''}\n${this.lastLoginResult?.body || ''}`;
    if (/invalid credentials|incorrect|wrong password|invalid email|unauthorized/i.test(combined)) {
      return 'Layer3 自动登录失败：账号或密码不正确。请重新发送 /bind 输入正确邮箱和密码。';
    }
    if (/captcha|verify|verification|two-factor|2fa|otp|code/i.test(combined)) {
      return 'Layer3 自动登录失败：页面要求验证码或二次验证，需要先人工通过验证后再绑定。';
    }
    if (/login form did not render/i.test(combined)) {
      return 'Layer3 自动登录失败：服务器浏览器打开登录页后没有渲染出邮箱/密码输入框。请运行 ngn diagnostics 查看页面摘要。';
    }
    if (this.lastLoginResult?.status) {
      return `Layer3 自动登录失败：登录接口返回 HTTP ${this.lastLoginResult.status}。请运行 ngn diagnostics 查看接口返回内容。`;
    }
    return 'Layer3 自动登录失败：登录后仍停留在登录页。请运行 ngn diagnostics 查看页面诊断信息。';
  }

  async waitForConsoleLoaded() {
    const deadline = Date.now() + 25_000;
    let body = '';
    while (Date.now() < deadline) {
      body = await this.page.locator('body').innerText().catch(() => '');
      if (body && !/Connecting to the cloud/i.test(body) && /Infra Credits|Instances|Dashboard|Virtual Machine/i.test(body)) {
        return;
      }
      if (await this.isLoginPage()) {
        return;
      }
      await this.page.waitForTimeout(1000);
    }
    this.logger.warn('Layer3 console still looked busy after waiting', { body: body.slice(0, 120) });
  }

  async tryAutomaticLogin() {
    if (!this.config.email || !this.config.password) {
      this.logger.warn('Layer3 login credentials are not configured for automatic login', {
        hasEmail: Boolean(this.config.email),
        hasPassword: Boolean(this.config.password),
      });
      return;
    }

    const loginText = await this.page.locator('body').innerText().catch(() => '');
    const looksLikeLogin = await this.isLoginPage(loginText);
    if (!looksLikeLogin) return;

    this.logger.info('Refreshing Layer3 login session', {
      hasEmail: Boolean(this.config.email),
      hasPassword: Boolean(this.config.password),
    });

    if (!await this.waitForLoginFormReady()) {
      this.logger.warn('Layer3 login page did not render usable inputs', {
        url: this.page.url(),
        title: await this.page.title().catch(() => ''),
        body: loginText.slice(0, 300),
      });
      return;
    }

    const emailFilled = await this.fillFirstMatchingInput([
      'input[type="email"]',
      'input[name*="email" i]',
      'input[name*="user" i]',
      'input[id*="email" i]',
      'input[id*="user" i]',
      'input[autocomplete*="email" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="mail" i]',
      'input[type="text"]',
      'input:not([type])',
    ], this.config.email, { preferPassword: false });
    const passwordVisible = await this.hasVisibleMatchingInput([
      'input[type="password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[autocomplete*="password" i]',
      'input[placeholder*="password" i]',
    ]);

    if (emailFilled && !passwordVisible) {
      await this.clickLoginButton(/continue|next|sign in|log in|login|submit/i).catch(() => {});
      await this.page.waitForTimeout(1600);
    }

    if (await this.fillFirstMatchingInput([
      'input[type="password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[autocomplete*="password" i]',
      'input[placeholder*="password" i]',
    ], this.config.password, { preferPassword: true })) {
      const loginResponse = this.page.waitForResponse((response) => (
        /api-console\.layer3\.cloud\/api\/login/i.test(response.url())
        || /\/api\/login/i.test(response.url())
      ), { timeout: 12_000 }).catch(() => null);
      await this.clickLoginButton(/sign in|log in|login|continue|next|submit/i);
      await this.captureLoginResponse(await loginResponse);
      await this.page.waitForTimeout(4000);
      await this.page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      await this.waitForConsoleLoaded();
    }
  }

  async isLoginPage(existingBodyText = '') {
    const url = this.page.url();
    if (/\/login(?:[/?#]|$)|\/sign-?in(?:[/?#]|$)/i.test(url)) return true;

    const hasPassword = await this.hasVisibleMatchingInput([
      'input[type="password"]',
      'input[name*="password" i]',
      'input[id*="password" i]',
      'input[placeholder*="password" i]',
    ]);
    if (!hasPassword) return false;

    const hasEmail = await this.hasVisibleMatchingInput([
      'input[type="email"]',
      'input[name*="email" i]',
      'input[id*="email" i]',
      'input[placeholder*="email" i]',
      'input[type="text"]',
    ]);
    if (!hasEmail) return false;

    const body = existingBodyText || await this.page.locator('body').innerText().catch(() => '');
    return /sign in to layer3|forgot password|don't have an account|enter a valid email|invalid credentials/i.test(body);
  }

  async waitForLoginFormReady() {
    const selector = [
      'input[type="email"]',
      'input[type="password"]',
      'input[name*="email" i]',
      'input[name*="password" i]',
      'input[placeholder*="email" i]',
      'input[placeholder*="password" i]',
      'input[type="text"]',
    ].join(', ');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ready = await this.page.locator(selector).first().waitFor({
        state: 'visible',
        timeout: attempt === 0 ? 18_000 : 25_000,
      }).then(() => true).catch(() => false);
      if (ready) return true;

      const text = await this.page.locator('body').innerText().catch(() => '');
      const inputCount = await this.page.locator('input').count().catch(() => 0);
      if (inputCount > 0 || !/^login\s*$/i.test(text.trim())) break;
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await this.page.waitForTimeout(2500);
    }

    const rendered = await this.page.locator(selector).first().isVisible().catch(() => false);
    if (!rendered) {
      this.lastLoginResult = {
        at: new Date().toISOString(),
        status: null,
        url: this.page.url(),
        body: 'Login form did not render any visible email/password inputs in the server browser.',
      };
      await this.saveLoginResult();
    }
    return rendered;
  }

  async captureLoginResponse(response) {
    if (!response) {
      this.lastLoginResult = {
        at: new Date().toISOString(),
        status: null,
        url: '',
        body: 'No /api/login response was observed after submitting the login form.',
      };
      await this.saveLoginResult();
      return;
    }

    let body = '';
    try {
      body = await response.text();
    } catch (error) {
      body = `Could not read response body: ${error.message}`;
    }

    this.lastLoginResult = {
      at: new Date().toISOString(),
      status: response.status(),
      url: response.url(),
      body: sanitizeText(body).slice(0, 3000),
    };
    await this.saveLoginResult();
  }

  async saveLoginResult() {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });
      await fs.writeFile(
        `${this.config.dataDir}/login-result.json`,
        JSON.stringify(this.lastLoginResult, null, 2),
      );
    } catch (error) {
      this.logger.warn('Could not save login result', { error: error.message });
    }
  }

  async hasVisibleMatchingInput(selectors) {
    for (const selector of selectors) {
      if (await this.page.locator(selector).first().isVisible().catch(() => false)) {
        return true;
      }
    }
    return false;
  }

  async fillFirstMatchingInput(selectors, value, options = {}) {
    for (const selector of selectors) {
      const input = this.page.locator(selector).first();
      if (await input.isVisible().catch(() => false)) {
        await input.fill(value);
        return true;
      }
    }

    return this.page.evaluate(({ inputValue, preferPassword }) => {
      const candidates = [...document.querySelectorAll('input')]
        .filter((input) => {
          const type = (input.getAttribute('type') || 'text').toLowerCase();
          if (['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(type)) return false;
          const box = input.getBoundingClientRect();
          return box.width > 0 && box.height > 0 && !input.disabled && !input.readOnly;
        });
      const password = candidates.find((input) => (input.getAttribute('type') || '').toLowerCase() === 'password');
      const target = password && preferPassword
        ? password
        : candidates.find((input) => (input.getAttribute('type') || '').toLowerCase() !== 'password');
      if (!target) return false;

      target.focus();
      target.value = inputValue;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, { inputValue: value, preferPassword: Boolean(options.preferPassword) }).catch(() => false);
  }

  async clickLoginButton(pattern) {
    const button = this.page.getByRole('button', { name: pattern }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      return;
    }

    const submit = this.page.locator('button[type="submit"], input[type="submit"]').first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click();
      return;
    }

    await this.page.keyboard.press('Enter');
  }

  async saveDebugSnapshot(name) {
    try {
      await fs.mkdir(this.config.dataDir, { recursive: true });
      const text = await this.page.locator('body').innerText().catch(() => '');
      const inputs = await this.page.evaluate(() => [...document.querySelectorAll('input, button')].map((element) => {
        const box = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          name: element.getAttribute('name') || '',
          id: element.getAttribute('id') || '',
          placeholder: element.getAttribute('placeholder') || '',
          autocomplete: element.getAttribute('autocomplete') || '',
          ariaLabel: element.getAttribute('aria-label') || '',
          text: element.textContent?.trim().slice(0, 80) || '',
          visible: box.width > 0 && box.height > 0,
          disabled: Boolean(element.disabled),
          readOnly: Boolean(element.readOnly),
        };
      })).catch(() => []);
      await fs.writeFile(`${this.config.dataDir}/${name}.txt`, [
        `url=${this.page.url()}`,
        `title=${await this.page.title().catch(() => '')}`,
        '',
        sanitizeText(text).slice(0, 4000),
      ].join('\n'));
      await fs.writeFile(`${this.config.dataDir}/${name}-inputs.json`, JSON.stringify(inputs, null, 2));
      await this.page.screenshot({ path: `${this.config.dataDir}/${name}.png`, fullPage: true }).catch(() => {});
    } catch (error) {
      this.logger.warn('Could not save debug snapshot', { error: error.message });
    }
  }

  async readBalance() {
    const text = await this.page.locator('body').innerText();
    const match = text.match(/Infra Credits[\s\S]{0,120}?NGN\s*([\d,.]+)/i)
      || text.match(/NGN\s*([\d,.]+)[\s\S]{0,80}?Infra Credits/i);
    if (!match) throw new Error('Could not read Infra Credits balance from Layer3 console');
    return Number(match[1].replaceAll(',', ''));
  }

  countsFromApi() {
    const rows = this.apiCache.serviceSummary?.data;
    if (!Array.isArray(rows)) return null;
    const byLabel = new Map(rows.map((row) => [String(row.label || '').toLowerCase(), Number(row.value || 0)]));
    return {
      total: byLabel.get('total') || 0,
      running: byLabel.get('running') || 0,
      stopped: byLabel.get('stopped') || 0,
      error: byLabel.get('error') || 0,
    };
  }

  instancesFromApi() {
    const vms = this.apiCache.virtualMachines?.data;
    if (!Array.isArray(vms)) return [];

    const projectsById = new Map();
    const projects = this.apiCache.projects?.data;
    if (Array.isArray(projects)) {
      for (const project of projects) {
        if (project.id) projectsById.set(project.id, project);
      }
    }

    const seen = new Set();
    return vms.flatMap((vm) => {
      const instance = parseApiInstance(vm, projectsById, this.config.consoleOrigin);
      if (!instance || seen.has(instance.name)) return [];
      seen.add(instance.name);
      return [instance];
    });
  }

  currentInstanceFromApi() {
    return this.instancesFromApi().find((instance) => (
      instance.name.toLowerCase() === this.config.instanceName.toLowerCase()
    )) || null;
  }

  async waitForApiInstances() {
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      const instances = this.instancesFromApi();
      if (instances.length > 0) return instances;
      await this.page.waitForTimeout(1000);
    }
    return this.instancesFromApi();
  }

  async listInstances() {
    return this.serial(async () => {
      await this.ensureReady(this.config.instancesUrl);
      await this.page.locator('a[href*="/app/projects/"]').first().waitFor({ state: 'attached', timeout: 4000 }).catch(() => {});
      const body = await this.page.locator('body').innerText();
      const balance = await this.readBalance().catch(() => null);
      const counts = this.countsFromApi() || parseInstanceCounts(body);
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
      const domInstances = links.flatMap((link) => {
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
      const instances = domInstances.length > 0 ? domInstances : await this.waitForApiInstances();
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
    const apiInstance = this.currentInstanceFromApi();
    if (apiInstance) return;

    const body = await this.page.locator('body').innerText().catch(() => '');
    if (!body || /not found|404|does not exist/i.test(body.slice(0, 1000))) {
      throw new Error(`Instance not found: ${this.config.instanceName}`);
    }
  }

  async readInstanceStatus() {
    const apiInstance = this.currentInstanceFromApi();
    if (apiInstance?.status) return apiInstance.status;

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
