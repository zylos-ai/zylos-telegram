import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appendTopics, listTopics, recordTopicMessage, registerTopicHandlers, changeTopicState } from '../src/lib/topics.js';

// Unit imports never load the host's .env; the CLI case loads real config only
// in its explicitly isolated child environment.
vi.mock('../src/lib/config.js', () => ({ saveConfig: vi.fn() }));

let root;
const config = { groupPolicy: 'allowlist', groups: { '-101': { allowFrom: ['123'] } } };
const record = (overrides = {}) => ({ chat_id: '-101', topic_id: 9, name: 'Status', state: 'open',
  updated_at: '2026-11-18T00:00:00Z', actor: { id: 123 }, ...overrides });
const message = (event, value = {}) => ({ chat: { id: -101, type: 'supergroup' },
  message_thread_id: 9, date: 1794960001, from: { id: 456, username: 'admin' }, [event]: value });
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-topic-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it('records create, close, rename and reopen with the service actor and time', () => {
  recordTopicMessage(config, message('forum_topic_created', { name: 'Status' }), root);
  recordTopicMessage(config, message('forum_topic_closed'), root);
  expect(listTopics(root, '-101', 'closed').topics[0]).toMatchObject({ state: 'closed', name: 'Status',
    updated_at: new Date(1794960001000).toISOString(), actor: { id: 456, username: 'admin' } });
  recordTopicMessage(config, message('forum_topic_edited', { name: 'Updates' }), root);
  recordTopicMessage(config, message('forum_topic_reopened'), root);
  expect(listTopics(root, '-101', 'open').topics[0]).toMatchObject({ name: 'Updates', state: 'open' });
  expect(listTopics(root, '-999').topics).toHaveLength(0);
});

it('keeps unknown state and name explicit, including General and anonymous administrators', () => {
  const update = message('forum_topic_edited', { name: 'General' });
  delete update.message_thread_id;
  update.sender_chat = { id: -101, title: 'Anonymous admin' };
  recordTopicMessage(config, update, root);
  expect(listTopics(root).topics[0]).toMatchObject({ topic_id: 1, state: null, actor: update.sender_chat });
  recordTopicMessage(config, message('forum_topic_closed'), root);
  expect(listTopics(root).topics.find(topic => topic.topic_id === 9).name).toBeNull();
});

it('applies group policies without using conversational sender restrictions', () => {
  expect(recordTopicMessage(config, message('forum_topic_closed'), root)).toBe(true);
  for (const denied of [{ groupPolicy: 'disabled', groups: config.groups }, { groupPolicy: 'allowlist', groups: {} }]) {
    const separate = path.join(root, denied.groupPolicy);
    recordTopicMessage(denied, message('forum_topic_closed'), separate);
    expect(listTopics(separate).topics).toHaveLength(0);
  }
  recordTopicMessage({ groupPolicy: 'open' }, message('forum_topic_reopened'), root);
  expect(listTopics(root).topics[0].state).toBe('open');
  expect(recordTopicMessage(config, { text: 'hello' }, root)).toBe(false);
});

it('merges imports and delayed observations by event time without losing known fields', () => {
  appendTopics(root, [record({ state: 'closed', name: null, updated_at: '2026-11-18T00:00:02Z' })]);
  appendTopics(root, [record(), record({ topic_id: 10 })]);
  expect(listTopics(root).topics).toHaveLength(2);
  expect(listTopics(root).topics[0]).toMatchObject({ name: 'Status', state: 'closed' });
  expect(() => appendTopics(root, [record({ topic_id: 11 }), record({ state: 'invalid' })])).toThrow('Invalid topic record');
  expect(listTopics(root).topics).toHaveLength(2);
});

it('reports missing and corrupt history without reading it on handler registration', () => {
  expect(listTopics(root).warning).toContain('missing');
  appendTopics(root, [record()]);
  fs.appendFileSync(path.join(root, 'data/topics.jsonl'), '{broken\n');
  expect(() => listTopics(root)).toThrow('corrupt');
  const handlers = {};
  registerTopicHandlers({ on: (name, handler) => { handlers[name] = handler; } }, () => config, root);
  expect(() => handlers.forum_topic_closed({ message: message('forum_topic_closed') })).not.toThrow();
});

