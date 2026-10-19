const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

// The child processes run in an empty directory, so dotenv finds no local .env.

test('a log message is written to the console one time', () => {
  const output = execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'logger.js'))}).info('marker-7f3a')`], {
    env: { PATH: process.env.PATH },
    cwd: os.tmpdir(),
    encoding: 'utf8'
  });
  assert.equal(output.split('\n').filter((line) => line.includes('marker-7f3a')).length, 1);
});

test('the status job can run one check and exit', () => {
  // With a token that Discord refuses, the one-time run reports its own error.
  let output = '';
  try {
    execFileSync(process.execPath, [path.join(__dirname, '..', 'cronJob.js'), '--once'], {
      env: { PATH: process.env.PATH, DISCORD_BOT_TOKEN: 'not-a-token' },
      cwd: os.tmpdir(),
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 20000
    });
  } catch (error) {
    output = String(error.stdout) + String(error.stderr);
  }
  assert.match(output, /Error initializing guardian check/);
});
