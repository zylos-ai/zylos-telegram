import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endpointFromCtx } from '../src/lib/endpoint.js';

const sendScript = fileURLToPath(new URL('../scripts/send.js', import.meta.url));
let root, configPath, curlLog, server, records, cfg, port;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-send-policy-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.TG_TEST_CURL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
const jsonIndex = process.argv.indexOf('-d');
const hasReply = jsonIndex >= 0 && JSON.parse(process.argv[jsonIndex + 1]).reply_to_message_id;
if ((process.env.TG_TEST_REPLY_400 === '1' || (process.env.TG_TEST_REPLY_400 === 'with-reply' && hasReply)) &&
    process.argv.some(a => /\\/send(Message|Photo|Document)$/.test(a))) {
  process.stdout.write('{"ok":false,"error_code":400,"description":"reply message not found"}\\n400');
  process.exit(0);
}
process.stdout.write('{"ok":true,"result":{}}\\n200');
`, { mode: 0o755 });
  curlLog = path.join(root, 'curl.jsonl');
  configPath = path.join(root, 'zylos/components/telegram/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(path.join(root, 'fetch.mjs'), `
const realFetch = globalThis.fetch;
globalThis.fetch = (url, options) => {
  const local = new URL(url);
  local.hostname = '127.0.0.1';
  local.port = process.env.TG_TEST_PORT;
  return realFetch(local, options);
};
`);
  records = [];
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      records.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  cfg = { owner: { chat_id: '123' }, dmPolicy: 'allowlist', dmAllowFrom: ['456'],
    groupPolicy: 'allowlist', groups: { '-100': {} }, internal_port: port };
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

function runSend(endpoint, message, configText = JSON.stringify(cfg), env = {}) {
  if (configText !== null) fs.writeFileSync(configPath, configText);
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', path.join(root, 'fetch.mjs'), sendScript, endpoint, message], {
      env: { ...process.env, HOME: root, TELEGRAM_BOT_TOKEN: 'fixture-token',
        TELEGRAM_PROXY_URL: '', TG_TEST_CURL_LOG: curlLog, TG_TEST_PORT: String(port),
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, ...env },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function calls() {
  return fs.existsSync(curlLog)
    ? fs.readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

describe('real send CLI policy boundary with fake Telegram transport', () => {
  it.each(['text', '[MEDIA:image]', '[MEDIA:file]', '[SKIP]'])(
    'blocks unauthorized %s before API, attachment access, or outgoing history', async message => {
      const result = await runSend('457|msg:7|req:test', message);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain('OUTBOUND_DM_DENIED: dmPolicy=allowlist');
      expect(result.stdout).not.toContain('Message sent');
      expect(calls()).toEqual([]);
      expect(records).toEqual([]);
    });

  it.each([
    ['-101', 'allowlist'], ['-100', 'disabled'],
  ])('blocks group %s with policy %s, including reaction cleanup', async (endpoint, policy) => {
    cfg.groupPolicy = policy;
    const result = await runSend(`${endpoint}|msg:7|thread:9`, 'hello');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`OUTBOUND_GROUP_DENIED: groupPolicy=${policy}`);
    expect(calls()).toEqual([]);
    expect(records).toEqual([]);
  });

  it.each(['@publicchannel', '0', '+123', '0123', '123 '])('rejects invalid destination %s under open policy', async endpoint => {
    cfg.dmPolicy = cfg.groupPolicy = 'open';
    const result = await runSend(endpoint, 'hello');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OUTBOUND_INVALID_CHAT_ID');
    expect(calls()).toEqual([]);
    expect(records).toEqual([]);
  });

  it.each([null, '{broken'])('fails closed with missing or malformed config %s', async configText => {
    const result = await runSend('123', 'hello', configText);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('OUTBOUND_DM_DENIED');
    expect(calls()).toEqual([]);
    expect(records).toEqual([]);
  });

  it.each(['123', '456', '-100'])('allows configured destination %s', async endpoint => {
    const result = await runSend(endpoint, 'hello');
    expect(result.code).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain('https://api.telegram.org/botfixture-token/sendMessage');
    expect(JSON.parse(calls()[0].at(-1))).toMatchObject({ chat_id: endpoint, text: 'hello' });
    expect(records).toEqual([{ url: '/internal/record-outgoing', body: { chatId: endpoint, threadId: null, text: 'hello' } }]);
  });

  it.each(['[MEDIA:image]', '[MEDIA:file]'])('applies the same gate to allowed media %s', async prefix => {
    const media = path.join(root, 'sample.txt');
    fs.writeFileSync(media, 'fixture');
    const result = await runSend('-100|msg:7|thread:9', prefix + media);
    expect(result.code).toBe(0);
    const transport = calls();
    expect(transport).toHaveLength(2);
    expect(transport[0]).toContain('https://api.telegram.org/botfixture-token/setMessageReaction');
    expect(transport[1]).toContain(`https://api.telegram.org/botfixture-token/${prefix === '[MEDIA:image]' ? 'sendPhoto' : 'sendDocument'}`);
    expect(transport[1]).toContain('chat_id=-100');
    expect(transport[1]).toContain('message_thread_id=9');
    expect(records).toHaveLength(1);
  });

  it('keeps thread/reply routing for allowed text', async () => {
    const result = await runSend('-100|msg:7|thread:9', 'hello');
    expect(result.code).toBe(0);
    expect(calls()).toHaveLength(2);
    expect(JSON.parse(calls()[1].at(-1))).toMatchObject({ chat_id: '-100', message_thread_id: 9, reply_to_message_id: 7 });
  });

  it('keeps allowed SKIP cleanup without sending or recording content', async () => {
    const result = await runSend('123|msg:7|req:test', '[SKIP]');
    expect(result.code).toBe(0);
    expect(calls()).toHaveLength(1);
    expect(calls()[0]).toContain('https://api.telegram.org/botfixture-token/setMessageReaction');
    expect(records).toEqual([]);
    expect(fs.existsSync(path.join(root, 'zylos/components/telegram/typing/test.done'))).toBe(true);
  });

  function replyEndpoint({ dm = false, thread = dm ? undefined : 9, username = 'alice' } = {}) {
    const ctx = { from: { id: dm ? 789 : 123, username: dm ? 'alice' : undefined },
      chat: { id: dm ? 789 : -101, type: dm ? 'private' : 'supergroup' },
      message: { message_id: 7, message_thread_id: thread } };
    const logs = path.join(path.dirname(configPath), 'logs');
    fs.mkdirSync(logs, { recursive: true });
    fs.writeFileSync(path.join(logs, `${ctx.chat.id}${thread ? `_t_${thread}` : ''}.log`), JSON.stringify({
      message_id: 7, user_id: ctx.from.id, username: dm ? username : null, thread_id: thread || null,
      timestamp: '2020-01-01T00:00:00Z',
    }) + '\n');
    return endpointFromCtx(ctx);
  }

  function ownerDm() {
    const ctx = { from: { id: 123 }, chat: { id: 123, type: 'private' }, message: { message_id: 7 } };
    return endpointFromCtx(ctx);
  }

  it('keeps normal chunk routing for an owner DM without log proof', async () => {
    const endpoint = ownerDm();
    expect((await runSend(endpoint, 'x'.repeat(4100))).code).toBe(0);
    const sends = calls().filter(args => args.some(a => a.endsWith('/sendMessage')));
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[0].at(-1))).toMatchObject({ chat_id: '123', reply_to_message_id: 7 });
    expect(JSON.parse(sends[1].at(-1))).toMatchObject({ chat_id: '123' });
    expect(JSON.parse(sends[1].at(-1))).not.toHaveProperty('reply_to_message_id');
  });

  it('keeps normal 400 reply fallback for an owner DM without log proof', async () => {
    const endpoint = ownerDm();
    const result = await runSend(endpoint, 'hello', JSON.stringify(cfg), { TG_TEST_REPLY_400: 'with-reply' });
    expect(result.code).toBe(0);
    const sends = calls().filter(args => args.some(a => a.endsWith('/sendMessage')));
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[0].at(-1))).toMatchObject({ chat_id: '123', reply_to_message_id: 7 });
    expect(JSON.parse(sends[1].at(-1))).toMatchObject({ chat_id: '123', text: 'hello' });
    expect(JSON.parse(sends[1].at(-1))).not.toHaveProperty('reply_to_message_id');
    expect(records).toHaveLength(1);
  });

  it('replies to the owner in an unlisted group, binding every chunk to the trigger', async () => {
    const result = await runSend(replyEndpoint(), 'x'.repeat(4100));
    expect(result.code).toBe(0);
    const sends = calls().filter(args => args.some(a => a.endsWith('/sendMessage')));
    expect(sends).toHaveLength(2);
    for (const args of sends) expect(JSON.parse(args.at(-1))).toMatchObject({ chat_id: '-101', reply_to_message_id: 7, message_thread_id: 9 });
    expect(cfg.groups['-101']).toBeUndefined();
  });

  it('replies to an accepted username-only DM without opening proactive access', async () => {
    cfg.dmAllowFrom.push('@alice');
    expect((await runSend(replyEndpoint({ dm: true }), 'reply')).code).toBe(0);
    const before = calls().length;
    expect((await runSend('789', 'proactive')).code).toBe(1);
    expect(calls()).toHaveLength(before);
  });

  it.each(['[SKIP]', '[MEDIA:image]', '[MEDIA:file]'])('allows log-proven reply %s', async prefix => {
    const file = path.join(root, 'reply.txt');
    fs.writeFileSync(file, 'fixture');
    const result = await runSend(replyEndpoint(), prefix === '[SKIP]' ? prefix : prefix + file);
    expect(result.code).toBe(0);
    if (prefix === '[SKIP]') {
      expect(calls()).toHaveLength(1);
      expect(records).toEqual([]);
    } else {
      expect(calls().at(-1)).toContain('reply_to_message_id=7');
      expect(calls().at(-1)).toContain('chat_id=-101');
    }
  });

  it.each(['text', '[MEDIA:image]', '[MEDIA:file]'])('never drops reply routing after a 400 for %s', async prefix => {
    const file = path.join(root, 'reply.txt');
    fs.writeFileSync(file, 'fixture');
    const result = await runSend(replyEndpoint(), prefix === 'text' ? 'hello' : prefix + file,
      JSON.stringify(cfg), { TG_TEST_REPLY_400: '1' });
    expect(result.code).toBe(1);
    expect(calls()).toHaveLength(2); // reaction cleanup, then exactly one send attempt
    expect(records).toEqual([]);
  });

  it.each(['changed-target', 'changed-message', 'changed-thread', 'disabled', 'owner-changed', 'missing-log'])(
    'rejects %s reply proof before transport or history', async kind => {
      let endpoint = replyEndpoint();
      if (kind === 'changed-target') endpoint = endpoint.replace('-101|', '-102|');
      if (kind === 'changed-message') endpoint = endpoint.replace('msg:7', 'msg:8');
      if (kind === 'disabled') cfg.groupPolicy = 'disabled';
      if (kind === 'owner-changed') cfg.owner.chat_id = '999';
      if (kind === 'changed-thread') endpoint = endpoint.replace('thread:9', 'thread:10');
      if (kind === 'missing-log') fs.unlinkSync(path.join(path.dirname(configPath), 'logs/-101_t_9.log'));
      expect((await runSend(endpoint, 'reply')).code).toBe(1);
      expect(calls()).toEqual([]);
      expect(records).toEqual([]);
    });

  it('keeps topic routing for a username-only DM and rechecks its allowlist', async () => {
    cfg.dmAllowFrom.push('@alice');
    const endpoint = replyEndpoint({ dm: true, thread: 42 });
    expect((await runSend(endpoint, 'reply')).code).toBe(0);
    const sends = calls().filter(args => args.some(a => a.endsWith('/sendMessage')));
    expect(JSON.parse(sends[0].at(-1))).toMatchObject({ chat_id: '789', message_thread_id: 42, reply_to_message_id: 7 });
    cfg.dmAllowFrom = [];
    const before = calls().length;
    expect((await runSend(endpoint, 'revoked')).code).toBe(1);
    expect(calls()).toHaveLength(before);
  });

  it('permits old queued msg-only endpoints while their log proof still exists', async () => {
    replyEndpoint();
    expect((await runSend('-101|msg:7|thread:9', 'old reply')).code).toBe(0);
  });

  it('preserves owner and configured-group inbound fallback for miscased policies', async () => {
    cfg.dmPolicy = 'Owner';
    cfg.groupPolicy = 'Allowlist';
    expect((await runSend('123', 'owner proactive')).code).toBe(0);
    expect((await runSend('-100', 'allowed group')).code).toBe(0);
    expect(records).toHaveLength(2);
  });
});
