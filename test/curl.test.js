import { describe, expect, it } from 'vitest';
import { curlUrlConfig } from '../src/lib/curl.js';

describe('curlUrlConfig', () => {
  it('quotes the URL as a curl config line', () => {
    expect(curlUrlConfig('https://api.telegram.org/bot123:abc/getMe'))
      .toBe('url = "https://api.telegram.org/bot123:abc/getMe"\n');
  });

  it('escapes backslash and double quote', () => {
    expect(curlUrlConfig('https://x/a\\b"c')).toBe('url = "https://x/a\\\\b\\"c"\n');
  });

  it('rejects line breaks so no extra config option can be injected', () => {
    expect(() => curlUrlConfig('https://x/a\noutput = /tmp/x')).toThrow(/line breaks/);
  });
});
