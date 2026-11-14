/** Select context at dispatch time, after the preceding delivery has settled. */
import { sendToC4 } from './c4.js';
import { sessionGroupFromEndpoint } from './session-group.js';
import { formatMessage, getHistory, getHistoryLimit } from './context.js';
import { isMultiSession, pendingContext, acknowledgeContext } from './pending-context.js';

const queues = new Map();

export function sendGroupToC4(endpoint, opts, { historyKey, messageId, config, sequence }, onReject) {
  if (!isMultiSession()) {
    sendToC4('telegram', endpoint, formatMessage({ ...opts,
      contextMessages: getHistory(historyKey, messageId, config) }), onReject);
    return;
  }
  const sessionKey = sessionGroupFromEndpoint(endpoint);
  const run = () => {
    const snapshot = pendingContext(sessionKey, messageId, getHistoryLimit(historyKey, config), sequence);
    sendToC4('telegram', endpoint, formatMessage({ ...opts, ...snapshot }), onReject, {
      onDone(outcome) {
        if (outcome === 'sent' || outcome === 'committed') acknowledgeContext(sessionKey, snapshot);
        const queue = queues.get(sessionKey);
        queue.shift();
        if (queue.length) queue[0]();
        else queues.delete(sessionKey);
      },
    });
  };
  if (!queues.has(sessionKey)) queues.set(sessionKey, []);
  const queue = queues.get(sessionKey);
  queue.push(run);
  if (queue.length === 1) run();
}
