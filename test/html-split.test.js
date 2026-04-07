import { describe, it, expect } from 'vitest';
import { splitHtmlMessage } from '../src/lib/html-split.js';

describe('splitHtmlMessage', () => {
  it('returns short message as-is (no split needed)', () => {
    const msg = 'Hello, world!';
    expect(splitHtmlMessage(msg, 100)).toEqual([msg]);
  });

  it('returns single-element array for empty input', () => {
    expect(splitHtmlMessage('', 100)).toEqual(['']);
  });

  it('splits long plain text at paragraph boundary', () => {
    const para1 = 'A'.repeat(50);
    const para2 = 'B'.repeat(50);
    const msg = `${para1}\n\n${para2}`;
    const chunks = splitHtmlMessage(msg, 80);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toContain('A');
    expect(chunks[1]).toContain('B');
  });

  it('splits at line break when no paragraph break available', () => {
    const line1 = 'A'.repeat(50);
    const line2 = 'B'.repeat(50);
    const msg = `${line1}\n${line2}`;
    const chunks = splitHtmlMessage(msg, 80);
    expect(chunks.length).toBe(2);
  });

  it('closes and reopens HTML tags across split boundaries', () => {
    const longContent = 'X'.repeat(80);
    const msg = `<b>${longContent}</b>`;
    const chunks = splitHtmlMessage(msg, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close the <b> tag
    expect(chunks[0]).toContain('</b>');
    // Second chunk should reopen the <b> tag
    expect(chunks[1]).toMatch(/^<b>/);
  });

  it('handles nested tags across split boundaries', () => {
    const longContent = 'X'.repeat(80);
    const msg = `<b><i>${longContent}</i></b>`;
    const chunks = splitHtmlMessage(msg, 60);
    expect(chunks.length).toBeGreaterThan(1);
    // First chunk should close both tags (inner first)
    expect(chunks[0]).toContain('</i></b>');
    // Second chunk should reopen both tags (outer first)
    expect(chunks[1]).toMatch(/^<b><i>/);
  });

  it('never splits inside an HTML tag definition', () => {
    // Create a message where the max length falls inside a tag
    const prefix = 'X'.repeat(40);
    const msg = `${prefix}<a href="https://example.com/very/long/path">link</a> end`;
    const chunks = splitHtmlMessage(msg, 50);
    // No chunk should contain a partial tag
    for (const chunk of chunks) {
      // Count < and > — they should be balanced
      const opens = (chunk.match(/</g) || []).length;
      const closes = (chunk.match(/>/g) || []).length;
      expect(opens).toBe(closes);
    }
  });

  it('preserves code blocks together when possible', () => {
    const pre = 'A'.repeat(20);
    const code = 'B'.repeat(30);
    const msg = `${pre}\n<pre>${code}</pre>`;
    // Max length big enough to fit the whole thing
    const chunks = splitHtmlMessage(msg, 200);
    expect(chunks).toEqual([msg]);
  });

  it('handles message with only tags', () => {
    const msg = '<b>bold</b> and <i>italic</i>';
    expect(splitHtmlMessage(msg, 100)).toEqual([msg]);
  });

  it('produces valid chunks that each fit within maxLength (approximately)', () => {
    // Note: tag close/reopen can push slightly over, but raw content should respect limit
    const longContent = 'word '.repeat(500);
    const msg = `<b>${longContent}</b>`;
    const chunks = splitHtmlMessage(msg, 200);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be reasonably sized (allowing overhead for close/reopen tags)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(250); // 200 + generous tag overhead
    }
  });
});
