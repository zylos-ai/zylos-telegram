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

    it('does not leak internal placeholders in mixed inline-code list text', () => {
      const input = '字段：`message.textMode`\n可选值：`plain` / `markdown` / `html`';
      const result = markdownToHtml(input);
      expect(result).not.toContain('INLINECODE');
      expect(result).not.toContain('IC');
      expect(result).toContain('<code>plain</code>');
      expect(result).toContain('<code>markdown</code>');
      expect(result).toContain('<code>html</code>');
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

    it('escapes double quotes in href attribute', () => {
      const result = markdownToHtml('click [here](https://a.com?q="1")');
      expect(result).toBe('click <a href="https://a.com?q=&quot;1&quot;">here</a>');
      // Must not break the attribute boundary
      expect(result).not.toContain('href="https://a.com?q="');
    });

    it('escapes angle brackets in href attribute', () => {
      const result = markdownToHtml('click [here](https://a.com?q=<x>)');
      expect(result).toBe('click <a href="https://a.com?q=&lt;x&gt;">here</a>');
    });

    it('rejects non-http protocols', () => {
      expect(markdownToHtml('click [here](javascript:alert(1))'))
        .toBe('click [here](javascript:alert(1))');
      expect(markdownToHtml('click [here](data:text/html,<h1>x)'))
        .toBe('click [here](data:text/html,&lt;h1&gt;x)');
    });

    it('allows https links', () => {
      const result = markdownToHtml('click [here](https://example.com)');
      expect(result).toContain('<a href="https://example.com">');
    });

    it('allows http links', () => {
      const result = markdownToHtml('click [here](http://example.com)');
      expect(result).toContain('<a href="http://example.com">');
    });

    it('preserves & in markdown link query parameters', () => {
      const result = markdownToHtml('click [here](https://example.com?a=1&b=2&c=3)');
      // href must have &amp; for valid HTML, but Telegram decodes it back to &
      expect(result).toBe('click <a href="https://example.com?a=1&amp;b=2&amp;c=3">here</a>');
    });

    it('preserves complex OAuth URL in markdown link', () => {
      const url = 'https://accounts.google.com/o/oauth2/auth?scope=calendar&access_type=offline&redirect_uri=http://localhost&response_type=code&client_id=123.apps.googleusercontent.com';
      const result = markdownToHtml(`[authorize](${url})`);
      expect(result).toContain('<a href="');
      expect(result).toContain('scope=calendar&amp;access_type=offline');
      expect(result).toContain('response_type=code');
      expect(result).not.toContain('&amp;amp;'); // no double-escaping
    });
  });

  describe('bare URLs', () => {
    it('wraps bare https URL in <a> tag', () => {
      const result = markdownToHtml('visit https://example.com today');
      expect(result).toBe('visit <a href="https://example.com">https://example.com</a> today');
    });

    it('wraps bare http URL in <a> tag', () => {
      const result = markdownToHtml('visit http://example.com today');
      expect(result).toBe('visit <a href="http://example.com">http://example.com</a> today');
    });

    it('preserves & in bare URL query parameters', () => {
      const result = markdownToHtml('open https://example.com?a=1&b=2&c=3 now');
      expect(result).toContain('href="https://example.com?a=1&amp;b=2&amp;c=3"');
      // Display text also has HTML-escaped &
      expect(result).toContain('>https://example.com?a=1&amp;b=2&amp;c=3</a>');
    });

    it('preserves complex OAuth bare URL', () => {
      const url = 'https://accounts.google.com/o/oauth2/auth?scope=calendar&access_type=offline&response_type=code';
      const result = markdownToHtml(`open this:\n${url}`);
      expect(result).toContain('<a href="');
      expect(result).toContain('scope=calendar&amp;access_type=offline');
      expect(result).toContain('response_type=code');
      expect(result).not.toContain('&amp;amp;'); // no double-escaping
    });

    it('handles bare URL at start of line', () => {
      const result = markdownToHtml('https://example.com');
      expect(result).toBe('<a href="https://example.com">https://example.com</a>');
    });

    it('handles bare URL with path and fragment', () => {
      const result = markdownToHtml('see https://example.com/path/to/page#section');
      expect(result).toContain('href="https://example.com/path/to/page#section"');
    });

    it('does not double-wrap markdown link URLs', () => {
      const result = markdownToHtml('click [here](https://example.com?a=1&b=2)');
      // Should have exactly one <a> tag, not nested
      const aCount = (result.match(/<a /g) || []).length;
      expect(aCount).toBe(1);
    });

    it('handles multiple bare URLs in same text', () => {
      const result = markdownToHtml('visit https://a.com and https://b.com');
      const aCount = (result.match(/<a /g) || []).length;
      expect(aCount).toBe(2);
    });

    it('does not link non-http schemes', () => {
      const result = markdownToHtml('not a link: ftp://example.com');
      expect(result).not.toContain('<a');
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

  describe('headers', () => {
    it('converts # H1 to <b>H1</b>', () => {
      expect(markdownToHtml('# H1')).toBe('<b>H1</b>');
    });

    it('converts ## H2 to <b>H2</b>', () => {
      expect(markdownToHtml('## H2')).toBe('<b>H2</b>');
    });

    it('converts ### H3 to <b>H3</b>', () => {
      expect(markdownToHtml('### H3')).toBe('<b>H3</b>');
    });

    it('handles multi-level headers in same text', () => {
      const input = '# Title\n\n## Section\n\n### Subsection';
      const result = markdownToHtml(input);
      expect(result).toBe('<b>Title</b>\n\n<b>Section</b>\n\n<b>Subsection</b>');
    });

    it('handles header with inline formatting', () => {
      const input = '# **bold** title';
      const result = markdownToHtml(input);
      expect(result).toBe('<b><b>bold</b> title</b>');
    });

    it('does not convert #hashtag (no space)', () => {
      expect(markdownToHtml('#hashtag')).toBe('#hashtag');
    });
  });

  describe('lists', () => {
    it('converts - item to bullet', () => {
      expect(markdownToHtml('- item one')).toBe('• item one');
    });

    it('converts * item to bullet', () => {
      expect(markdownToHtml('* item one')).toBe('• item one');
    });

    it('preserves ordered list numbers', () => {
      expect(markdownToHtml('1. first\n2. second')).toBe('1. first\n2. second');
    });

    it('preserves nested list indentation', () => {
      const input = '- parent\n  - child\n    - grandchild';
      const result = markdownToHtml(input);
      expect(result).toBe('• parent\n  • child\n    • grandchild');
    });

    it('handles list items with inline formatting', () => {
      const input = '- **bold** item\n- *italic* item';
      const result = markdownToHtml(input);
      expect(result).toBe('• <b>bold</b> item\n• <i>italic</i> item');
    });
  });

  describe('tables', () => {
    it('converts a simple 2-column table to <pre>', () => {
      const input = '| Name | Age |\n|---|---|\n| Alice | 30 |';
      const result = markdownToHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('</pre>');
      expect(result).toContain('Name');
      expect(result).toContain('Alice');
    });

    it('handles alignment separator row', () => {
      const input = '| Left | Center | Right |\n|:---|:---:|---:|\n| a | b | c |';
      const result = markdownToHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('Left');
      expect(result).toContain('a');
    });

    it('escapes HTML inside table content', () => {
      const input = '| Col |\n|---|\n| <b> |';
      const result = markdownToHtml(input);
      expect(result).toContain('&lt;b&gt;');
      expect(result).not.toContain('<b>');
    });

    it('handles multi-row table with aligned columns', () => {
      const input = '| Name | Age |\n|---|---|\n| Alice | 30 |\n| Bob | 25 |';
      const result = markdownToHtml(input);
      expect(result).toContain('<pre>');
      expect(result).toContain('Alice');
      expect(result).toContain('Bob');
    });

    it('wraps table in <pre> tags', () => {
      const input = '| A | B |\n|---|---|\n| 1 | 2 |';
      const result = markdownToHtml(input);
      expect(result).toMatch(/^<pre>[\s\S]+<\/pre>$/);
    });

    it('does not leak INLINECODE placeholder when cell contains inline code', () => {
      const input = '| A |\n|---|\n| `x` |';
      const result = markdownToHtml(input);
      expect(result).not.toContain('INLINECODE');
      expect(result).toContain('<code>x</code>');
    });

    it('handles cell with inline code + bold + link without placeholder leakage', () => {
      const input = '| Col |\n|---|\n| `x` **b** [a](https://example.com) |';
      const result = markdownToHtml(input);
      expect(result).not.toContain('INLINECODE');
      expect(result).not.toContain('TABLE_');
      expect(result).toContain('<pre>');
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

  it('detects headers', () => {
    expect(hasMarkdownContent('# Title')).toBe(true);
    expect(hasMarkdownContent('## Subtitle')).toBe(true);
    expect(hasMarkdownContent('### H3')).toBe(true);
  });

  it('does not detect #hashtag as header', () => {
    expect(hasMarkdownContent('#hashtag')).toBe(false);
  });

  it('detects unordered lists', () => {
    expect(hasMarkdownContent('- item')).toBe(true);
    expect(hasMarkdownContent('* item')).toBe(true);
  });

  it('detects ordered lists', () => {
    expect(hasMarkdownContent('1. first')).toBe(true);
    expect(hasMarkdownContent('10. tenth')).toBe(true);
  });

  it('detects tables', () => {
    expect(hasMarkdownContent('| A | B | C |')).toBe(true);
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
