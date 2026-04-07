import { describe, it, expect } from 'vitest';
import { markdownToHtml, hasMarkdownContent } from '../src/lib/markdown-html.js';

describe('markdownToHtml', () => {
  describe('bold', () => {
    it('converts **text** to <b>', () => {
      expect(markdownToHtml('hello **world**')).toBe('hello <b>world</b>');
    });

    it('converts __text__ to <b>', () => {
      expect(markdownToHtml('hello __world__')).toBe('hello <b>world</b>');
    });
  });

  describe('italic', () => {
    it('converts *text* to <i>', () => {
      expect(markdownToHtml('hello *world*')).toBe('hello <i>world</i>');
    });

    it('converts _text_ to <i>', () => {
      expect(markdownToHtml('hello _world_')).toBe('hello <i>world</i>');
    });
  });

  describe('inline code', () => {
    it('converts `code` to <code>', () => {
      expect(markdownToHtml('use `npm install`')).toBe('use <code>npm install</code>');
    });

    it('does not parse markdown inside inline code', () => {
      expect(markdownToHtml('use `**not bold**`')).toBe('use <code>**not bold**</code>');
    });
  });

  describe('code blocks', () => {
    it('converts fenced code block without language', () => {
      const input = '```\nconst x = 1;\n```';
      expect(markdownToHtml(input)).toBe('<pre>const x = 1;</pre>');
    });

    it('converts fenced code block with language', () => {
      const input = '```js\nconst x = 1;\n```';
      expect(markdownToHtml(input)).toBe('<pre><code class="language-js">const x = 1;</code></pre>');
    });

    it('does not parse markdown inside code blocks', () => {
      const input = '```\n**bold** and *italic*\n```';
      expect(markdownToHtml(input)).toBe('<pre>**bold** and *italic*</pre>');
    });

    it('escapes HTML inside code blocks', () => {
      const input = '```\n<div>hello</div>\n```';
      expect(markdownToHtml(input)).toBe('<pre>&lt;div&gt;hello&lt;/div&gt;</pre>');
    });
  });

  describe('links', () => {
    it('converts [text](url) to <a>', () => {
      expect(markdownToHtml('click [here](https://example.com)'))
        .toBe('click <a href="https://example.com">here</a>');
    });
  });

  describe('strikethrough', () => {
    it('converts ~~text~~ to <s>', () => {
      expect(markdownToHtml('this is ~~wrong~~ right'))
        .toBe('this is <s>wrong</s> right');
    });
  });

  describe('blockquotes', () => {
    it('converts > lines to <blockquote>', () => {
      expect(markdownToHtml('> quoted text'))
        .toBe('<blockquote>quoted text</blockquote>');
    });

    it('groups consecutive blockquote lines', () => {
      const input = '> line 1\n> line 2';
      expect(markdownToHtml(input))
        .toBe('<blockquote>line 1\nline 2</blockquote>');
    });
  });

  describe('HTML escaping', () => {
    it('escapes & < > in regular text', () => {
      expect(markdownToHtml('a < b & c > d'))
        .toBe('a &lt; b &amp; c &gt; d');
    });

    it('does not double-escape inside tags', () => {
      const result = markdownToHtml('**a & b**');
      expect(result).toBe('<b>a &amp; b</b>');
    });
  });

  describe('nested formatting', () => {
    it('handles bold inside italic', () => {
      const result = markdownToHtml('*hello **world***');
      // Bold is processed first, so the ** becomes <b> then * wraps in <i>
      expect(result).toContain('<b>');
      expect(result).toContain('<i>');
    });
  });

  describe('edge cases', () => {
    it('returns empty string for null input', () => {
      expect(markdownToHtml(null)).toBe('');
    });

    it('returns empty string for undefined input', () => {
      expect(markdownToHtml(undefined)).toBe('');
    });

    it('returns empty string for empty string', () => {
      expect(markdownToHtml('')).toBe('');
    });

    it('returns plain text unchanged when no markdown', () => {
      expect(markdownToHtml('hello world')).toBe('hello world');
    });
  });
});

describe('hasMarkdownContent', () => {
  it('detects bold **text**', () => {
    expect(hasMarkdownContent('hello **bold**')).toBe(true);
  });

  it('detects bold __text__', () => {
    expect(hasMarkdownContent('hello __bold__')).toBe(true);
  });

  it('detects italic *text*', () => {
    expect(hasMarkdownContent('hello *italic*')).toBe(true);
  });

  it('detects inline code', () => {
    expect(hasMarkdownContent('use `code` here')).toBe(true);
  });

  it('detects code blocks', () => {
    expect(hasMarkdownContent('```\ncode\n```')).toBe(true);
  });

  it('detects links', () => {
    expect(hasMarkdownContent('click [here](url)')).toBe(true);
  });

  it('detects strikethrough', () => {
    expect(hasMarkdownContent('~~removed~~')).toBe(true);
  });

  it('detects blockquotes', () => {
    expect(hasMarkdownContent('> quoted')).toBe(true);
  });

  it('returns false for plain text', () => {
    expect(hasMarkdownContent('hello world')).toBe(false);
  });

  it('returns false for null', () => {
    expect(hasMarkdownContent(null)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasMarkdownContent('')).toBe(false);
  });
});
