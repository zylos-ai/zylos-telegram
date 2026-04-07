/**
 * HTML-aware message splitter for Telegram
 *
 * Splits long HTML messages into chunks that respect Telegram's 4096 char limit
 * while preserving HTML tag integrity. When a split occurs inside a tag scope,
 * the chunk is closed with proper closing tags and the next chunk reopens them.
 */

const DEFAULT_MAX_LENGTH = 4000;

/**
 * Parse open/close tags from HTML to track nesting.
 * Returns array of { tag, attrs, isClose, isSelfClose } in order of appearance.
 */
function parseTagsInOrder(html) {
  const tagRegex = /<\/?([a-z][a-z0-9]*)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi;
  const tags = [];
  let match;
  while ((match = tagRegex.exec(html)) !== null) {
    const fullMatch = match[0];
    const tagName = match[1].toLowerCase();
    const attrs = match[2] || '';
    tags.push({
      tag: tagName,
      attrs: attrs.trim(),
      isClose: fullMatch.startsWith('</'),
      isSelfClose: fullMatch.endsWith('/>'),
      index: match.index,
      length: fullMatch.length
    });
  }
  return tags;
}

/**
 * Get the stack of open tags at a given position in the HTML string.
 * Returns array of { tag, attrs } from outermost to innermost.
 */
function getOpenTagsAt(html, position) {
  const segment = html.substring(0, position);
  const tags = parseTagsInOrder(segment);
  const stack = [];

  for (const t of tags) {
    if (t.isSelfClose) continue;
    if (t.isClose) {
      // Find matching open tag (pop from stack)
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === t.tag) {
          stack.splice(i, 1);
          break;
        }
      }
    } else {
      stack.push({ tag: t.tag, attrs: t.attrs });
    }
  }

  return stack;
}

/**
 * Generate closing tags for a stack (innermost first).
 */
function closeTags(stack) {
  return stack.slice().reverse().map(t => `</${t.tag}>`).join('');
}

/**
 * Generate opening tags for a stack (outermost first).
 */
function openTags(stack) {
  return stack.map(t => {
    if (t.attrs) return `<${t.tag} ${t.attrs}>`;
    return `<${t.tag}>`;
  }).join('');
}

/**
 * Check if position is inside an HTML tag definition (between < and >).
 */
function isInsideTag(html, position) {
  // Look backward for < or >
  for (let i = position - 1; i >= 0; i--) {
    if (html[i] === '>') return false;
    if (html[i] === '<') return true;
  }
  return false;
}

/**
 * Find a safe split point that is not inside an HTML tag.
 * Searches backward from position.
 */
function findSafeSplitPoint(html, position) {
  let pos = position;

  // If inside a tag, back up to before the tag
  if (isInsideTag(html, pos)) {
    for (let i = pos - 1; i >= 0; i--) {
      if (html[i] === '<') {
        pos = i;
        break;
      }
    }
  }

  return pos;
}

/**
 * Split HTML message into chunks, preserving tag integrity.
 *
 * Strategy:
 * 1. If message fits in maxLength, return as-is
 * 2. Find best split point (paragraph > line > word > hard)
 * 3. Ensure split is not inside an HTML tag
 * 4. Close open tags at end of chunk, reopen at start of next
 * 5. Repeat for remaining text
 *
 * @param {string} html - HTML message to split
 * @param {number} [maxLength] - Max length per chunk (default 4000)
 * @returns {string[]} Array of HTML chunks
 */
export function splitHtmlMessage(html, maxLength = DEFAULT_MAX_LENGTH) {
  if (!html) return [''];
  if (html.length <= maxLength) return [html];

  const chunks = [];
  let remaining = html;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find candidate split point
    let breakAt = findSafeSplitPoint(remaining, maxLength);

    // Try to find a good break point (paragraph > line > word)
    const segment = remaining.substring(0, breakAt);

    // Paragraph break (\n\n)
    const lastPara = segment.lastIndexOf('\n\n');
    if (lastPara > maxLength * 0.3) {
      breakAt = lastPara + 1;
    } else {
      // Line break
      const lastLine = segment.lastIndexOf('\n');
      if (lastLine > maxLength * 0.3) {
        breakAt = lastLine;
      } else {
        // Word boundary (space)
        const lastSpace = segment.lastIndexOf(' ');
        if (lastSpace > maxLength * 0.3) {
          breakAt = lastSpace;
        }
        // else: hard split at breakAt
      }
    }

    // Ensure we're not splitting inside a tag
    breakAt = findSafeSplitPoint(remaining, breakAt);

    // Safety: don't go below a minimum
    if (breakAt < 1) breakAt = maxLength;

    // Get the chunk text
    let chunk = remaining.substring(0, breakAt);
    remaining = remaining.substring(breakAt);

    // Get open tags at the split point
    const openStack = getOpenTagsAt(html, html.length - remaining.length - chunk.length + breakAt);

    // Close open tags at end of chunk
    if (openStack.length > 0) {
      chunk = chunk + closeTags(openStack);
      // Reopen tags at start of next chunk
      remaining = openTags(openStack) + remaining;
    }

    // Trim whitespace
    chunk = chunk.trim();
    remaining = remaining.trim();

    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  return chunks.length > 0 ? chunks : [''];
}
