import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
process.stdout.write('{"ok":true,"result":{}}\\n200');
`, { mode: 0o755 });
  curlLog = path.join(root, 'curl.jsonl');
  configPath = path.join(root, 'zylos/components/telegram/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
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

function runSend(endpoint, message, configText = JSON.stringify(cfg)) {
  if (configText !== null) fs.writeFileSync(configPath, configText);
  return new Promise(resolve => {
    execFile(process.execPath, [sendScript, endpoint, message], {
      env: { ...process.env, HOME: root, TELEGRAM_BOT_TOKEN: 'fixture-token',
        TELEGRAM_PROXY_URL: '', TG_TEST_CURL_LOG: curlLog,
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` },
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
});
