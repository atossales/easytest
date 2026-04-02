const { randomBytes } = require('crypto');

/**
 * Sanitizes a string into a URL-safe slug.
 * Lowercase, replaces spaces/special chars with hyphens, strips leading/trailing hyphens.
 */
function sanitize(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * Generates a random slug like "ab-x4k9m2" (always 8 chars after prefix).
 */
function generate() {
  return 'ab-' + randomBytes(4).toString('hex');
}

/**
 * Returns a slug from the test name if possible, otherwise generates one.
 * The caller must verify uniqueness via DB.
 */
function fromName(name) {
  const s = sanitize(name || '');
  return s.length >= 3 ? s : generate();
}

module.exports = { sanitize, generate, fromName };
