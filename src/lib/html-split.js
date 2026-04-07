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
  let pos = 0;
  let prevStack = []; // open tags carried from previous chunk

  while (pos < html.length) {
    // Build prefix/suffix from carried-over tags
    const prefix = openTags(prevStack);
    const suffixBudget = prevStack.reduce((sum, t) => sum + t.tag.length + 3, 0); // </tag>
    const available = Math.max(maxLength - prefix.length - suffixBudget, maxLength * 0.2);

    // Check if remaining content fits in one chunk
    if (prefix.length + (html.length - pos) + suffixBudget <= maxLength) {
      const chunk = (prefix + html.substring(pos)).trim();
      if (chunk.length > 0) chunks.push(chunk);
      break;
    }

    // Find candidate split point in the original string
    let breakAt = Math.min(pos + Math.floor(available), html.length);

    // Ensure not inside a tag
    if (isInsideTag(html, breakAt)) {
      for (let i = breakAt - 1; i >= pos; i--) {
        if (html[i] === '<') { breakAt = i; break; }
      }
    }

    // Try better break points within the content
    const segment = html.substring(pos, breakAt);
    const lastPara = segment.lastIndexOf('\n\n');
    if (lastPara > available * 0.3) {
      breakAt = pos + lastPara + 1;
    } else {
      const lastLine = segment.lastIndexOf('\n');
      if (lastLine > available * 0.3) {
        breakAt = pos + lastLine;
      } else {
        const lastSpace = segment.lastIndexOf(' ');
        if (lastSpace > available * 0.3) {
          breakAt = pos + lastSpace;
        }
      }
    }

    // Re-check not inside tag after adjustment
    if (isInsideTag(html, breakAt)) {
      for (let i = breakAt - 1; i >= pos; i--) {
        if (html[i] === '<') { breakAt = i; break; }
      }
    }

    // Safety: must make progress
    if (breakAt <= pos) breakAt = pos + Math.max(1, Math.floor(available));

    // Extract content and compute tag stack at split point
    const content = html.substring(pos, breakAt);
    const openStack = getOpenTagsAt(html, breakAt);

    // Build chunk: reopen previous tags + content + close current tags
    let chunk = prefix + content + closeTags(openStack);
    chunk = chunk.trim();
    if (chunk.length > 0) chunks.push(chunk);

    // Advance position and carry open tags to next chunk
    prevStack = openStack;
    pos = breakAt;

    // Skip leading whitespace
    while (pos < html.length && /\s/.test(html[pos])) pos++;
  }

  return chunks.length > 0 ? chunks : [''];
}
