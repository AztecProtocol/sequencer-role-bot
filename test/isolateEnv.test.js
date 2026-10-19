const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The code loads a local .env file with dotenv. The npm "test" script loads
// test/helpers/isolateEnv.js first, so no value from such a file gets into a
// test. These tests use their own file and never read the real .env.

test('dotenv loads no file in a test process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolate-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'ISOLATE_ENV_PROBE=leaked\nAZTEC_RPC_URL=http://leaked.invalid\n');
  try {
    require('dotenv').config({ path: file, override: true });
    assert.equal(process.env.ISOLATE_ENV_PROBE, undefined);
    assert.equal(process.env.AZTEC_RPC_URL, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tests run without values from a local environment file', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  const names = [...example.matchAll(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);
  assert.ok(names.includes('AZTEC_RPC_URL') && names.includes('DISCORD_BOT_TOKEN'));
  for (const name of names) {
    assert.ok(process.env[name] === '', `${name} must be empty in a test that did not set it`);
  }
});
