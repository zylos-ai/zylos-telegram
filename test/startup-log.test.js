import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Load the real bot entry point with Telegram, HTTP and config replaced, with
// HOME, ZYLOS_DIR and the data directory in a temp dir, and capture what it
// logs once launch succeeds.
const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: () => ({ owner: {}, groups: {} }), saveConfig: vi.fn(() => true),
  getEnv: name => name === 'TELEGRAM_BOT_TOKEN' ? 'fixture-token' : '',
  get DATA_DIR() { return state.dir; },
}));
vi.mock('http', () => ({ default: { createServer: () => ({ on: vi.fn(), listen: vi.fn(), close: vi.fn() }) } }));
vi.mock('telegraf', () => ({ Telegraf: class {
  botInfo = { username: 'fixturebot' };
  telegram = { callApi: async () => ({}) };
  on() {}
  start() {}
  catch() {}
  launch() { return Promise.resolve(); }
  stop() {}
} }));

let log, root, prevEnv;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-startup-'));
  prevEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  state.dir = path.join(root, 'data');
  fs.mkdirSync(state.dir, { recursive: true });
  vi.useFakeTimers();
  vi.spyOn(process, 'once').mockImplementation(() => process);
  log = vi.spyOn(console, 'log');
  await import('../src/bot.js');
  await vi.waitFor(() => expect(log.mock.calls.some(([line]) => String(line).endsWith(' started'))).toBe(true));
});
afterAll(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startup log', () => {
  it('reports the version from package.json', () => {
    const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const started = log.mock.calls.map(([line]) => String(line)).filter(line => line.endsWith(' started'));
    expect(started).toEqual([`[telegram] zylos-telegram v${version} started`]);
  });
});
