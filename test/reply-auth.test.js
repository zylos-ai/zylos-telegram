import { describe, expect, it } from 'vitest';
import { authorizeInboundReply, isAuthorizedReply, REPLY_AUTH_TTL_MS } from '../src/lib/reply-auth.js';
import { endpointFromCtx } from '../src/lib/endpoint.js';
import { sessionGroupFromEndpoint } from '../src/lib/session-group.js';

const secret = 'fixture-token';
const now = 1700000000000;
const config = () => ({ owner: { chat_id: '123' }, dmPolicy: 'allowlist', dmAllowFrom: ['@alice'], groupPolicy: 'allowlist', groups: {} });
const group = (sender = 123) => ({ from: { id: sender }, chat: { id: -101, type: 'supergroup', is_forum: true },
  message: { message_id: 7, message_thread_id: 9, is_topic_message: true } });
const dm = () => ({ from: { id: 456, username: 'alice' }, chat: { id: 456, type: 'private' }, message: { message_id: 7 } });
const sign = (cfg = config(), ctx = group(), options = {}) => authorizeInboundReply(cfg, ctx, endpointFromCtx(ctx), secret, { ownerMention: true, now, ...options });

describe('authenticated inbound reply authorization', () => {
  it('allows an owner mention in an unlisted group without authorizing the group', () => {
    const cfg = config();
    const endpoint = sign(cfg);
    expect(isAuthorizedReply(cfg, endpoint, secret, now)).toBe(true);
    expect(cfg.groups).toEqual({});
    expect(sessionGroupFromEndpoint(endpoint)).toBe('group-101:topic-9');
    expect(isAuthorizedReply(cfg, '-101|msg:7|req:-101:7|thread:9', secret, now)).toBe(false);
  });

  it.each([
    ['other sender', () => group(999), {}],
    ['no verified mention', group, { ownerMention: false }],
  ])('does not issue a grant for %s', (_label, ctx, opts) => {
    expect(sign(config(), ctx(), opts)).not.toContain('reply-auth:');
  });

  it.each(['disabled', 'typo'])('denies group policy %s at issuance and after issuance', policy => {
    const cfg = config();
    const endpoint = sign(cfg);
    cfg.groupPolicy = policy;
    expect(sign(cfg)).not.toContain('reply-auth:');
    expect(isAuthorizedReply(cfg, endpoint, secret, now)).toBe(false);
  });

  it('denies a grant after the owner changes', () => {
    const cfg = config();
    const endpoint = sign(cfg);
    cfg.owner.chat_id = '999';
    expect(isAuthorizedReply(cfg, endpoint, secret, now)).toBe(false);
  });

  it('preserves username-only DM replies but rechecks the live allowlist', () => {
    const cfg = config();
    const endpoint = sign(cfg, dm());
    expect(isAuthorizedReply(cfg, endpoint, secret, now)).toBe(true);
    cfg.dmAllowFrom = [];
    expect(isAuthorizedReply(cfg, endpoint, secret, now)).toBe(false);
    expect(sign(cfg, dm())).not.toContain('reply-auth:');
  });

  it('preserves legacy username DM replies', () => {
    const cfg = config();
    cfg.dmAllowFrom = [];
    cfg.whitelist = { usernames: ['alice'] };
    expect(isAuthorizedReply(cfg, sign(cfg, dm()), secret, now)).toBe(true);
  });

  it('preserves the authenticated owner DM exception for an invalid DM policy', () => {
    const cfg = config();
    cfg.dmPolicy = 'typo';
    const ctx = dm();
    ctx.from.id = ctx.chat.id = 123;
    expect(isAuthorizedReply(cfg, sign(cfg, ctx), secret, now)).toBe(true);
    expect(sign(cfg, dm())).not.toContain('reply-auth:');
  });

  it.each([
    ['chat', e => e.replace('-101|', '-102|')],
    ['message', e => e.replace('msg:7', 'msg:8')],
    ['request', e => e.replace('req:-101:7', 'req:-101:8')],
    ['thread', e => e.replace('thread:9', 'thread:10')],
    ['missing message', e => e.replace('|msg:7', '')],
    ['missing request', e => e.replace('|req:-101:7', '')],
    ['missing thread', e => e.replace('|thread:9', '')],
    ['signature', e => e.slice(0, -1) + (e.endsWith('0') ? '1' : '0')],
    ['forged claim', e => e.replace(/reply-auth:[^.]+/, 'reply-auth:e30')],
  ])('rejects changed %s', (_label, change) => {
    expect(isAuthorizedReply(config(), change(sign()), secret, now)).toBe(false);
  });

  it('rejects expired, future, wrong-key, missing-key, and malformed grants', () => {
    const endpoint = sign();
    expect(isAuthorizedReply(config(), endpoint, secret, now + REPLY_AUTH_TTL_MS - 1)).toBe(true);
    expect(isAuthorizedReply(config(), endpoint, secret, now + REPLY_AUTH_TTL_MS)).toBe(false);
    expect(isAuthorizedReply(config(), endpoint, secret, now - 1)).toBe(false);
    expect(isAuthorizedReply(config(), endpoint, 'other-key', now)).toBe(false);
    expect(isAuthorizedReply(config(), endpoint, '', now)).toBe(false);
    expect(isAuthorizedReply(config(), endpoint + '.extra', secret, now)).toBe(false);
  });

  it('does not sign an endpoint that differs from the inbound event', () => {
    const ctx = group();
    expect(authorizeInboundReply(config(), ctx, '-102|msg:7|req:-102:7|thread:9', secret, { ownerMention: true })).not.toContain('reply-auth:');
  });
});
