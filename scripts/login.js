import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const profileDir = path.join(dataDir, 'browser-profile');
const target = process.env.LAYER3_INSTANCES_URL || 'https://console.layer3.cloud/app/virtual-machines';

await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  viewport: { width: 1440, height: 1000 },
});
const page = context.pages()[0] || await context.newPage();
await page.goto(target, { waitUntil: 'domcontentloaded' });

const terminal = readline.createInterface({ input, output });
await terminal.question('请在浏览器中完成 Layer3 登录，看到实例列表后按 Enter 保存会话...');
terminal.close();
await context.close();
console.log(`登录会话已保存到 ${profileDir}`);
