/** Bounded, durable context that has not yet been handed to a group session. */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { historyKeyToLogFile } from './utils.js';

const states = new Map();

export function isMultiSession() {
  try {
    const root = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
    return JSON.parse(fs.readFileSync(path.join(root, '.zylos/config.json'), 'utf8'))?.session_mode === 'multi';
  } catch {
    return false;
  }
}

function stateFile(key) {
  return path.join(DATA_DIR, 'data', 'context', historyKeyToLogFile(key) + '.json');
}

function load(key) {
  if (!states.has(key)) {
    let state;
    try { state = JSON.parse(fs.readFileSync(stateFile(key), 'utf8')); } catch {}
    states.set(key, state || { end: 0, acknowledged: 0, entries: [] });
  }
  return states.get(key);
}

function save(key, state) {
  const file = stateFile(key);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch (err) {
    console.error(`[telegram] Pending context save failed for ${key}: ${err.message}`);
  }
}

export function recordPending(key, entry, limit) {
  if (!isMultiSession() || entry.user_id === 'bot' || !String(key).startsWith('group-')) return;
  const state = load(key);
  const existing = state.entries.find(m => m.message_id === entry.message_id);
  if (existing) return existing.sequence;
  state.end++;
  state.entries.push({ ...entry, text: entry.text.substring(0, 500), sequence: state.end });
  // One extra slot lets selection exclude the current message without losing context.
  state.entries = state.entries.slice(-(limit + 1));
  save(key, state);
  return state.end;
}

export function pendingContext(key, currentId, limit, sequence) {
  const state = load(key);
  const currentSequence = sequence ?? state.entries.find(m => m.message_id === currentId)?.sequence ?? state.end;
  const end = Math.max(state.acknowledged, currentSequence);
  const eligible = state.entries.filter(m => m.sequence <= end);
  const messages = eligible.filter(m => m.message_id !== currentId).slice(-limit);
  const count = end - state.acknowledged - (currentSequence > state.acknowledged ? 1 : 0);
  return {
    contextMessages: messages,
    omittedContextCount: Math.max(0, count - messages.length),
    end,
  };
}

export function acknowledgeContext(key, snapshot) {
  const state = load(key);
  state.acknowledged = snapshot.end;
  state.entries = state.entries.filter(m => m.sequence > snapshot.end);
  save(key, state);
}
