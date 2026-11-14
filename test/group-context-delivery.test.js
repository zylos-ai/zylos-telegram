import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({ handlers: {}, signals: {}, deliveries: [], server: null, children: new Set(), photoGate: null }));
vi.mock('node:child_process', async original => {
  const real = await original();
  return { ...real, execFile(...args) {
    const child = real.execFile(...args);
    state.children.add(child);
    child.once('close', () => state.children.delete(child));
    return child;
  } };
});
vi.mock('telegraf', () => ({ Telegraf: class {
  botInfo = { username: 'fixturebot', first_name: 'Fixture' };
  telegram = { callApi: async () => ({}), sendChatAction: async () => ({}), sendMessage: async () => ({}) };
  on(name, handler) { state.handlers[name] = handler; }
  start() {} catch() {} stop() {}
  launch() { return Promise.resolve(); }
} }));
vi.mock('http', () => ({ default: { createServer: handler => {
  state.server = handler;
  return { on() {}, listen() {}, close() {} };
} } }));
vi.mock('../src/lib/user-cache.js', () => ({ resolveUserName: () => 'alice', loadUserCache() {}, startPersistInterval() {}, persistUserCache() {} }));
vi.mock('../src/lib/media.js', () => ({ downloadPhoto: async () => { if (state.photoGate) await state.photoGate; return '/isolated/photo'; }, downloadDocument: async () => '/isolated/file', downloadVoice: async () => { const file = path.join(process.env.HOME, 'voice'); fs.writeFileSync(file, 'fixture'); return file; } }));
vi.mock('../src/lib/c4.js', async original => {
  const real = await original();
  return { ...real, sendToC4(...args) {
    const opts = args[4] || {};
    let settle;
    state.deliveries.push(new Promise(resolve => { settle = resolve; }));
    args[4] = { ...opts, onDone(outcome) { opts.onDone?.(outcome); settle(outcome); } };
    return real.sendToC4(...args);
  } };
});

let root, configFile;
const fixture = new URL('./fixtures/context-receiver.cjs', import.meta.url);
const cfg = mode => ({ owner: { chat_id: '123' }, groupPolicy: 'allowlist',
  groups: { '-101': { mode, historyLimit: 2 } }, features: { download_media: true } });

