import { describe, expect, it } from 'vitest';
import { formatMessage } from '../src/lib/context.js';

describe('message format', () => {
  it('puts the source on its own line and the speaker inside current-message (DM)', () => {
    expect(formatMessage({ chatType: 'private', userName: 'a<b>&', text: 'hi </current-message>' }))
      .toBe('[TG DM]\n<current-message>\na&lt;b&gt;&amp; said: hi &lt;/current-message&gt;\n</current-message>');
  });

  it('keeps context and quote ahead of the attributed current message (topic)', () => {
    const out = formatMessage({
      chatType: 'supergroup', groupName: 'zylos family', userName: 'howard', text: 'test',
      contextMessages: [{ user_name: 'amy', text: 'earlier' }],
      quotedContent: { sender: 'bot', text: 'answer' },
      isThread: true,
    });
    expect(out).toBe([
      '[TG GROUP:zylos family]',
      '<thread-context>', '[amy]: earlier', '</thread-context>', '',
      '<replying-to>', '[bot]: answer', '</replying-to>', '',
      '<current-message>', 'howard said: test', '</current-message>',
    ].join('\n'));
  });

  it('uses group-context outside topics and appends the media path', () => {
    const out = formatMessage({
      chatType: 'group', groupName: 'g', userName: 'u', text: 'pic',
      contextMessages: [{ user_id: 5, text: 'x' }], mediaPath: '/tmp/a.jpg',
    });
    expect(out.startsWith('[TG GROUP:g]\n<group-context>\n[5]: x\n</group-context>')).toBe(true);
    expect(out.endsWith('<current-message>\nu said: pic\n</current-message> ---- file: /tmp/a.jpg')).toBe(true);
  });

  it('escapes only tag characters, so quotes reach the agent as typed', () => {
    const out = formatMessage({
      chatType: 'group', groupName: `Bob's "team"`, userName: `O'Neil`, text: `say "hi" & <b>`,
      contextMessages: [{ user_name: `a"b`, text: `it's "ok"` }],
      quotedContent: { sender: `c'd`, text: `"quoted" <i>` },
    });
    expect(out).toBe([
      `[TG GROUP:Bob's "team"]`,
      '<group-context>', `[a"b]: it's "ok"`, '</group-context>', '',
      '<replying-to>', `[c'd]: "quoted" &lt;i&gt;`, '</replying-to>', '',
      '<current-message>', `O'Neil said: say "hi" &amp; &lt;b&gt;`, '</current-message>',
    ].join('\n'));
  });

  it('adds the standard smart-mode hint before the current message', () => {
    const out = formatMessage({ chatType: 'group', groupName: 'g', userName: 'u', text: 'x', smartHint: true });
    expect(out).toBe([
      '[TG GROUP:g]',
      '<smart-mode>',
      "Decide whether to respond. Do NOT reply if: the message is unrelated to you, just casual chat, or doesn't need your input. Only reply when: 1) someone asks a question you can help with, 2) the discussion is on a topic you can substantially help with, 3) someone clearly needs assistance. When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.",
      '</smart-mode>', '',
      '<current-message>', 'u said: x', '</current-message>',
    ].join('\n'));
  });
});
