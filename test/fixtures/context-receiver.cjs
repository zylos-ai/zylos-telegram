// Isolated C4 boundary: capture the exact argv emitted by the real sender.
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.HOME;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'received.jsonl'), JSON.stringify(args) + '\n');
const resultFile = path.join(root, 'result.json');
const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile)) : { ok: true };
if (result.hold) {
  // Keep this private receiver unfinished until the test teardown terminates it.
  process.stdin.resume();
} else {
  process.stdout.write(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
