/**
 * Markdown to Telegram HTML converter
 *
 * Converts common markdown patterns to Telegram-supported HTML tags.
 * Designed for LLM-generated text — handles the most common patterns
 * without attempting to be a full markdown parser.
 */

/**
 * Escape HTML special characters in text.
 * Must be applied BEFORE markdown conversion to avoid double-escaping tags.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Strip HTML tags from text (for fallback to plain text).
 *
 * @param {string} html
 * @returns {string}
 */
export function stripHtmlTags(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Detect whether text contains markdown formatting.
 * Used by 'markdown' mode to decide whether to convert or send as plain.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasMarkdownContent(text) {
  if (!text) return false;

  // Code blocks (``` ... ```)
  if (/```[\s\S]*?```/.test(text)) return true;

  // Inline code (`...`)
  if (/`[^`]+`/.test(text)) return true;

  // Bold (**...**) or (__...__)
  if (/\*\*[^*]+\*\*/.test(text)) return true;
  if (/__[^_]+__/.test(text)) return true;

  // Italic (*...*) — single asterisk not preceded/followed by space
  if (/(?<!\*)\*(?!\s)[^*]+(?<!\s)\*(?!\*)/.test(text)) return true;
  // Italic (_..._) — single underscore
  if (/(?<!_)_(?!\s)[^_]+(?<!\s)_(?!_)/.test(text)) return true;

  // Links [text](url)
  if (/\[[^\]]+\]\([^)]+\)/.test(text)) return true;

  // Strikethrough ~~...~~
  if (/~~[^~]+~~/.test(text)) return true;

  // Blockquotes (lines starting with >)
  if (/^>\s/m.test(text)) return true;

  return false;
}

/**
 * Convert markdown text to Telegram HTML.
 *
 * Processing order matters:
 * 1. Extract code blocks (protect from further parsing)
 * 2. Escape HTML in remaining text
 * 3. Extract inline code (protect from further parsing)
 * 4. Apply block-level formatting (blockquotes)
 * 5. Apply inline formatting (bold, italic, links, strikethrough)
 * 6. Restore code blocks and inline code
 *
 * @param {string} text
 * @returns {string}
 */
export function markdownToHtml(text) {
  if (!text) return '';

  const codeBlocks = [];
  const inlineCodes = [];

  // Step 1: Extract fenced code blocks before any processing
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    const placeholder = `\x00CODEBLOCK_${codeBlocks.length}\x00`;
    if (lang) {
      codeBlocks.push(`<pre><code class="language-${lang}">${escaped}</code></pre>`);
    } else {
      codeBlocks.push(`<pre>${escaped}</pre>`);
    }
    return placeholder;
  });

  // Step 2: Escape HTML in non-code text
  result = escapeHtml(result);

  // Step 3: Extract inline code (after HTML escaping so backtick content is safe)
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `\x00INLINECODE_${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${code}</code>`);
    return placeholder;
  });

  // Step 4: Blockquotes — group consecutive lines starting with >
  result = result.replace(/(^&gt;\s?.+(?:\n&gt;\s?.+)*)/gm, (match) => {
    const lines = match.split('\n').map(l => l.replace(/^&gt;\s?/, ''));
    return `<blockquote>${lines.join('\n')}</blockquote>`;
  });

  // Step 5: Inline formatting
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (single, not double)
  result = result.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: [text](url) — with href attribute escaping and protocol whitelist
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    // Only allow http/https protocols (already HTML-escaped, so &amp; etc.)
    const decoded = url.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    if (!/^https?:\/\//i.test(decoded)) return `[${linkText}](${url})`;
    // Escape href attribute value: & is already &amp;, escape " < >
    const safeUrl = url.replace(/"/g, '&quot;');
    return `<a href="${safeUrl}">${linkText}</a>`;
  });

  // Step 6: Restore inline code
  for (let i = inlineCodes.length - 1; i >= 0; i--) {
    result = result.replace(`\x00INLINECODE_${i}\x00`, inlineCodes[i]);
  }

  // Step 7: Restore code blocks
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    result = result.replace(`\x00CODEBLOCK_${i}\x00`, codeBlocks[i]);
  }

  return result;
}
