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

  // Headers (# Title, ## Title, etc.)
  if (/^\s{0,3}#{1,6}\s/m.test(text)) return true;

  // Unordered lists (- item, * item)
  if (/^\s*[-*]\s/m.test(text)) return true;

  // Ordered lists (1. item, 2. item)
  if (/^\s*\d+\.\s/m.test(text)) return true;

  // Tables (| col | col |)
  if (/\|.+\|.+\|/.test(text)) return true;

  return false;
}

/**
 * Parse a markdown table (header row + separator row + data rows) into
 * aligned text wrapped in `<pre>`.
 *
 * @param {string} block - The full matched table text (header + separator + rows)
 * @returns {string} HTML `<pre>` block with aligned columns
 */
function formatTable(block) {
  const lines = block.split('\n').filter(l => l.trim());

  // Parse each row into cells, trimming whitespace around pipes
  const parseRow = (line) =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

  const headerCells = parseRow(lines[0]);
  // lines[1] is the separator row — skip it during data parsing
  const dataRows = lines.slice(2).map(parseRow);

  // Calculate max width per column across header and all data rows
  const colCount = headerCells.length;
  const colWidths = headerCells.map(h => h.length);
  for (const row of dataRows) {
    for (let i = 0; i < colCount; i++) {
      const cell = (row[i] || '');
      if (cell.length > colWidths[i]) colWidths[i] = cell.length;
    }
  }

  // Build padded rows
  const pad = (str, width) => str + ' '.repeat(Math.max(0, width - str.length));
  const formatRow = (cells) =>
    cells.map((c, i) => pad(c || '', colWidths[i])).join('  ');

  const headerLine = formatRow(headerCells);
  const separator = colWidths.map(w => '-'.repeat(w)).join('  ');
  const bodyLines = dataRows.map(formatRow);

  const content = [headerLine, separator, ...bodyLines].join('\n');
  return `<pre>${escapeHtml(content)}</pre>`;
}

/**
 * Convert markdown text to Telegram HTML.
 *
 * Processing order matters:
 * 1. Extract code blocks (protect from further parsing)
 * 2. Escape HTML in remaining text
 * 3. Extract inline code (protect from further parsing)
 * 4. Extract tables into `<pre>` blocks (protect from inline formatting)
 * 5. Convert headers to bold text
 * 6. Convert list markers to Unicode bullets / consistent numbers
 * 7. Apply block-level formatting (blockquotes)
 * 8. Apply inline formatting (bold, italic, links, strikethrough)
 * 9. Restore tables, inline code, and code blocks
 *
 * @param {string} text
 * @returns {string}
 */
