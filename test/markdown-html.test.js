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
