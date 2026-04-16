/**
 * Superuser utility functions
 * Checks if a user is a superuser based on configuration
 */

/**
 * Check if a username is the superuser
 * @param {string} username - Username to check
 * @returns {boolean} - True if user is superuser
 */
function isSuperuser(username) {
  const superuserName = process.env.SUPERUSER_NAME;
  
  if (!superuserName) {
    return false;
  }
  
  return username === superuserName;
}

module.exports = {
  isSuperuser,
};
