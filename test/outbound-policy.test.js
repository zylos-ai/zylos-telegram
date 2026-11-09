import { describe, expect, it } from 'vitest';
import { assertOutboundAllowed } from '../src/lib/auth.js';

const owner = { chat_id: 123 };
const config = overrides => ({ owner, dmPolicy: 'owner', dmAllowFrom: ['456'],
  groupPolicy: 'allowlist', groups: { '-100': {} }, ...overrides });

describe('outbound destination policy', () => {
  it('owner policy permits only the owner, even with a populated allowlist', () => {
    expect(() => assertOutboundAllowed(config(), '123')).not.toThrow();
    expect(() => assertOutboundAllowed(config(), '456')).toThrow('OUTBOUND_DM_DENIED: dmPolicy=owner');
  });

  it('allowlist permits the owner and numeric modern/legacy entries', () => {
    const cfg = config({ dmPolicy: 'allowlist', dmAllowFrom: [456], whitelist: { chat_ids: [789] } });
    for (const id of ['123', '456', '789']) expect(() => assertOutboundAllowed(cfg, id)).not.toThrow();
    expect(() => assertOutboundAllowed(cfg, '124')).toThrow('OUTBOUND_DM_DENIED');
  });

  it('does not infer a numeric identity from a username or wildcard', () => {
    const cfg = config({ dmPolicy: 'allowlist', dmAllowFrom: ['@alice', '*'], whitelist: { usernames: ['alice'] } });
    expect(() => assertOutboundAllowed(cfg, '456')).toThrow('OUTBOUND_DM_DENIED');
  });

  it('honors explicit open DM policy and defaults to owner only', () => {
    expect(() => assertOutboundAllowed(config({ dmPolicy: 'open' }), '456')).not.toThrow();
    expect(() => assertOutboundAllowed({ owner }, '456')).toThrow('dmPolicy=owner');
    expect(() => assertOutboundAllowed({ owner: { chat_id: null } }, '123')).toThrow('OUTBOUND_DM_DENIED');
  });

  it('permits only configured groups under allowlist, independent of sender restrictions', () => {
    expect(() => assertOutboundAllowed(config({ groups: { '-100': { allowFrom: ['999'] } } }), '-100')).not.toThrow();
    expect(() => assertOutboundAllowed(config(), '-101')).toThrow('OUTBOUND_GROUP_DENIED: groupPolicy=allowlist');
  });

  it('honors open and disabled group policies without an owner bypass', () => {
    expect(() => assertOutboundAllowed(config({ groupPolicy: 'open' }), '-101')).not.toThrow();
    expect(() => assertOutboundAllowed(config({ groupPolicy: 'disabled' }), '-100')).toThrow('groupPolicy=disabled');
  });

  it('matches inbound fallback behavior for unknown policies', () => {
    expect(() => assertOutboundAllowed(config({ dmPolicy: 'Owner' }), '123')).not.toThrow();
    expect(() => assertOutboundAllowed(config({ dmPolicy: 'typo' }), '456')).not.toThrow();
    expect(() => assertOutboundAllowed(config({ groupPolicy: 'typo' }), '-100')).not.toThrow();
    expect(() => assertOutboundAllowed(config({ dmPolicy: 'typo' }), '789')).toThrow('dmPolicy=typo');
    expect(() => assertOutboundAllowed(config({ groupPolicy: 'typo' }), '-101')).toThrow('groupPolicy=typo');
  });

  it.each(['', '0', '-0', '0123', '+123', '123 ', '@publicchannel', '--123', '1.5', '1e3', '123|msg:1', null])(
    'rejects noncanonical destination %j even under open policies', id => {
      expect(() => assertOutboundAllowed(config({ dmPolicy: 'open', groupPolicy: 'open' }), id)).toThrow('OUTBOUND_INVALID_CHAT_ID');
    });
});
