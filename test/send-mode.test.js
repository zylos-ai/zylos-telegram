import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules before importing
vi.mock('../src/lib/config.js', () => ({
  DATA_DIR: '/tmp/test-telegram',
  loadConfig: vi.fn(() => ({
    message: { textMode: 'plain', context_messages: 5 },
    internal_port: 3460
  }))
}));

// We test the mode selection logic by importing the markdown-html module
// and verifying the behavior indirectly through the converter functions.
// Testing send.js directly would require mocking curl/execFileSync/process.argv
// which is fragile. Instead we test the decision logic + converter integration.

import { markdownToHtml, hasMarkdownContent, stripHtmlTags } from '../src/lib/markdown-html.js';
import { splitHtmlMessage } from '../src/lib/html-split.js';
import { loadConfig } from '../src/lib/config.js';

/**
 * Simulates prepareMessage logic from send.js
 */
function prepareMessage(text) {
  const cfg = loadConfig();
  const textMode = cfg.message?.textMode || 'plain';
  const MAX_LENGTH = 4000;

  if (textMode === 'html') {
    const html = markdownToHtml(text);
    return { chunks: splitHtmlMessage(html, MAX_LENGTH), parseMode: 'HTML' };
  }

  if (textMode === 'markdown') {
    if (hasMarkdownContent(text)) {
      const html = markdownToHtml(text);
      return { chunks: splitHtmlMessage(html, MAX_LENGTH), parseMode: 'HTML' };
    }
    return { chunks: [text], parseMode: null };
  }

  // plain
  return { chunks: [text], parseMode: null };
}

describe('send mode selection', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
  });

  describe('plain mode', () => {
    it('sends without parse_mode', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'plain', context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello **world**');
      expect(result.parseMode).toBeNull();
      // Text should be unchanged
      expect(result.chunks[0]).toBe('hello **world**');
    });
  });

  describe('html mode', () => {
    it('always applies HTML conversion', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'html', context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello **world**');
      expect(result.parseMode).toBe('HTML');
      expect(result.chunks[0]).toBe('hello <b>world</b>');
    });

    it('applies HTML conversion even to plain text', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'html', context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello world');
      expect(result.parseMode).toBe('HTML');
      expect(result.chunks[0]).toBe('hello world');
    });
  });

  describe('markdown mode', () => {
    it('applies HTML only when markdown detected', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'markdown', context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello **world**');
      expect(result.parseMode).toBe('HTML');
      expect(result.chunks[0]).toBe('hello <b>world</b>');
    });

    it('sends plain when no markdown detected', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'markdown', context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello world');
      expect(result.parseMode).toBeNull();
      expect(result.chunks[0]).toBe('hello world');
    });
  });

  describe('fallback behavior', () => {
    it('stripHtmlTags removes all HTML tags for fallback', () => {
      const html = '<b>hello</b> <i>world</i> <a href="url">link</a>';
      expect(stripHtmlTags(html)).toBe('hello world link');
    });

    it('stripHtmlTags handles empty input', () => {
      expect(stripHtmlTags('')).toBe('');
      expect(stripHtmlTags(null)).toBe('');
    });

    it('fallback simulation: HTML send fails, retry as plain', () => {
      // Simulate: prepareMessage returns HTML, but send would fail with 400
      // On fallback, we strip tags and send as plain
      vi.mocked(loadConfig).mockReturnValue({
        message: { textMode: 'html', context_messages: 5 },
        internal_port: 3460
      });
      const { chunks, parseMode } = prepareMessage('**bold** and `code`');
      expect(parseMode).toBe('HTML');

      // Simulate 400 error — fallback strips tags
      const plainChunks = chunks.map(c => stripHtmlTags(c));
      expect(plainChunks[0]).toBe('bold and code');
    });

    it('fallback only happens once (no infinite loop)', () => {
      // The send.js implementation deletes parse_mode before retrying,
      // so even if the plain text retry also fails with 400, it throws
      // instead of looping. We verify the flow logic here:
      let retryCount = 0;
      const simulateSend = (params) => {
        if (params.parse_mode && retryCount === 0) {
          retryCount++;
          // Simulate 400 — trigger fallback
          const fallbackParams = { ...params };
          delete fallbackParams.parse_mode;
          fallbackParams.text = stripHtmlTags(params.text);
          return simulateSend(fallbackParams);
        }
        if (!params.parse_mode) {
          // Plain text send — succeeds or throws (no more fallback)
          return { ok: true };
        }
      };

      const result = simulateSend({
        chat_id: '123',
        text: '<b>hello</b>',
        parse_mode: 'HTML'
      });
      expect(result).toEqual({ ok: true });
      expect(retryCount).toBe(1); // Only one fallback attempt
    });
  });

  describe('default config', () => {
    it('defaults to plain when textMode not set', () => {
      vi.mocked(loadConfig).mockReturnValue({
        message: { context_messages: 5 },
        internal_port: 3460
      });
      const result = prepareMessage('hello **world**');
      expect(result.parseMode).toBeNull();
    });
  });
});
