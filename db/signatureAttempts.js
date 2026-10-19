// Signature attempts tracking helper functions
const { getPool } = require('./db.js');

// Rate limiting constants
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DAILY_ATTEMPT_LIMIT = 10; // 10 attempts per day

// Record signature attempt
async function recordSignatureAttempt(discordUserId, discordUsername, network, walletAddress, timestampGenerated) {
  try {
    const pool = getPool();
    
    // Check for existing attempt within rate limit window
    const existingQuery = `
      SELECT attempt_count FROM signature_attempts 
      WHERE discord_user_id = $1 AND network = $2 AND wallet_address = $3 
        AND timestamp_generated = $4 AND created_at >= NOW() - INTERVAL '5 minutes'
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    
    const existingResult = await pool.query(existingQuery, [
      discordUserId, 
      network, 
      walletAddress, 
      timestampGenerated
    ]);
    
    if (existingResult.rows.length > 0) {
      // Update existing attempt count (only if within rate limit window)
      const updateQuery = `
        UPDATE signature_attempts 
        SET attempt_count = attempt_count + 1, updated_at = CURRENT_TIMESTAMP
        WHERE discord_user_id = $1 AND network = $2 AND wallet_address = $3 
          AND timestamp_generated = $4 AND created_at >= NOW() - INTERVAL '5 minutes'
        RETURNING attempt_count
      `;
      
      const updateResult = await pool.query(updateQuery, [
        discordUserId, 
        network, 
        walletAddress, 
        timestampGenerated
      ]);
      
      return {
        success: true,
        attemptCount: updateResult.rows[0].attempt_count,
        isNewAttempt: false
      };
    } else {
      // Insert new attempt
      const insertQuery = `
        INSERT INTO signature_attempts (
          discord_user_id, discord_username, network, wallet_address, 
          timestamp_generated, attempt_count
        ) VALUES ($1, $2, $3, $4, $5, 1)
        RETURNING attempt_count
      `;
      
      const insertResult = await pool.query(insertQuery, [
        discordUserId,
        discordUsername,
        network,
        walletAddress,
        timestampGenerated
      ]);
      
      return {
        success: true,
        attemptCount: insertResult.rows[0].attempt_count,
        isNewAttempt: true
      };
    }
  } catch (error) {
    console.error('Error recording signature attempt:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Check daily attempt limit
async function checkDailyAttemptLimit(discordUserId) {
  try {
    const pool = getPool();
    
    const query = `
      SELECT COUNT(*) as attempts_today
      FROM signature_attempts 
      WHERE discord_user_id = $1 
        AND created_at >= CURRENT_DATE
        AND created_at < CURRENT_DATE + INTERVAL '1 day'
    `;
    
    const result = await pool.query(query, [discordUserId]);
    const attemptsToday = parseInt(result.rows[0].attempts_today);
    
    return {
      success: true,
      attemptsToday,
      hasReachedLimit: attemptsToday >= DAILY_ATTEMPT_LIMIT,
      remainingAttempts: Math.max(0, DAILY_ATTEMPT_LIMIT - attemptsToday)
    };
  } catch (error) {
    console.error('Daily limit check error:', error.message);
    return {
      success: false,
      error: error.message,
      attemptsToday: 0,
      hasReachedLimit: false,
      remainingAttempts: DAILY_ATTEMPT_LIMIT
    };
  }
}

// Check if user can request signature attempt
async function canRequestSignatureAttempt(discordUserId, discordUsername, network, walletAddress, timestampGenerated) {
  try {
    // First check daily limit
    const dailyCheck = await checkDailyAttemptLimit(discordUserId);
    if (!dailyCheck.success) {
      return dailyCheck;
    }
    
    if (dailyCheck.hasReachedLimit) {
      return {
        success: false,
        reason: 'daily_limit_reached',
        message: `Daily limit reached (${DAILY_ATTEMPT_LIMIT} attempts). Try again tomorrow.`,
        attemptsToday: dailyCheck.attemptsToday,
        remainingAttempts: dailyCheck.remainingAttempts
      };
    }
    
    // Check for recent identical attempts (5-minute window)
    const pool = getPool();
    const recentQuery = `
      SELECT attempt_count, created_at FROM signature_attempts 
      WHERE discord_user_id = $1 AND network = $2 AND wallet_address = $3 
        AND timestamp_generated = $4 AND created_at >= NOW() - INTERVAL '5 minutes'
      ORDER BY created_at DESC 
      LIMIT 1
    `;
    
    const recentResult = await pool.query(recentQuery, [
      discordUserId,
      network,
      walletAddress,
      timestampGenerated
    ]);
    
    if (recentResult.rows.length > 0) {
      const existing = recentResult.rows[0];
      const remainingTime = Math.ceil((5 * 60 * 1000 - (Date.now() - new Date(existing.created_at).getTime())) / 1000);
      
      return {
        success: false,
        reason: 'rate_limited',
        message: `Please wait ${remainingTime}s before trying again.`,
        attemptCount: existing.attempt_count,
        remainingTime
      };
    }
    
    // All checks passed - allow attempt
    return {
      success: true,
      reason: 'allowed',
      remainingAttempts: dailyCheck.remainingAttempts
    };
    
  } catch (error) {
    console.error('Eligibility check error:', error.message);
    return {
      success: false,
      reason: 'error',
      message: 'Error checking eligibility. Please try again.',
      error: error.message
    };
  }
}

// Generate timestamp for signature
function generateSignatureTimestamp() {
  // Round to nearest 5 seconds for consistency
  const now = Date.now();
  return Math.floor(now / 5000) * 5000;
}

// Generate signature message.
// The message names the Discord account and the wallet, so a signature made
// for one registration cannot complete a different one.
function generateSignatureMessage(discordUserId, walletAddress) {
  const timestamp = generateSignatureTimestamp();
  return `Verifying for Aztec Sequencer role. Discord ID: ${discordUserId}. Wallet: ${walletAddress}. Timestamp: ${timestamp}`;
}

module.exports = {
  recordSignatureAttempt,
  checkDailyAttemptLimit,
  canRequestSignatureAttempt,
  generateSignatureTimestamp,
  generateSignatureMessage,
  RATE_LIMIT_WINDOW_MS,
  DAILY_ATTEMPT_LIMIT
};