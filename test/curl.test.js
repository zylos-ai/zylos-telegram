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

  it('adds a quoted proxy line when a proxy is given', () => {
    expect(curlUrlConfig('https://x/a', 'http://u:p"w@proxy:8080'))
      .toBe('url = "https://x/a"\nproxy = "http://u:p\\"w@proxy:8080"\n');
  });

  it('omits the proxy line when no proxy is given', () => {
    expect(curlUrlConfig('https://x/a', '')).toBe('url = "https://x/a"\n');
  });

  it('rejects line breaks in the proxy', () => {
    expect(() => curlUrlConfig('https://x/a', 'http://p\noutput = /tmp/x')).toThrow(/proxy must not contain line breaks/);
  });
});
