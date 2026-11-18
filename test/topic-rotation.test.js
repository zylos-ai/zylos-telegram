import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, fork } from 'node:child_process';
import { appendTopics, listTopics } from '../src/lib/topics.js';
vi.mock('../src/lib/config.js', () => ({ saveConfig: vi.fn() }));

let root, data;
const record = (overrides = {}) => ({ chat_id: '-101', topic_id: 9, name: 'Status', state: 'closed',
  updated_at: '2026-11-18T00:00:00Z', actor: null, ...overrides });
const line = value => JSON.stringify(value) + '\n';
const archive = stamp => `topics.jsonl.${stamp}`;
const large = () => { const json = JSON.stringify(record()); return json + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(json) - 1) + '\n'; };
const names = () => fs.readdirSync(data).sort();
const write = (name, value) => fs.writeFileSync(path.join(data, name), value);
const privateEnv = () => ({ ...process.env, HOME: root, ZYLOS_DIR: path.join(root, 'zylos'),
  PM2_HOME: path.join(root, 'pm2'), TMPDIR: root, TELEGRAM_BOT_TOKEN: '', TELEGRAM_PROXY_URL: '' });
beforeEach(() => {
  root = fs.mkdtempSync('/tmp/tg-rot-');
  data = path.join(root, 'data'); fs.mkdirSync(data);
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it('checks the size before append and leaves a below-threshold journal in place', () => {
  const below = large().slice(0, -2) + '\n'; write('topics.jsonl', below);
  appendTopics(root, [record({ topic_id: 10 })]);
  expect(names()).toEqual(['topics.jsonl']);
  expect(fs.readFileSync(path.join(data, 'topics.jsonl'), 'utf8')).toBe(below + line(record({ topic_id: 10 })));
  appendTopics(root, [record({ topic_id: 11 })]);
  expect(names()).toHaveLength(2);
  expect(listTopics(root).topics).toHaveLength(3);
});

it('renames a full journal byte for byte and replays old and new topics', () => {
  const bytes = Buffer.from(large()); write('topics.jsonl', bytes);
  appendTopics(root, [record({ topic_id: 10, state: 'open' })]);
  const rotated = names().find(name => name !== 'topics.jsonl');
  expect(rotated).toMatch(/^topics\.jsonl\.\d{8}T\d{9}Z$/);
  expect(fs.readFileSync(path.join(data, rotated)).equals(bytes)).toBe(true);
  expect(fs.readFileSync(path.join(data, 'topics.jsonl'), 'utf8')).toBe(line(record({ topic_id: 10, state: 'open' })));
  expect(listTopics(root).topics.map(topic => topic.topic_id).sort()).toEqual([10, 9]);
});

it('keeps five files, removes only the oldest and forgets its otherwise unobserved topic', () => {
  const stamps = ['20260101T000000000Z', '20260201T000000000Z', '20260301T000000000Z', '20260401T000000000Z'];
  stamps.forEach((stamp, i) => write(archive(stamp), line(record({ topic_id: i + 1 }))));
  const before = stamps.slice(1).map(stamp => fs.readFileSync(path.join(data, archive(stamp)), 'utf8'));
  write('topics.jsonl', large());
  appendTopics(root, [record({ topic_id: 10, state: 'open' })]);
  expect(names()).toHaveLength(5);
  expect(names()).not.toContain(archive(stamps[0]));
  stamps.slice(1).forEach((stamp, i) => expect(fs.readFileSync(path.join(data, archive(stamp)), 'utf8')).toBe(before[i]));
  for (const state of [undefined, 'open', 'closed']) expect(listTopics(root, '-101', state).topics.some(topic => topic.topic_id === 1)).toBe(false);
});

it('preserves closed state when a later file only renames the topic', () => {
  write(archive('20260101T000000000Z'), line(record()));
  appendTopics(root, [record({ name: 'Renamed', state: null, updated_at: '2026-11-18T00:00:01Z' })]);
  expect(listTopics(root, '-101', 'closed').topics[0]).toMatchObject({ name: 'Renamed', state: 'closed' });
});

it('does not replace a preexisting rotation target in the same millisecond', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T00:00:00.000Z'));
  const existing = archive('20261118T000000000Z');
  const bytes = line(record({ topic_id: 2 })); write(existing, bytes);
  const full = large(); write('topics.jsonl', full);
  appendTopics(root, [record({ topic_id: 10 })]);
  expect(fs.readFileSync(path.join(data, existing), 'utf8')).toBe(bytes);
  expect(fs.readFileSync(path.join(data, archive('20261118T000000001Z')), 'utf8')).toBe(full);
  expect(listTopics(root).topics.map(topic => topic.topic_id).sort()).toEqual([10, 2, 9]);
});

it('does not prune an in-flight reserved target or reuse its name', () => {
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T00:00:00Z'));
  const reserved = archive('20260101T000000000Z');
  write(`${reserved}.reserve`, '');
  write(reserved, line(record({ topic_id: 1 })));
  for (let i = 2; i <= 5; i++) write(archive(`2026010${i}T000000000Z`), line(record({ topic_id: i })));
  write('topics.jsonl', large());
  appendTopics(root, [record({ topic_id: 10 })]);
  expect(fs.readFileSync(path.join(data, reserved), 'utf8')).toBe(line(record({ topic_id: 1 })));
  expect(listTopics(root).topics.some(topic => topic.topic_id === 10)).toBe(true);
  expect(fs.existsSync(path.join(data, `${reserved}.reserve`))).toBe(true);
});

it('reads rotated history without the current file and ignores unrelated names', () => {
  const file = archive('20260101T000000000Z'); write(file, line(record()));
  for (const name of ['topics.jsonl.bak', 'topics.jsonl.2026-01-01', 'other.jsonl.20260101T000000000Z']) write(name, 'broken\n');
  expect(listTopics(root)).not.toHaveProperty('warning');
  expect(listTopics(root).topics).toHaveLength(1);
  fs.appendFileSync(path.join(data, file), 'broken\n');
  expect(() => listTopics(root)).toThrow(`corrupt in data/${file}`);
});

it.each(['renameSync', 'unlinkSync'])('still appends and logs when %s fails', method => {
  write('topics.jsonl', large());
  if (method === 'unlinkSync') {
    for (let i = 1; i <= 4; i++) write(archive(`2026010${i}T000000000Z`), line(record({ topic_id: i })));
  }
  const original = fs[method];
  vi.spyOn(fs, method).mockImplementation((...args) => {
    if (method === 'unlinkSync' && String(args[0]).endsWith('.reserve')) return original(...args);
    throw Object.assign(new Error('storage denied'), { code: 'EACCES' });
  });
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  appendTopics(root, [record({ topic_id: 10 })]);
  expect(listTopics(root).topics.some(topic => topic.topic_id === 10)).toBe(true);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('topic history:'), 'storage denied');
});

