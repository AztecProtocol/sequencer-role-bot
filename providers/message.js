// The message that a provider signer signs, and its check.
// The message names the Discord account, the provider and the signer, so a
// signature for one registration cannot complete a different one.
const { generateSignatureTimestamp } = require('../db/signatureAttempts.js');
const { verifySignature } = require('../verifySignature.js');

function buildProviderMessage(discordUserId, providerId, signer) {
  return `Verifying for Aztec Sequencer role as a provider. Discord ID: ${discordUserId}. Provider: ${providerId}. Signer: ${signer}. Timestamp: ${generateSignatureTimestamp()}`;
}

async function verifyProviderSignature(record, signature, discordUserId) {
  if (String(record.discord_user_id) !== String(discordUserId)) {
    return { success: false, error: 'Registration record belongs to a different Discord account' };
  }
  const binding = /Discord ID: (\d+)\. Provider: (\d+)\. Signer: (\S+)\. Timestamp:/.exec(record.message_to_sign || '');
  if (
    !binding ||
    binding[1] !== String(discordUserId) ||
    Number(binding[2]) !== Number(record.provider_id) ||
    binding[3].toLowerCase() !== String(record.signer_address).toLowerCase()
  ) {
    return { success: false, error: 'Message does not name this Discord account, provider and signer' };
  }
  return verifySignature(record.message_to_sign, signature, record.signer_address);
}

module.exports = { buildProviderMessage, verifyProviderSignature };