export function markdownToHtml(text) {
  if (!text) return '';

  const codeBlocks = [];
  const inlineCodes = [];
  const tableBlocks = [];
  const mdLinks = [];
  const bareLinks = [];
  const codeBlockToken = (i) => `\x00CB${i}\x00`;
  const inlineCodeToken = (i) => `\x00IC${i}\x00`;
  const tableToken = (i) => `\x00TB${i}\x00`;
  const mdLinkToken = (i) => `\x00ML${i}\x00`;
  const bareLinkToken = (i) => `\x00BL${i}\x00`;

  // Step 1: Extract fenced code blocks before any processing
  let result = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ''));
    const placeholder = codeBlockToken(codeBlocks.length);
    if (lang) {
      codeBlocks.push(`<pre><code class="language-${lang}">${escaped}</code></pre>`);
    } else {
      codeBlocks.push(`<pre>${escaped}</pre>`);
    }
    return placeholder;
  });

  // Step 1.5: Extract all links before HTML escaping and inline formatting
  // URLs contain characters (&, _, .) that would be mangled by escapeHtml
  // or matched by italic/bold regex patterns.

  // First: markdown links [text](url) — extract entire construct
  result = result.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_, text, url) => {
    const placeholder = mdLinkToken(mdLinks.length);
    mdLinks.push({ text, url });
    return placeholder;
  });

  // Then: bare URLs (not already captured by markdown links)
  result = result.replace(/(https?:\/\/[^\s<>\[\]"'`\x00]+)/g, (url) => {
    const placeholder = bareLinkToken(bareLinks.length);
    bareLinks.push(url);
    return placeholder;
  });

  // Step 2: Escape HTML in non-code text
  result = escapeHtml(result);

  // Step 3: Extract inline code (after HTML escaping so backtick content is safe)
  result = result.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = inlineCodeToken(inlineCodes.length);
    inlineCodes.push(`<code>${code}</code>`);
    return placeholder;
  });

  // Step 4: Extract markdown tables into <pre> blocks
  // A table is: header row | separator row (|---|) | one or more data rows
  result = result.replace(
    /(^\|.+\|[ \t]*\n\|[\s\-:|]+\|[ \t]*\n(?:\|.+\|[ \t]*(?:\n|$))+)/gm,
    (tableMatch) => {
      const placeholder = tableToken(tableBlocks.length);
      // formatTable works on raw text (before HTML escaping of |),
      // but | is not escaped by our escapeHtml, so this is fine.
      // However &amp; etc. inside cells need to be un-escaped for formatting,
      // then re-escaped inside formatTable. We pass through as-is since
      // formatTable calls escapeHtml on the final content.
      // We need to unescape first so the alignment math works on real chars.
      const unescaped = tableMatch
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
      tableBlocks.push(formatTable(unescaped));
      return placeholder;
    }
  );

  // Step 5: Headers — convert # Title to <b>Title</b>
  result = result.replace(/^(\s{0,3})#{1,6}\s+(.+)$/gm, '$1<b>$2</b>');

  // Step 6: Lists — convert markers to Unicode bullets / consistent numbers
  // Unordered: - or * at start of line → •
  result = result.replace(/^(\s*)[-*]\s+/gm, '$1• ');
  // Ordered: keep number, normalize marker
  result = result.replace(/^(\s*)(\d+)\.\s+/gm, '$1$2. ');

  // Step 7: Blockquotes — group consecutive lines starting with >
  result = result.replace(/(^&gt;\s?.+(?:\n&gt;\s?.+)*)/gm, (match) => {
    const lines = match.split('\n').map(l => l.replace(/^&gt;\s?/, ''));
    return `<blockquote>${lines.join('\n')}</blockquote>`;
  });

  // Step 8: Inline formatting
  // Bold: **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  result = result.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (single, not double)
  result = result.replace(/(?<!\*)\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '<i>$1</i>');
  result = result.replace(/(?<!_)_(?!\s)(.+?)(?<!\s)_(?!_)/g, '<i>$1</i>');

  // Strikethrough: ~~text~~
  result = result.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links: non-http [text](url) — reject non-http protocols (http/https links
  // were already extracted in Step 1.5; only non-http remain at this point)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
    // Non-http protocols were not extracted — leave them as-is (escaped text)
    return `[${linkText}](${url})`;
  });

  // Step 9a: Restore tables first (they may contain inline code placeholders)
  for (let i = tableBlocks.length - 1; i >= 0; i--) {
    result = result.replace(tableToken(i), tableBlocks[i]);
  }

  // Step 9b: Restore inline code (after tables, so placeholders inside tables are resolved)
  for (let i = inlineCodes.length - 1; i >= 0; i--) {
    result = result.replace(inlineCodeToken(i), inlineCodes[i]);
  }

  // Step 9c: Restore code blocks
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    result = result.replace(codeBlockToken(i), codeBlocks[i]);
  }

  // Step 9d: Restore markdown links as <a> tags
  for (let i = mdLinks.length - 1; i >= 0; i--) {
    const { text, url } = mdLinks[i];
    const safeHref = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const safeText = escapeHtml(text);
    result = result.replace(mdLinkToken(i), `<a href="${safeHref}">${safeText}</a>`);
  }

  // Step 9e: Restore bare URLs as <a> tags
  for (let i = bareLinks.length - 1; i >= 0; i--) {
    const url = bareLinks[i];
    const safeHref = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const safeText = escapeHtml(url);
    result = result.replace(bareLinkToken(i), `<a href="${safeHref}">${safeText}</a>`);
  }

  return result;
}
