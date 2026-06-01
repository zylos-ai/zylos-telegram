import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use a per-test HOME dir so the members.json cache file is isolated. The
// module reads HOME at import time, so we set it BEFORE importing.
const TEST_HOME = path.join(os.tmpdir(), `zylos-members-test-${Date.now()}-${process.pid}`);
process.env.HOME = TEST_HOME;
fs.mkdirSync(path.join(TEST_HOME, 'zylos/components/telegram'), { recursive: true });

const CACHE_PATH = path.join(TEST_HOME, 'zylos/components/telegram/members.json');

// Dynamic import so the module picks up our HOME override
const { recordMember, resolveUsername, listMembers, flushNow } =
  await import('../src/lib/members.js');

function clearCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

describe('members cache', () => {
  beforeEach(() => {
    clearCache();
  });

  afterEach(() => {
    flushNow();
    clearCache();
  });

  it('starts empty when no file exists', () => {
    expect(listMembers()).toEqual({});
  });

  it('records username → id from a context', () => {
    recordMember({ from: { id: 123, username: 'felix' } });
    expect(resolveUsername('@felix')).toBe('123');
    expect(resolveUsername('felix')).toBe('123');
    expect(resolveUsername('@FELIX')).toBe('123');  // case-insensitive
  });

  it('returns null for unknown usernames', () => {
    expect(resolveUsername('@nobody')).toBeNull();
    expect(resolveUsername('')).toBeNull();
    expect(resolveUsername(undefined)).toBeNull();
  });

  it('skips users without a username', () => {
    // Capture cache state, then call recordMember with no username — count
    // must stay the same (order-independent across earlier tests that may
    // have populated the singleton cache).
    const before = Object.keys(listMembers()).length;
    recordMember({ from: { id: 999 } });
    recordMember({ from: { id: 999, username: '' } });
    recordMember({ from: { id: 999, username: null } });
    expect(Object.keys(listMembers()).length).toBe(before);
  });

  it('overwrites on takeover: user B claims @felix after user A renames', () => {
    // A is @felix (id 100)
    recordMember({ from: { id: 100, username: 'felix' } });
    expect(resolveUsername('@felix')).toBe('100');

    // A renames to @felixnew, A speaks
    recordMember({ from: { id: 100, username: 'felixnew' } });
    expect(resolveUsername('@felixnew')).toBe('100');
    // Stale: cache.felix still 100 until B speaks
    expect(resolveUsername('@felix')).toBe('100');

    // B (id 200) now uses @felix, B speaks
    recordMember({ from: { id: 200, username: 'felix' } });
    expect(resolveUsername('@felix')).toBe('200');     // overwritten — correct
    expect(resolveUsername('@felixnew')).toBe('100');  // A still findable by new name
  });

  it('flushes to disk after debounce window', async () => {
    recordMember({ from: { id: 42, username: 'alice' } });
    flushNow();
    expect(fs.existsSync(CACHE_PATH)).toBe(true);
    const onDisk = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    expect(onDisk.alice).toBe('42');
  });

  it('does not write when the mapping is unchanged', () => {
    recordMember({ from: { id: 7, username: 'bob' } });
    flushNow();
    const mtime1 = fs.statSync(CACHE_PATH).mtimeMs;
    // Same call → should be a no-op (no dirty flag, no flush)
    recordMember({ from: { id: 7, username: 'bob' } });
    flushNow();
    const mtime2 = fs.statSync(CACHE_PATH).mtimeMs;
    expect(mtime2).toBe(mtime1);
  });

  it('strips @ prefix and lowercases the lookup key', () => {
    recordMember({ from: { id: 11, username: 'MixedCase' } });
    expect(resolveUsername('@MixedCase')).toBe('11');
    expect(resolveUsername('@mixedcase')).toBe('11');
    expect(resolveUsername('mixedcase')).toBe('11');
  });
});
