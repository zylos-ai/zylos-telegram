import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Runs the real scripts/send.js in an isolated HOME with a fake `curl` on PATH
// (records its arguments, never reaches Telegram) and a local stand-in for the
// bot's internal record-outgoing endpoint.
const sendScript = fileURLToPath(new URL('../scripts/send.js', import.meta.url));
let root, curlLog, server, records, port;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-send-topic-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.TG_TEST_CURL_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write('{"ok":true,"result":{}}\\n200');
`, { mode: 0o755 });
  curlLog = path.join(root, 'curl.jsonl');
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
  const configPath = path.join(root, 'zylos/components/telegram/config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    owner: { chat_id: '123' }, dmPolicy: 'owner',
    groupPolicy: 'allowlist', groups: { '-100': {} }, internal_port: port,
  }));
});

afterEach(async () => {
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

function runSend(endpoint, message) {
  return new Promise(resolve => {
    execFile(process.execPath, ['--import', path.join(root, 'fetch.mjs'), sendScript, endpoint, message], {
      env: { ...process.env, HOME: root, TELEGRAM_BOT_TOKEN: 'fixture-token',
        TELEGRAM_PROXY_URL: '', TG_TEST_CURL_LOG: curlLog, TG_TEST_PORT: String(port),
        PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}` },
      timeout: 10000,
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });
}

function calls() {
  return fs.existsSync(curlLog)
    ? fs.readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

describe('send.js forum topic routing', () => {
  it.each([
    ['topic only', '-100|topic:162', 162],
    ['thread only', '-100|thread:162', 162],
    ['thread and topic equal', '-100|thread:162|topic:162', 162],
  ])('%s: text goes into the topic', async (_label, endpoint, expected) => {
    const result = await runSend(endpoint, 'hello');
    expect(result.code).toBe(0);
    const transport = calls();
    expect(transport).toHaveLength(1);
    expect(transport[0]).toContain('https://api.telegram.org/botfixture-token/sendMessage');
    expect(JSON.parse(transport[0].at(-1))).toMatchObject({
      chat_id: '-100', text: 'hello', message_thread_id: expected,
    });
    expect(records).toEqual([{ url: '/internal/record-outgoing',
      body: { chatId: '-100', threadId: expected, text: 'hello' } }]);
  });

  it.each(['[MEDIA:image]', '[MEDIA:file]'])('topic only: %s goes into the topic', async prefix => {
    const media = path.join(root, 'sample.txt');
    fs.writeFileSync(media, 'fixture');
    const result = await runSend('-100|topic:162', prefix + media);
    expect(result.code).toBe(0);
    const transport = calls();
    expect(transport).toHaveLength(1);
    expect(transport[0]).toContain('chat_id=-100');
    expect(transport[0]).toContain('message_thread_id=162');
  });

  it('no thread or topic: sends to the chat without a thread id', async () => {
    const result = await runSend('-100', 'hello');
    expect(result.code).toBe(0);
    const body = JSON.parse(calls()[0].at(-1));
    expect(body).toMatchObject({ chat_id: '-100', text: 'hello' });
    expect(body).not.toHaveProperty('message_thread_id');
  });

  it.each([
    ['-100|thread:162|topic:7', 'hello'],
    ['-100|topic:7|thread:162', 'hello'],
    ['-100|thread:162|topic:7', '[SKIP]'],
  ])('thread and topic differ (%s, %s): refused before any API call', async (endpoint, message) => {
    const result = await runSend(endpoint, message);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/thread:\d+ and topic:\d+ disagree; refusing to send/);
    expect(calls()).toEqual([]);
    expect(records).toEqual([]);
  });
});
