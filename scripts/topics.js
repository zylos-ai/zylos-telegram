#!/usr/bin/env node
import fs from 'node:fs';
import { Telegraf } from 'telegraf';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { DATA_DIR, loadConfig, getEnv } from '../src/lib/config.js';
import { appendTopics, listTopics, changeTopicState } from '../src/lib/topics.js';
import { isGroupAllowed } from '../src/lib/auth.js';
import { redactSecrets } from '../src/lib/redact.js';

try {
  const [command, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--chat', '--state', '--topic', '--file'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error('Invalid topics options');
    options[args[i]] = args[i + 1];
  }
  const chat = options['--chat'];
  const allowed = { list: ['--chat', '--state'], import: ['--file'], close: ['--chat', '--topic'], reopen: ['--chat', '--topic'] }[command];
  if (allowed && Object.keys(options).some(key => !allowed.includes(key))) throw new Error('Option does not apply to this topics command');
  if (chat && !/^-[1-9]\d*$/.test(chat)) throw new Error('Expected a negative numeric chat ID');
  if (options['--state'] && !['open', 'closed'].includes(options['--state'])) throw new Error('Expected state open or closed');
  const config = loadConfig();
  let result;
  if (command === 'list') {
    result = listTopics(DATA_DIR, chat, options['--state']);
  } else if (command === 'import') {
    if (!options['--file']) throw new Error('Expected --file with a JSON array of topic records');
    const records = JSON.parse(fs.readFileSync(options['--file'], 'utf8'));
    if (!Array.isArray(records) || records.length === 0) throw new Error('Expected a nonempty JSON array');
    if (records.some(record => !isGroupAllowed(config, record.chat_id))) throw new Error('Import contains a group that is not allowed');
    appendTopics(DATA_DIR, records);
    result = { imported: records.length };
  } else if (['close', 'reopen'].includes(command)) {
    if (!chat || !options['--topic']) throw new Error('Expected --chat and --topic');
    const token = getEnv('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');
    const proxy = getEnv('TELEGRAM_PROXY_URL');
    const bot = new Telegraf(token, proxy ? { telegram: { agent: new HttpsProxyAgent(proxy) } } : {});
    result = await changeTopicState(config, bot.telegram, DATA_DIR, chat, Number(options['--topic']), command);
  } else throw new Error('Usage: topics.js list --chat <id> [--state open|closed] | import --file <json> | close|reopen --chat <id> --topic <id>');
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: redactSecrets(error.message) }));
  process.exitCode = 1;
}
