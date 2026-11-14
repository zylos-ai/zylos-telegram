/** Select and consume context synchronously when dispatching each message. */
import { sendToC4 } from './c4.js';
import { sessionGroupFromEndpoint } from './session-group.js';
import { formatMessage, getHistory, getHistoryLimit } from './context.js';
import { isMultiSession, pendingContext, acknowledgeContext } from './pending-context.js';


export function sendGroupToC4(endpoint, opts, { historyKey, messageId, config, sequence }, onReject) {
  if (!isMultiSession()) {
    sendToC4('telegram', endpoint, formatMessage({ ...opts,
      contextMessages: getHistory(historyKey, messageId, config) }), onReject);
    return;
  }
  const sessionKey = sessionGroupFromEndpoint(endpoint);
  const snapshot = pendingContext(sessionKey, messageId, getHistoryLimit(historyKey, config), sequence);
  acknowledgeContext(sessionKey, snapshot);
  sendToC4('telegram', endpoint, formatMessage({ ...opts, ...snapshot }), onReject);
}
