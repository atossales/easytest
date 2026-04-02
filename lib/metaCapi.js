const crypto = require('crypto');
const logger = require('./logger');

const META_API_URL = 'https://graph.facebook.com/v19.0';

function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

/**
 * Sends an event to the Meta Conversions API.
 *
 * @param {Object} opts
 * @param {string} opts.pixelId
 * @param {string} opts.accessToken
 * @param {string} opts.eventName        - e.g. 'ViewContent', 'Lead', 'Purchase'
 * @param {string} opts.eventSourceUrl
 * @param {string} opts.clientIp
 * @param {string} opts.clientUserAgent
 * @param {string} [opts.clientId]       - our internal visitor ID (will be hashed)
 * @param {string} [opts.fbc]            - _fbc cookie
 * @param {string} [opts.fbp]            - _fbp cookie
 * @param {string} [opts.eventId]        - deduplication ID (match pixel event_id)
 * @param {Object} [opts.customData]     - extra params (test_name, variation_name, etc.)
 * @param {boolean} [opts.testMode]      - send to /debug_events instead
 */
async function sendEvent(opts) {
  const {
    pixelId, accessToken, eventName, eventSourceUrl,
    clientIp, clientUserAgent, clientId,
    fbc, fbp, eventId, customData = {}, testMode = false,
  } = opts;

  if (!pixelId || !accessToken) return;

  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: eventSourceUrl,
      action_source: 'website',
      event_id: eventId || crypto.randomUUID(),
      user_data: {
        client_ip_address: clientIp,
        client_user_agent: clientUserAgent,
        external_id: sha256(clientId),
        fbc: fbc || undefined,
        fbp: fbp || undefined,
      },
      custom_data: customData,
    }],
  };

  const endpoint = testMode ? 'debug_events' : 'events';
  const url = `${META_API_URL}/${pixelId}/${endpoint}?access_token=${accessToken}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) {
      logger.warn('Meta CAPI error', { code: data.error.code, msg: data.error.message });
    } else {
      logger.debug('Meta CAPI sent', { event: eventName, events_received: data.events_received });
    }
  } catch (e) {
    logger.error('Meta CAPI fetch failed', { msg: e.message });
  }
}

/**
 * Builds a deduplication event_id that matches what the pixel fires.
 * Format: {testId}_{variationId}_{clientId}_{timestamp}
 */
function buildEventId(testId, variationId, clientId) {
  return `${testId}_${variationId}_${clientId}_${Date.now()}`;
}

module.exports = { sendEvent, buildEventId };
