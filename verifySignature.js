#!/usr/bin/env node

const { ethers } = require('ethers');
const { Command } = require('commander');

/**
 * Parse timestamp from message string
 * @param {string} message - The message containing timestamp
 * @returns {number|null} - Unix timestamp in milliseconds or null if not found
 */
function parseTimestampFromMessage(message) {
  const timestampRegex = /Timestamp:\s*(\d{13})/;
  const match = message.match(timestampRegex);
  
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  
  return null;
}

/**
 * Check if signature timestamp is expired
 * @param {number} timestamp - Unix timestamp in milliseconds
 * @param {number} expiryMs - Expiry time in milliseconds (default: 300000 = 5 minutes)
 * @returns {boolean} - True if expired, false if still valid
 */
function isTimestampExpired(timestamp, expiryMs = 300000) {
  const currentTime = Date.now();
  const age = currentTime - timestamp;
  // Timestamp validation check
  return age > expiryMs;
}

/**
 * Verify a digital signature against an Ethereum address
 * @param {string} message - The original message that was signed
 * @param {string} signature - The signature to verify (0x...)
 * @param {string} expectedAddress - The expected Ethereum address
 * @returns {Promise<{success: boolean, recoveredAddress?: string, error?: string}>}
 */
async function verifySignature(message, signature, expectedAddress) {
  try {
    // Validate inputs
    if (!message || !signature || !expectedAddress) {
      return {
        success: false,
        error: 'Missing required arguments: message, signature, and address are required'
      };
    }

    // Parse and validate timestamp from message
    const timestamp = parseTimestampFromMessage(message);
    if (timestamp !== null) {
      // Check if timestamp is expired (5 minutes = 300000 ms)
      if (isTimestampExpired(timestamp, 300000)) {
        const currentTime = Date.now();
        const ageInMs = currentTime - timestamp;
        const ageInMinutes = Math.floor(ageInMs / 60000);
        
        return {
          success: false,
          error: `Signature expired: timestamp is ${ageInMinutes} minutes old`
        };
      }
    }

    // Validate signature format
    if (!signature.startsWith('0x') || signature.length < 66) {
      return {
        success: false,
        error: 'Invalid signature format: signature must be a valid hex string starting with 0x'
      };
    }

    // Validate address format
    if (!ethers.isAddress(expectedAddress)) {
      return {
        success: false,
        error: 'Invalid address format: expectedAddress must be a valid Ethereum address'
      };
    }

    // Verify the signature using ethers.js
    const recoveredAddress = ethers.verifyMessage(message, signature);

    // Compare addresses (case-insensitive)
    const addressesMatch = recoveredAddress.toLowerCase() === expectedAddress.toLowerCase();

    return {
      success: addressesMatch,
      recoveredAddress,
      expectedAddress
    };

  } catch (error) {
    return {
      success: false,
      error: `Verification error: ${error.message}`
    };
  }
}

/**
 * Verify the signature for a registration record.
 * The record must belong to the submitting Discord account, and the signed
 * message must name that account and the wallet of the record.
 * @param {{discord_user_id: string, wallet_address: string, message_to_sign: string}} record
 * @param {string} signature - The signature to verify (0x...)
 * @param {string} discordUserId - The Discord account that submits the signature
 * @returns {Promise<{success: boolean, recoveredAddress?: string, error?: string}>}
 */
async function verifyRegistrationSignature(record, signature, discordUserId) {
  if (String(record.discord_user_id) !== String(discordUserId)) {
    return {
      success: false,
      error: 'Registration record belongs to a different Discord account'
    };
  }

  const binding = /Discord ID: (\d+)\. Wallet: (\S+)\. Timestamp:/.exec(record.message_to_sign || '');
  const walletMatches = binding && binding[2].toLowerCase() === String(record.wallet_address).toLowerCase();
  if (!binding || binding[1] !== String(discordUserId) || !walletMatches) {
    return {
      success: false,
      error: 'Message does not name this Discord account and wallet'
    };
  }

  return verifySignature(record.message_to_sign, signature, record.wallet_address);
}

/**
 * Print the verification result in a formatted way
 * @param {string} message - The original message
 * @param {string} signature - The signature
 * @param {string} expectedAddress - The expected address
 * @param {Object} result - The verification result
 */
function printVerificationResult(message, signature, expectedAddress, result) {
  console.log('SIGNATURE VERIFICATION REPORT');
  console.log('='.repeat(50));

  console.log('INPUT SUMMARY:');
  console.log('-'.repeat(30));
  console.log(`Message:      "${message}"`);
  console.log(`Signature:    ${signature.substring(0, 20)}...${signature.substring(-20)}`);
  console.log(`Expected:     ${expectedAddress}`);

  console.log('\nVERIFICATION RESULT:');
  console.log('-'.repeat(30));

  if (result.recoveredAddress) {
    console.log(`Recovered:    ${result.recoveredAddress}`);
  }

  if (result.success) {
    console.log('Status:       VALID SIGNATURE');
    console.log('\nSUCCESS: Signature is valid.');
  } else {
    console.log('Status:       INVALID SIGNATURE');
    if (result.error) {
      console.log(`Error:        ${result.error}`);
    }
    console.log('\nFAILURE: Signature verification failed.');
  }

  console.log('='.repeat(50));
}

/**
 * Main function with commander CLI handling
 */
async function main() {
  try {
    // Setup commander
    const program = new Command();
    
    program
      .name('verify-signature')
      .description('Verify a digital signature against an Ethereum address')
      .version('1.0.0');

    program
      .argument('<message>', 'The original message that was signed')
      .argument('<signature>', 'The signature to verify (0x...)')
      .argument('<address>', 'The expected Ethereum address')
      .option('-v, --verbose', 'Enable verbose output', false)
      .action(async (message, signature, address, options) => {
        console.log('Starting Signature Verification..');
        console.log(`Message: "${message}"`);
        console.log(`Signature: ${signature.substring(0, 20)}...${signature.substring(-20)}`);
        console.log(`Expected: ${address}`);
        
        // Verify the signature
        const result = await verifySignature(message, signature, address);
        
        // Print the result
        printVerificationResult(message, signature, address, result);
        
        // Exit with appropriate code
        if (result.success) {
          console.log('\nVerification completed successfully!');
          process.exit(0);
        } else {
          console.log('\n❌ Verification failed)');
          process.exit(1);
        }
      });

    // If no arguments provided, show help
    if (process.argv.length <= 2) {
      program.outputHelp();
      console.log('\nUsage examples:');
      console.log('  node verifySignature.js "hello world" "0x..." "0x123...456"');
      console.log('  node verifySignature.js "Verifying my identity" "0x..." "0xabc...def"');
      return;
    }

    // Parse command line arguments
    program.parse();

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

// Run main function if this file is executed directly
if (require.main === module) {
  main();
}

// Export functions for testing
module.exports = {
  verifySignature,
  verifyRegistrationSignature,
  printVerificationResult,
  parseTimestampFromMessage,
  isTimestampExpired
};