async function boot() {
  vi.resetModules();
  await import('../src/bot.js');
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-ctx-'));
  vi.stubEnv('HOME', root);
  vi.stubEnv('ZYLOS_DIR', path.join(root, 'zylos'));
  vi.stubEnv('PM2_HOME', path.join(root, 'pm2'));
  vi.stubEnv('TMPDIR', root);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'fixture-token');
  vi.stubEnv('TELEGRAM_PROXY_URL', '');
  const scripts = path.join(root, 'zylos/.claude/skills/comm-bridge/scripts');
  configFile = path.join(root, 'zylos/components/telegram/config.json');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.mkdirSync(path.join(root, 'zylos/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'zylos/bin/transcribe'), '#!/bin/sh\nprintf "fixture transcript"\n', { mode: 0o700 });
  fs.mkdirSync(path.join(root, 'zylos/.zylos'), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify(cfg('mention')));
  setMode('multi');
  fs.copyFileSync(fixture, path.join(scripts, 'c4-receive.js'));
  fs.writeFileSync(path.join(scripts, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(scripts, 'c4-receive-options.json'), JSON.stringify({ options: { '--session-group': {} } }));
  state.deliveries = [];
  state.photoGate = null;
  vi.spyOn(process, 'once').mockImplementation((signal, handler) => { state.signals[signal] = handler; return process; });
  // No tmux, PM2, or database is used. All filesystem and child-process paths are private.
  console.log('isolated instance', { HOME: root, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, receiver: scripts });
  expect(process.env.ZYLOS_DIR.startsWith(root + path.sep)).toBe(true);
  await boot();
});
afterEach(async () => {
  for (const child of state.children) child.kill('SIGKILL');
  await settled();
  state.signals.SIGTERM?.();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
function setMode(mode) { fs.writeFileSync(path.join(root, 'zylos/.zylos/config.json'), JSON.stringify({ session_mode: mode })); }
function ctx(id, { mentioned = false, topic = 9, forum = true } = {}) {
  const text = mentioned ? '@fixturebot help' : `chat ${id}`;
  return { from: { id: 123, username: 'owner' }, chat: { id: -101, type: 'supergroup', is_forum: forum, title: 'Fixture group' },
    message: { message_id: id, message_thread_id: topic, is_topic_message: forum && !!topic,
      text, caption: text, entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [],
      caption_entities: mentioned ? [{ type: 'mention', offset: 0, length: 11 }] : [],
      photo: [{ file_id: 'photo' }], document: { file_id: 'doc', file_name: 'notes.txt' } }, reply: async () => ({}) };
}
async function settled() {
  // The wrapper observes completion of every real child, including overlapping sends.
  for (let index = 0; index < state.deliveries.length; index++) await state.deliveries[index];
}
async function dispatch(id, options, kind = 'text') { await state.handlers[kind](ctx(id, options)); await settled(); }
function received() {
  const file = path.join(root, 'received.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').map(line => { const args = JSON.parse(line); return args[args.indexOf('--content') + 1]; });
}
function outgoing(text = 'approval request') {
  const req = new EventEmitter();
  req.method = 'POST'; req.url = '/internal/record-outgoing';
  req.headers = { 'x-internal-token': crypto.createHash('sha256').update('fixture-token').digest('hex') };
  const res = { headersSent: false, writeHead(code) { expect(code).toBe(200); return this; }, end() {} };
  state.server(req, res);
  req.emit('data', Buffer.from(JSON.stringify({ chatId: -101, threadId: 9, text })));
  req.emit('end');
}

// Integration boundary: real bot handlers, context storage, formatter, C4 sender and
// isolated receiver process. Run when these change; skip for unrelated UI/docs/send policy.
describe('group context delivery', () => {
  it('forwards smart messages once without context or own replies', async () => {
    fs.writeFileSync(configFile, JSON.stringify(cfg('smart')));
    await dispatch(1);
    outgoing();
    await dispatch(2);
    const messages = received();
    expect(messages).toHaveLength(2);
    for (const message of messages) { expect(message).not.toContain('<thread-context>'); expect(message).not.toContain('approval request'); }
    console.log('ACCEPTANCE multi smart', messages);
  });

  it('includes only unforwarded mention-group chatter with an exact overflow count', async () => {
    for (let id = 1; id <= 6; id++) await dispatch(id);
    expect(received()).toHaveLength(0);
    await dispatch(7, { mentioned: true });
    expect(received()[0]).toContain('<thread-context>\n之前还有 4 条未显示\n[alice]: chat 5\n[alice]: chat 6\n</thread-context>');
    outgoing();
    await dispatch(8, { mentioned: true });
    expect(received()[1]).not.toContain('<thread-context>');
    console.log('ACCEPTANCE multi mention', received());
  });

  it.each(['single', 'dual', null])('preserves exact legacy output with mode %j', async mode => {
    setMode(mode);
    await dispatch(1); outgoing();
    await dispatch(2, { mentioned: true });
    expect(received()).toEqual(['[TG GROUP:Fixture group]\n<thread-context>\n[alice]: chat 1\n[fixturebot]: approval request\n</thread-context>\n\n<current-message>\nalice said: @Fixture help\n</current-message>']);
    console.log('ACCEPTANCE legacy', mode, received());
  });

  it.each(['single', 'multi'])('replays a short log before recording an outgoing reply after restart in %s mode', async mode => {
    setMode(mode);
    const historyConfig = cfg('mention');
    historyConfig.groups['-101'].historyLimit = 5;
    fs.writeFileSync(configFile, JSON.stringify(historyConfig));
    await dispatch(1);
    await dispatch(2);
    state.signals.SIGTERM();
    await boot();
    outgoing();
    await dispatch(3, { mentioned: true });
    const { getHistory } = await import('../src/lib/context.js');
    // Short logs keep an erroneously pre-recorded synthetic reply in memory;
    // a full tail can truncate it and hide the replay-before-record regression.
    expect(getHistory('-101:9', 3, historyConfig).map(entry => entry.text))
      .toEqual(['chat 1', 'chat 2', 'approval request']);
    const message = received()[0];
    if (mode === 'single') {
      expect(message).toContain('<thread-context>\n[alice]: chat 1\n[alice]: chat 2\n[fixturebot]: approval request\n</thread-context>');
      expect(message.split('[fixturebot]: approval request')).toHaveLength(2);
    } else {
      expect(message).toContain('<thread-context>\n[alice]: chat 1\n[alice]: chat 2\n</thread-context>');
      expect(message).not.toContain('approval request');
    }
    console.log('ACCEPTANCE short-log restart', mode, message);
  });

  it('replays a full log tail before recording an outgoing reply after restart', async () => {
    setMode('single');
    const historyConfig = cfg('mention');
    historyConfig.groups['-101'].historyLimit = 5;
    fs.writeFileSync(configFile, JSON.stringify(historyConfig));
    for (let id = 1; id <= 9; id++) await dispatch(id);
    state.signals.SIGTERM();
    await boot();
    outgoing();
    await dispatch(11, { mentioned: true });
    await dispatch(12, { mentioned: true });
    const first = received()[0], next = received()[1];
    expect(first).toContain('<thread-context>\n[alice]: chat 6\n[alice]: chat 7\n[alice]: chat 8\n[alice]: chat 9\n[fixturebot]: approval request\n</thread-context>');
    expect(next).toContain('<thread-context>\n[alice]: chat 7\n[alice]: chat 8\n[alice]: chat 9\n[fixturebot]: approval request\n[alice]: @fixturebot help\n</thread-context>');
    for (const message of [first, next]) expect(message.split('[fixturebot]: approval request')).toHaveLength(2);
    console.log('ACCEPTANCE restart', received());
  });

  it('retains multi pending chatter across a bot restart and keeps delivered messages out', async () => {
    await dispatch(1, { mentioned: true });
    for (let id = 2; id <= 5; id++) await dispatch(id);
    state.signals.SIGTERM(); await boot();
    await dispatch(6, { mentioned: true });
    expect(received()[1]).toContain('之前还有 2 条未显示\n[alice]: chat 4\n[alice]: chat 5');
    await dispatch(7, { mentioned: true });
    expect(received()[2]).not.toContain('<thread-context>');
  });

  it.each(['photo', 'document'])('uses the same incremental context for mentioned and smart %s paths', async kind => {
    await dispatch(1);
    await dispatch(2, { mentioned: true }, kind);
    expect(received()[0]).toContain('[alice]: chat 1');
    fs.writeFileSync(configFile, JSON.stringify(cfg('smart')));
    await dispatch(3, {}, kind);
    expect(received()[1]).not.toContain('<thread-context>');
    expect(received()[1]).not.toContain('<group-context>');
  });

  it('uses incremental context for transcribed voice messages', async () => {
    await dispatch(1);
    await dispatch(2, { mentioned: true }, 'voice');
    expect(received()[0]).toContain('[alice]: chat 1');
    expect(received()[0]).toContain('[Voice] fixture transcript');
    await dispatch(3, { mentioned: true }, 'voice');
    expect(received()[1]).not.toContain('<thread-context>');
  });

  it('shares non-forum reply-chain context in the same session while isolating forum topics', async () => {
    await dispatch(1, { forum: false, topic: 30 });
    await dispatch(2, { forum: false, topic: 40, mentioned: true });
    expect(received()[0]).toContain('[alice]: chat 1');
    await dispatch(3, { topic: 10 });
    await dispatch(4, { topic: 9, mentioned: true });
    expect(received()[1]).not.toContain('chat 3');
  });

  it('dispatches overlapping messages immediately without repeating context', async () => {
    fs.writeFileSync(configFile, JSON.stringify(cfg('smart')));
    state.handlers.text(ctx(1)); state.handlers.text(ctx(2)); state.handlers.text(ctx(3));
    await settled();
    expect(received()).toHaveLength(3);
    for (const message of received()) expect(message).not.toContain('<thread-context>');
  });

  it('dispatches the next message while a preceding receiver remains unfinished', async () => {
    fs.writeFileSync(configFile, JSON.stringify(cfg('smart')));
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: true, hold: true }));
    state.handlers.text(ctx(1));
    await vi.waitFor(() => expect(received()).toHaveLength(1));
    expect(state.children.size).toBe(1);
    fs.writeFileSync(path.join(root, 'result.json'), '{"ok":true}');
    state.handlers.text(ctx(2));
    await vi.waitFor(() => expect(received()).toHaveLength(2));
    expect(received()[1]).not.toContain('<thread-context>');
    // Teardown kills/reaps the held private child; no production receiver is used.
  });

  it('keeps later incremental context when mode changes during a media download', async () => {
    setMode('single');
    await dispatch(1);
    let release;
    state.photoGate = new Promise(resolve => { release = resolve; });
    const media = state.handlers.photo(ctx(2, { mentioned: true }));
    try {
      setMode('multi');
    } finally { release(); }
    await media;
    await settled();
    expect(received()[0]).toContain('[alice]: chat 1');
    for (const id of [3, 5]) {
      await dispatch(id);
      await dispatch(id + 1, { mentioned: true });
      expect(received()[(id - 1) / 2]).toContain(`[alice]: chat ${id}`);
    }
    const file = path.join(root, 'zylos/components/telegram/data/context/group-101_t_topic-9.log.json');
    const stored = JSON.parse(fs.readFileSync(file));
    expect(stored.acknowledged).toBe(4);
  });

  it('keeps progress after delayed media is overtaken by a later mention', async () => {
    let release;
    state.photoGate = new Promise(resolve => { release = resolve; });
    const media = state.handlers.photo(ctx(1, { mentioned: true }));
    try {
      await dispatch(2, { mentioned: true });
    } finally { release(); }
    await media;
    await settled();
    expect(received()[1]).not.toContain('<thread-context>');
    for (let id = 3; id <= 8; id++) await dispatch(id);
    await dispatch(9, { mentioned: true });
    expect(received()[2]).toContain('之前还有 4 条未显示\n[alice]: chat 7\n[alice]: chat 8');
  });

  it.each([[[]], [null], [['1']]])('consumes context at dispatch even when the receive outcome has persisted=%j', async persisted => {
    await dispatch(1);
    fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify({ ok: false, error: { code: 'REJECTED', message: 'fixture', persisted } }));
    await dispatch(2, { mentioned: true });
    expect(received()[0]).toContain('[alice]: chat 1');
    fs.writeFileSync(path.join(root, 'result.json'), '{"ok":true}');
    await dispatch(3, { mentioned: true });
    expect(received()[1]).not.toContain('<thread-context>');
  });
});