it('contains persistence errors within the service handler', () => {
  fs.writeFileSync(path.join(root, 'data'), 'not a directory');
  const handlers = {}, error = vi.fn();
  registerTopicHandlers({ on: (name, handler) => { handlers[name] = handler; } }, () => config, root, error);
  expect(() => handlers.forum_topic_closed({ message: message('forum_topic_closed') })).not.toThrow();
  expect(error).toHaveBeenCalledOnce();
});

it.each(['close', 'reopen'])('records successful bot %s calls and preserves the known name', async action => {
  appendTopics(root, [record({ updated_at: '2000-01-01T00:00:00Z' })]);
  const telegram = { getMe: vi.fn(async () => ({ id: 999, is_bot: true })), callApi: vi.fn(async () => true) };
  await changeTopicState(config, telegram, root, '-101', 9, action);
  expect(telegram.callApi).toHaveBeenCalledWith(action === 'close' ? 'closeForumTopic' : 'reopenForumTopic', { chat_id: '-101', message_thread_id: 9 });
  expect(listTopics(root).topics[0]).toMatchObject({ name: 'Status', state: action === 'close' ? 'closed' : 'open', actor: { id: 999 } });
  await changeTopicState(config, telegram, root, '-101', 1, action);
  expect(telegram.callApi).toHaveBeenLastCalledWith(action === 'close' ? 'closeGeneralForumTopic' : 'reopenGeneralForumTopic', { chat_id: '-101' });
});

it('does not record failed or denied API calls and distinguishes persistence failure after success', async () => {
  const telegram = { getMe: vi.fn(async () => ({ id: 999 })), callApi: vi.fn(async () => { throw new Error('denied'); }) };
  await expect(changeTopicState(config, telegram, root, '-101', 9, 'close')).rejects.toThrow('denied');
  expect(listTopics(root).topics).toHaveLength(0);
  telegram.callApi.mockClear();
  await expect(changeTopicState(config, telegram, root, '-999', 9, 'close')).rejects.toThrow('not allowed');
  expect(telegram.callApi).not.toHaveBeenCalled();
  telegram.callApi.mockResolvedValue(true);
  fs.writeFileSync(path.join(root, 'data'), 'not a directory');
  await expect(changeTopicState(config, telegram, root, '-101', 9, 'close')).rejects.toThrow('operation succeeded');
});

it('lets a later service reopen in the same Telegram second supersede the command record', async () => {
  const telegram = { getMe: async () => ({ id: 999 }), callApi: async () => true };
  const closed = await changeTopicState(config, telegram, root, '-101', 9, 'close');
  recordTopicMessage(config, { ...message('forum_topic_reopened'), date: Math.floor(Date.parse(closed.updated_at) / 1000) }, root);
  expect(listTopics(root).topics[0]).toMatchObject({ state: 'open', actor: { id: 456 } });
});

// Integration boundary: shipped CLI, config and journal in private HOME. Run
// when topics CLI/import/storage changes; skip unrelated delivery/UI changes.
// No Telegram transport, tmux, PM2 or database is used. Child timeout is bounded.
it('runs JSON list/import CLI against isolated component data', () => {
  const env = { ...process.env, HOME: root, ZYLOS_DIR: path.join(root, 'zylos'), PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    TELEGRAM_BOT_TOKEN: '', TELEGRAM_PROXY_URL: '' };
  const dataDir = path.join(env.ZYLOS_DIR, 'components/telegram');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(config));
  console.log('isolated topics CLI', { HOME: env.HOME, ZYLOS_DIR: env.ZYLOS_DIR, PM2_HOME: env.PM2_HOME, TMPDIR: env.TMPDIR, dataDir });
  const cli = (...args) => JSON.parse(execFileSync(process.execPath, [new URL('../scripts/topics.js', import.meta.url).pathname, ...args], { env, encoding: 'utf8', timeout: 5000 }));
  expect(cli('list', '--chat', '-101').warning).toContain('missing');
  const seed = path.join(root, 'seed.json');
  fs.writeFileSync(seed, JSON.stringify([record()]));
  expect(cli('import', '--file', seed)).toEqual({ imported: 1 });
  expect(cli('list', '--chat', '-101', '--state', 'open').topics[0].name).toBe('Status');
  fs.appendFileSync(path.join(dataDir, 'data/topics.jsonl'), 'bad\n');
  expect(() => cli('list')).toThrow();
});
