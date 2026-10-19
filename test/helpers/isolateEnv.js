// Loaded before every test file (see the npm "test" script).
//
// The code calls dotenv.config(), which reads a local .env file. In a test
// process, dotenv.config() loads no file at all: this file replaces it.
// It also sets every variable name from .env.example that is not set yet to
// '', so code that reads such a name sees an empty value, the same as an
// unconfigured deployment. Tests that need a value set it themselves.
//
// This file reads only .env.example, never .env.
const dotenv = require('dotenv');

dotenv.config = () => ({ parsed: {} });
const fs = require('node:fs');
const path = require('node:path');

const example = path.join(__dirname, '..', '..', '.env.example');

function variableNames(text) {
  const names = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.push(match[1]);
  }
  return names;
}

for (const name of variableNames(fs.readFileSync(example, 'utf8'))) {
  if (process.env[name] === undefined) process.env[name] = '';
}

module.exports = { variableNames };
