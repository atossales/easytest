const express  = require('express');
const router   = express.Router();
const { getDb, getSettings } = require('../lib/database');
const { sendEvent }          = require('../lib/metaCapi');
const logger                 = require('../lib/logger');
const { getDeviceType, parseUtm, normalizeUrl } = require('../lib/utils');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Normalize URL for conversion matching: strip protocol, trailing slash and query string */
function urlsMatch(stored, incoming) {
  const a = normalizeUrl(stored);
  const b = normalizeUrl(incoming);
  return a === b || b.endsWith(a) || a.endsWith(b);
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

// ── POST /api/track/view ──────────────────────────────────────────────────
// Called server-side from /t/:slug (already handled there),
// but can also be called from the client if needed.
router.post('/view', (req, res) => {
  res.json({ ok: true }); // view tracking happens in server.js at /t/:slug
});

// ── POST /api/track/conversion ────────────────────────────────────────────
router.post('/conversion', async (req, res) => {
  const db  = getDb();
  const { page_url, revenue_cents: revBody, cid: cidBody } = req.body;
  const revenueCents = Math.round(parseFloat(revBody) || 0);
  // Accept cid from cookie OR from body (cross-origin fallback)
  const cid = req.cookies?.cp_uid || cidBody;

  if (!cid) return res.json({ converted: 0 });

  const ua     = req.headers['user-agent'] || '';
  const ip     = getClientIp(req);
  const utmFromUrl = parseUtm(page_url);

  let converted = 0;
  const convertedTests = [];

  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();
  for (const t of tests) {
    if (!t.funnel_steps && !t.conversion_page_url) continue;

    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;

    // ── Funnel steps: checked on ANY page, independent of conversion URL ──
    if (t.funnel_steps) {
      try {
        const steps = JSON.parse(t.funnel_steps);
        steps.forEach((step, idx) => {
          if (!step.url || !urlsMatch(step.url, page_url || '')) return;
          const already = db.prepare(
            'SELECT id FROM funnel_events WHERE test_id = ? AND client_id = ? AND step_index = ?'
          ).get(t.id, cid, idx);
          if (!already) {
            db.prepare(
              'INSERT INTO funnel_events (test_id, variation_id, client_id, step_index) VALUES (?, ?, ?, ?)'
            ).run(t.id, ix.variation_id, cid, idx);
            logger.info('Funnel step recorded', { test: t.name, step: step.url, idx, cid: cid.slice(0, 8) });
          }
        });
      } catch (e) {
        logger.warn('Funnel steps parse error', { test: t.name, error: e.message });
      }
    }

    // ── Conversion: only when page matches the configured conversion URL ──
    if (!t.conversion_page_url) continue;
    if (!urlsMatch(t.conversion_page_url, page_url || '')) continue;

    // Record conversion
    db.prepare(
      "UPDATE interactions SET type = 'conversion', revenue_cents = ? WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).run(revenueCents, t.id, cid);

    converted++;
    convertedTests.push(t);

    // ── GA4 Measurement Protocol — server-side conversion ──────────────────
    if (t.ga4_measurement_id && t.ga4_api_secret) {
      const variation = db.prepare('SELECT * FROM variations WHERE id = ?').get(ix.variation_id);
      fetch(
        `https://www.google-analytics.com/mp/collect?measurement_id=${t.ga4_measurement_id}&api_secret=${t.ga4_api_secret}`,
        {
          method: 'POST',
          body: JSON.stringify({
            client_id: cid,
            events: [{
              name: 'ab_test_conversion',
              params: {
                test_id: String(t.id),
                test_name: t.name,
                variation_id: String(ix.variation_id),
                variation_name: variation?.name || '',
                page_url,
              },
            }],
          }),
        }
      ).catch(e => logger.warn('GA4 MP conversion error', { msg: e.message }));
    }
  }

  // ── Meta CAPI — server-side conversion ────────────────────────────────────
  if (converted > 0) {
    const { meta_pixel_id, meta_access_token, meta_test_event_code } = getSettings(
      'meta_pixel_id', 'meta_access_token', 'meta_test_event_code'
    );

    if (meta_pixel_id && meta_access_token) {
      const variation = convertedTests[0] ? db.prepare(
        'SELECT * FROM interactions WHERE test_id = ? AND client_id = ?'
      ).get(convertedTests[0].id, cid) : null;

      sendEvent({
        pixelId:        meta_pixel_id,
        accessToken:    meta_access_token,
        eventName:      'Lead',
        eventSourceUrl: page_url,
        clientIp:       ip,
        clientUserAgent: ua,
        clientId:       cid,
        fbc:            req.cookies?._fbc,
        fbp:            req.cookies?._fbp,
        eventId:        `conv_${cid}_${Date.now()}`,
        customData: {
          currency: 'BRL',
          test_names: convertedTests.map(t => t.name).join(','),
        },
        testMode: !!meta_test_event_code,
      }).catch(() => {});
    }
  }

  logger.debug('Conversion tracked', { cid, page_url, converted });
  res.json({ converted });
});

// ── POST /api/track/event ─────────────────────────────────────────────────
// Generic custom event tracker (future: scroll depth, clicks, time on page)
router.post('/event', (req, res) => {
  const { event_name, test_id, variation_id } = req.body;
  const cid = req.cookies?.cp_uid;
  if (!cid || !event_name) return res.json({ ok: false });
  logger.debug('Custom event', { event_name, test_id, variation_id, cid });
  res.json({ ok: true });
});

module.exports = router;
