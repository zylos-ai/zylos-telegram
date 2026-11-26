import { describe, expect, it } from 'vitest';
import { curlUrlConfig } from '../src/lib/curl.js';

describe('curlUrlConfig', () => {
  it('escapes backslashes and double quotes in every config value', () => {
    expect(curlUrlConfig('https://x/a\\b"c', 'http://u:p\\w"x@proxy:8080', 'a\\b"c')).toBe([
      String.raw`url = "https://x/a\\b\"c"`,
      String.raw`proxy = "http://u:p\\w\"x@proxy:8080"`,
      String.raw`data-binary = "a\\b\"c"`,
      '',
    ].join('\n'));
  });

  it('rejects line breaks in config values', () => {
    expect(() => curlUrlConfig('https://x/a', '', 'a\nb')).toThrow(/data must not contain line breaks/);
  });
});
