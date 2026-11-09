import crypto from 'node:crypto';
import { isDmAllowed, isOwner } from './auth.js';
import { parseEndpoint } from './utils.js';

export const REPLY_AUTH_TTL_MS = 24 * 60 * 60 * 1000;
const positiveId = value => typeof value === 'string' && /^[1-9]\d*$/.test(value);

function route(endpoint) {
  const p = parseEndpoint(endpoint);
  if (!/^-?[1-9]\d*$/.test(p.chatId) || !positiveId(p.msg) ||
      p.req !== `${p.chatId}:${p.msg}` || (p.thread !== undefined && !positiveId(p.thread))) return null;
  return { chatId: p.chatId, msg: p.msg, req: p.req, thread: p.thread || null };
}

function canReply(config, claim) {
  if (!config || !positiveId(claim.senderId)) return false;
  const ctx = { from: { id: claim.senderId, username: claim.username }, chat: { id: claim.chatId } };
  if (claim.chatId.startsWith('-')) {
    return claim.kind === 'owner-mention' &&
      ['open', 'allowlist'].includes(config.groupPolicy || 'allowlist') && isOwner(config, ctx);
  }
  if (claim.kind !== 'dm' || claim.senderId !== claim.chatId) return false;
  // Keep the existing inbound owner exception, even for a misspelled DM policy.
  if (isOwner(config, ctx)) return true;
  return ['open', 'allowlist', 'owner'].includes(config.dmPolicy || 'owner') && isDmAllowed(config, ctx);
}

function mac(body, secret) {
  return crypto.createHmac('sha256', secret).update(`telegram-reply-v1:${body}`).digest('hex');
}

/** Called only for accepted inbound messages; group text explicitly proves the mention. */
export function authorizeInboundReply(config, ctx, endpoint, secret, { ownerMention = false, now = Date.now() } = {}) {
  const r = route(endpoint);
  if (!r || !secret || r.chatId !== String(ctx.chat?.id) || r.msg !== String(ctx.message?.message_id) ||
      r.thread !== (ctx.message?.message_thread_id ? String(ctx.message.message_thread_id) : null)) return endpoint;
  const kind = ctx.chat?.type === 'private' ? 'dm' :
    (['group', 'supergroup'].includes(ctx.chat?.type) && ownerMention ? 'owner-mention' : null);
  const claim = { ...r, kind, senderId: String(ctx.from?.id), username: ctx.from?.username || null, issuedAt: now };
  if (!canReply(config, claim)) return endpoint;
  const body = Buffer.from(JSON.stringify(claim)).toString('base64url');
  return `${endpoint}|reply-auth:${body}.${mac(body, secret)}`;
}

/** Recheck live policy and every routing field; a claimed owner ID alone grants nothing. */
export function isAuthorizedReply(config, endpoint, secret, now = Date.now()) {
  try {
    const p = parseEndpoint(endpoint);
    const r = route(endpoint);
    if (!secret || !r || typeof p['reply-auth'] !== 'string') return false;
    const [body, signature, extra] = p['reply-auth'].split('.');
    if (extra !== undefined || !body || !/^[a-f0-9]{64}$/.test(signature || '')) return false;
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(mac(body, secret), 'hex'))) return false;
    const claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(claim.issuedAt) || claim.issuedAt > now || now - claim.issuedAt >= REPLY_AUTH_TTL_MS) return false;
    if (!Object.entries(r).every(([key, value]) => claim[key] === value)) return false;
    return canReply(config, claim);
  } catch {
    return false;
  }
}
