import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildC4ReceiveArgs, classifyC4Rejection, GENERIC_REJECT_REPLY, sendToC4 } from '../src/lib/c4.js';

// Isolated deployment: temp HOME and ZYLOS_DIR with a fake c4-receive.js that
// records its argv and replays scripted responses.
let root, prevEnv, scriptsDir, calls, responses;
const SG = { '--session-group': { takesValue: true } };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-c4-'));
  prevEnv = { HOME: process.env.HOME, ZYLOS_DIR: process.env.ZYLOS_DIR };
  process.env.HOME = path.join(root, 'home');
  process.env.ZYLOS_DIR = path.join(root, 'zylos');
  scriptsDir = path.join(process.env.ZYLOS_DIR, '.claude/skills/comm-bridge/scripts');
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  calls = path.join(root, 'calls.jsonl');
  responses = path.join(root, 'responses.json');
  fs.writeFileSync(path.join(scriptsDir, 'c4-receive.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const list = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
const r = list.length > 1 ? list.shift() : list[0];
fs.writeFileSync(${JSON.stringify(responses)}, JSON.stringify(list));
if (r.stdout) process.stdout.write(r.stdout);
process.exit(r.exit);
`);
  fs.writeFileSync(path.join(scriptsDir, 'package.json'), '{"type":"commonjs"}');
});

afterEach(() => {
  for (const [k, v] of Object.entries(prevEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(root, { recursive: true, force: true });
});

const writeOptions = options => fs.writeFileSync(path.join(scriptsDir, 'c4-receive-options.json'), JSON.stringify({ options }));
const script = (...list) => fs.writeFileSync(responses, JSON.stringify(list));
const recorded = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : [];
const reject = (code, persisted, message = 'Core text meant for the agent') =>
  ({ exit: 1, stdout: JSON.stringify({ ok: false, error: { code, message, persisted } }) });

function send(endpoint = '-100777|msg:5|thread:9|topic:9') {
  const replies = [];
  return new Promise(resolve => {
    sendToC4('telegram', endpoint, 'hello', m => replies.push(m),
      { retryDelayMs: 10, onDone: outcome => resolve({ outcome, replies, calls: recorded() }) });
  });
}

describe('c4-receive argument construction', () => {
  it('passes --session-group only when the installed Core lists it', () => {
    const base = { source: 'telegram', endpoint: '1', content: 'x', sessionGroup: 'dm-1' };
    expect(buildC4ReceiveArgs(base)).not.toContain('--session-group'); // no manifest (old Core)
    writeOptions({ '--channel': { takesValue: true } });
    expect(buildC4ReceiveArgs(base)).not.toContain('--session-group');
    writeOptions(SG);
    expect(buildC4ReceiveArgs(base).slice(-2)).toEqual(['--session-group', 'dm-1']);
  });
});

describe('rejection classification', () => {
  it('treats only a non-empty persisted list as committed', () => {
    expect(classifyC4Rejection({ ok: false, error: { persisted: ['D1'] } })).toBe('committed');
    for (const persisted of [[], null, undefined]) {
      expect(classifyC4Rejection({ ok: false, error: { persisted } })).toBe('rejected');
    }
  });
});

describe('sendToC4', () => {
  it('sends the derived topic group on a new Core', async () => {
    writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].slice(-2)).toEqual(['--session-group', 'group-100777:topic-9']);
  });

  it('omits the group on an old Core', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.calls[0]).not.toContain('--session-group');
  });

  it.each(['SESSION_GROUP_INVALID', 'SESSION_GROUP_TOO_LONG'])(
    '%s: generic reply, no resend without the group', async code => {
      writeOptions(SG);
      script(reject(code, []));
      const r = await send();
      expect(r.outcome).toBe('rejected');
      expect(r.calls).toHaveLength(1);
      expect(r.replies).toEqual([GENERIC_REJECT_REPLY]);
    });

  it('stays silent and does not resend when the inbound was already committed', async () => {
    writeOptions(SG);
    script(reject('UNHEALTHY_NOTIFY_FAILED', ['D1'], 'Inbound committed; status notice failed. Do not resend.'));
    const r = await send();
    expect(r.outcome).toBe('committed');
    expect(r.calls).toHaveLength(1);
    expect(r.replies).toEqual([]);
  });

  it('never forwards Core error text to the user (old Core without persisted)', async () => {
    script(reject('INTERNAL_ERROR', undefined, 'failed to queue message: SQLITE_BUSY'));
    const r = await send('8101553026|msg:1');
    expect(r.replies).toEqual([GENERIC_REJECT_REPLY]);
  });

  it('retries an unstructured failure once with the same group', async () => {
    writeOptions(SG);
    script({ exit: 2, stdout: 'crash' }, { exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('sent');
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toEqual(r.calls[0]);
  });
});