// Integration boundary: real independent append writers and filesystem rename.
// Run for journal write/rotation changes; skip unrelated delivery/UI changes.
// Private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; no tmux, database or network involved.
it('retains history and both events from independent simultaneous writers', async () => {
  write('topics.jsonl', large());
  const children = [];
  const env = privateEnv();
  console.log('isolated topic writers', { HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, data });
  try {
    const bounded = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('writer timeout')), 3000); })]); }
      finally { clearTimeout(timer); }
    };
    const exits = [], ready = [];
    for (let i = 0; i < 2; i++) {
      const child = fork(new URL('./helpers/topic-writer.js', import.meta.url), [], { env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      const exited = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)));
      });
      exited.catch(() => {});
      exits.push(exited);
      ready.push(new Promise((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.once('exit', code => reject(new Error(`early exit ${code}`))); }));
    }
    await bounded(Promise.all(ready));
    children.forEach((child, i) => child.send({ directory: root, record: record({ topic_id: 20 + i }), now: Date.parse('2026-11-18T00:00:00Z') }));
    await bounded(Promise.all(exits));
    expect(listTopics(root).topics.map(topic => topic.topic_id).sort()).toEqual([20, 21, 9]);
    expect(names().filter(name => name !== 'topics.jsonl').some(name => fs.statSync(path.join(data, name)).size >= 2 * 1024 * 1024)).toBe(true);
  } finally {
    await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise(resolve => { child.once('exit', resolve); child.kill('SIGKILL'); })));
  }
}, 10000);

// Integration boundary: shipped CLI import triggers rotation; list folds archives.
// Run for CLI/storage changes; skip unrelated delivery/UI changes. No transport,
// tmux or database. Private child environments, bounded synchronous subprocesses.
it('rotates through shipped import CLI and lists archives without a current file', () => {
  const env = privateEnv(), component = path.join(root, 'zylos/components/telegram');
  fs.mkdirSync(path.join(component, 'data'), { recursive: true });
  fs.writeFileSync(path.join(component, 'config.json'), JSON.stringify({ groupPolicy: 'open' }));
  const bytes = large(); fs.writeFileSync(path.join(component, 'data/topics.jsonl'), bytes);
  const seed = path.join(root, 'seed.json'); fs.writeFileSync(seed, JSON.stringify([record({ topic_id: 10 })]));
  console.log('isolated rotation CLI', { HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, component });
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [new URL('../scripts/topics.js', import.meta.url).pathname, ...args], { env, encoding: 'utf8', timeout: 5000 }));
  expect(cli('import', '--file', seed)).toEqual({ imported: 1 });
  expect(cli('list', '--chat', '-101').topics).toHaveLength(2);
  fs.unlinkSync(path.join(component, 'data/topics.jsonl'));
  const result = cli('list', '--state', 'closed');
  expect(result).not.toHaveProperty('warning');
  expect(result.topics).toHaveLength(1);
  expect(result.topics[0].topic_id).toBe(9);
});
