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
});
