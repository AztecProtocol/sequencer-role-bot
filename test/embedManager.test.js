const test = require('node:test');
const assert = require('node:assert/strict');
const { getButtons, getEmbed } = require('../utils/embedManager.js');

const ids = (buttons) => buttons.map((button) => button.data.custom_id);

test('the welcome panel has its five buttons', () => {
  assert.deepEqual(ids(getButtons('registration.welcomeHub')), [
    'register_new_sequencer',
    'register_provider',
    'manage_sequencer',
    'what_is_sequencer',
    'need_help'
  ]);
});

test('a key for one button gives that button, with its variables filled in', () => {
  assert.deepEqual(ids(getButtons('registration.networkSelection.submit', { network: 'mainnet' })), [
    'submit_details_mainnet'
  ]);
});

test('the signing help shows the keystore and the interactive cast command, not a key on the command line', () => {
  const embed = getEmbed('registration.signature', { messageToSign: 'm' });
  const help = embed.data.fields.find((field) => field.name === 'How to sign').value;
  const keystore = help.indexOf('cast wallet sign --keystore <file> "<message>"');
  const interactive = help.indexOf('cast wallet sign --interactive "<message>"');
  assert.ok(keystore >= 0 && interactive > keystore, help);
  assert.ok(!help.includes('--private-key'), help);
});
