import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sessionGroupFromEndpoint } from './session-group.js';

export function getC4ReceivePath() {
  return path.join(process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos'),
    '.claude/skills/comm-bridge/scripts/c4-receive.js');
}

export function c4ReceiveSupportsOption(name) {
  try {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(path.dirname(getC4ReceivePath()), 'c4-receive-options.json'), 'utf8'));
    return manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
      && manifest.options !== null && typeof manifest.options === 'object'
      && !Array.isArray(manifest.options) && Object.hasOwn(manifest.options, name);
  } catch {
    return false;
  }
}

export function buildC4ReceiveArgs({ source, endpoint, content, sessionGroup }) {
  const args = ['--channel', source, '--endpoint', endpoint, '--json', '--content', content];
  if (sessionGroup != null && sessionGroup !== '' && c4ReceiveSupportsOption('--session-group')) {
    args.push('--session-group', sessionGroup);
  }
  return args;
}

export const GENERIC_REJECT_REPLY = "Sorry, I couldn't take this message right now. Please try again later.";
export const UNCERTAIN_REPLY = "Sorry, this message may not have reached me. If you don't get a reply in a few minutes, please send it again.";

/**
 * Decide what to do with a structured c4-receive rejection.
 * Core's error text is written for the agent, never for the Telegram user.
 * - persisted is a non-empty array: the inbound row was committed (e.g. a
 *   post-commit status notice failed). Do not reply and do not resend.
 * - persisted is an empty array: nothing was stored; ask the user to try later.
 * - anything else (null, or absent on older Cores): Core cannot say whether it
 *   stored the message; tell the user it may not have arrived.
 * In every case the raw text stays in logs.
 * @param {object} response - parsed `{ ok: false, error }` JSON
 * @returns {'committed'|'not_stored'|'uncertain'}
 */
export function classifyC4Rejection(response) {
  const persisted = response?.error?.persisted;
  if (!Array.isArray(persisted)) return 'uncertain';
  return persisted.length > 0 ? 'committed' : 'not_stored';
}

/**
 * Parse c4-receive JSON response from stdout.
 * Returns parsed object or null if parsing fails.
 */
export function parseC4Response(stdout) {
  if (!stdout) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

/**
 * True when c4-receive never started (spawn itself failed), so Core cannot
 * have stored anything. Any other failure without a structured result is an
 * unknown commit state.
 */
function neverStarted(error) {
  return typeof error.code === 'string'
    && typeof error.syscall === 'string' && error.syscall.startsWith('spawn');
}

/**
 * Send message to Claude via C4.
 * The session group is derived from the endpoint and passed only when the
 * installed Core lists --session-group (rechecked on every call, including the retry).
 * A rejected group is never dropped and resent to the overall group.
 *
 * c4-receive runs without a timeout: Core may still be storing the message or
 * sending a status notice after it, and killing it would leave the outcome unknown.
 * Following Core's contract, an inbound call that is already stored or whose
 * outcome is unknown is never retried. Only a call that never started is retried once.
 * @param {string} source - Channel name
 * @param {string} endpoint - Endpoint ID
 * @param {string} content - Message content
 * @param {function} [onReject] - Called once when the agent will not answer this message:
 *   with a user-facing notice to send, or with null when Core already committed
 *   the inbound row (clean up typing/reaction only, send nothing)
 * @param {object} [opts]
 * @param {number} [opts.retryDelayMs=2000]
 * @param {function} [opts.onDone] - Test hook: called with the final outcome
 */
export function sendToC4(source, endpoint, content, onReject, { retryDelayMs = 2000, onDone } = {}) {
  if (!content) {
    console.error('[telegram] sendToC4 called with empty content');
    return;
  }
  const sessionGroup = sessionGroupFromEndpoint(endpoint);
  const done = outcome => { if (onDone) onDone(outcome); };

  const run = cb => execFile(process.execPath,
    [getC4ReceivePath(), ...buildC4ReceiveArgs({ source, endpoint, content, sessionGroup })],
    { encoding: 'utf8' }, cb);

  // Structured rejection: Core's text is written for the agent, so it only goes to the log.
  const handleRejection = (response, label) => {
    const { code, message } = response.error;
    if (classifyC4Rejection(response) === 'committed') {
      console.warn(`[telegram] C4 ${label} after commit (${code}), not resending: ${message}`);
      if (onReject) onReject(null);
      return done('committed');
    }
    const kind = classifyC4Rejection(response);
    console.warn(`[telegram] C4 ${label} (${code}, ${kind}) [group=${sessionGroup}]: ${message}`);
    if (onReject) onReject(kind === 'not_stored' ? GENERIC_REJECT_REPLY : UNCERTAIN_REPLY);
    return done('rejected');
  };

  // No structured result from a process that ran: it may have stored the message.
  const handleUnknown = (error, label) => {
    console.error(`[telegram] C4 ${label}, outcome unknown, not resending: ${error.message}`);
    if (onReject) onReject(UNCERTAIN_REPLY);
    return done('uncertain');
  };

  run((error, stdout) => {
    if (!error) {
      console.log(`[telegram] Sent to C4: ${content.substring(0, 50)}...`);
      return done('sent');
    }
    const response = parseC4Response(stdout);
    if (response && response.ok === false && response.error?.message) return handleRejection(response, 'rejected');
    if (!neverStarted(error)) return handleUnknown(error, 'send failed');
    // c4-receive never started, so nothing was stored - retry once
    console.warn(`[telegram] C4 receive did not start, retrying in ${retryDelayMs}ms: ${error.message}`);
    setTimeout(() => {
      run((retryError, retryStdout) => {
        if (!retryError) {
          console.log(`[telegram] Sent to C4 (retry): ${content.substring(0, 50)}...`);
          return done('sent');
        }
        const retryResponse = parseC4Response(retryStdout);
        if (retryResponse && retryResponse.ok === false && retryResponse.error?.message) {
          return handleRejection(retryResponse, 'rejected after retry');
        }
        console.error(`[telegram] C4 send failed after retry: ${retryError.message}`);
        if (onReject) onReject(UNCERTAIN_REPLY);
        return done('failed');
      });
    }, retryDelayMs);
  });
}
