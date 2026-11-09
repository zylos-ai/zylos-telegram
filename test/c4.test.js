import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildC4ReceiveArgs, classifyC4Rejection, GENERIC_REJECT_REPLY, sendToC4, UNCERTAIN_REPLY } from '../src/lib/c4.js';

// execFile passes through to the real one. While spawnFailures > 0 it runs a
// missing executable instead, so Node reports a genuine spawn failure and
// c4-receive never starts. Every call's options are kept.
const spawn = vi.hoisted(() => ({ failures: 0, missing: '', onFail: null, calls: [] }));
vi.mock('node:child_process', async importOriginal => {
  const real = await importOriginal();
  return {
    ...real,
    execFile: (file, args, opts, cb) => {
      spawn.calls.push({ args, opts });
      if (spawn.failures > 0) {
        spawn.failures--;
        if (spawn.onFail) spawn.onFail();
        return real.execFile(spawn.missing, args, opts, cb);
      }
      return real.execFile(file, args, opts, cb);
    },
  };
});

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
  Object.assign(spawn, { failures: 0, missing: path.join(root, 'missing-node'), onFail: null, calls: [] });
  fs.writeFileSync(path.join(scriptsDir, 'c4-receive.js'), `
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const list = JSON.parse(fs.readFileSync(${JSON.stringify(responses)}, 'utf8'));
const r = list.length > 1 ? list.shift() : list[0];
fs.writeFileSync(${JSON.stringify(responses)}, JSON.stringify(list));
if (r.signal) process.kill(process.pid, r.signal);
if (r.options) fs.writeFileSync(${JSON.stringify(path.join(scriptsDir, 'c4-receive-options.json'))}, JSON.stringify({ options: r.options }));
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
  it('separates committed, not stored, and uncertain', () => {
    expect(classifyC4Rejection({ ok: false, error: { persisted: ['D1'] } })).toBe('committed');
    expect(classifyC4Rejection({ ok: false, error: { persisted: [] } })).toBe('not_stored');
    for (const persisted of [null, undefined]) {
      expect(classifyC4Rejection({ ok: false, error: { persisted } })).toBe('uncertain');
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

  it('sends nothing and does not resend when the inbound was already committed', async () => {
    writeOptions(SG);
    script(reject('UNHEALTHY_NOTIFY_FAILED', ['D1'], 'Inbound committed; status notice failed. Do not resend.'));
    const r = await send();
    expect(r.outcome).toBe('committed');
    expect(r.calls).toHaveLength(1);
    // callback fires once with no notice, so the caller clears typing and the reaction
    expect(r.replies).toEqual([null]);
  });

  it('runs c4-receive without a timeout', async () => {
    script({ exit: 0, stdout: '{"ok":true}' });
    await send();
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0].opts.timeout ?? 0).toBe(0);
  });

  it('does not resend when c4-receive is killed after it ran', async () => {
    // the fake records the call (as Core would store it), then dies like a killed process
    writeOptions(SG);
    script({ exit: 0, signal: 'SIGKILL' }, { exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('uncertain');
    expect(r.calls).toHaveLength(1);
    expect(r.replies).toEqual([UNCERTAIN_REPLY]);
  });

  it('does not resend after an unstructured failure', async () => {
    writeOptions(SG);
    script({ exit: 2, stdout: 'crash at /some/path/c4-receive.js' }, { exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('uncertain');
    expect(r.calls).toHaveLength(1);
    expect(r.replies).toEqual([UNCERTAIN_REPLY]);
  });

  it('treats an error without a message as unstructured and does not resend', async () => {
    writeOptions(SG);
    script({ exit: 1, stdout: JSON.stringify({ ok: false, error: { code: 'X' } }) }, { exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('uncertain');
    expect(r.calls).toHaveLength(1);
    expect(r.replies).toEqual([UNCERTAIN_REPLY]);
  });

  it('retries once with the same group when c4-receive never started', async () => {
    writeOptions(SG);
    spawn.failures = 1;
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('sent');
    expect(spawn.calls).toHaveLength(2);
    expect(r.calls).toHaveLength(1);
    expect(spawn.calls[1].args).toEqual(spawn.calls[0].args);
    expect(r.replies).toEqual([]);
  });

  it('gives only the may-not-have-arrived notice when the retry also never started', async () => {
    writeOptions(SG);
    spawn.failures = 2;
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('failed');
    expect(spawn.calls).toHaveLength(2);
    expect(r.calls).toHaveLength(0);
    expect(r.replies).toEqual([UNCERTAIN_REPLY]);
  });

  it('rereads the options file before the retry', async () => {
    // old Core on the first call; Core upgraded between the failed spawn and the retry
    spawn.failures = 1;
    spawn.onFail = () => writeOptions(SG);
    script({ exit: 0, stdout: '{"ok":true}' });
    const r = await send();
    expect(r.outcome).toBe('sent');
    expect(spawn.calls[0].args).not.toContain('--session-group');
    expect(r.calls[0].slice(-2)).toEqual(['--session-group', 'group-100777:topic-9']);
  });

  it.each([[null], [undefined]])(
    'persisted %j: says the message may not have arrived, never Core text', async persisted => {
      script(reject('INTERNAL_ERROR', persisted, 'failed to queue message: SQLITE_BUSY'));
      const r = await send('8101553026|msg:1');
      expect(r.calls).toHaveLength(1);
      expect(r.replies).toEqual([UNCERTAIN_REPLY]);
    });
});
