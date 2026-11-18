import { appendTopics } from '../../src/lib/topics.js';
// Private child: parent owns timeout, termination and isolated environment.
process.send('ready');
process.once('message', ({ directory, record, now }) => {
  Date.now = () => now;
  appendTopics(directory, [record]);
  process.disconnect();
});
