const express = require('express');
const router  = express.Router();
const { getDb } = require('../lib/database');
const logger    = require('../lib/logger');

// ── POST /api/webhook/conversion ──────────────────────────────────────────
// Called by external checkout platforms (The Bank, Hotmart, Kiwify, etc.)
// when a sale is confirmed. The cid (cp_uid) must be passed as a query param
// or in the body — captured when visitor clicked the buy button.
//
// The Bank postback URL:
//   https://easytest.tanajuras.com/api/webhook/conversion?cid={cp_uid}&secret=SEU_SECRET
//
// Setup: set WEBHOOK_SECRET env var in EasyPanel to any random string.
// Then configure The Bank postback URL with that secret.

router.post('/conversion', (req, res) => {
  const db = getDb();

  // Secret validation (optional but recommended)
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.query.secret || req.body.secret;
    if (provided !== secret) {
      logger.warn('Webhook conversion: invalid secret');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  // Accept cid from query string or body
  const cid = req.query.cid || req.body.cid || req.body.cp_uid;
  if (!cid) {
    logger.warn('Webhook conversion: missing cid');
    return res.json({ converted: 0, error: 'cid is required' });
  }

  const pageUrl = req.query.page_url || req.body.page_url || '';

  let converted = 0;
  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();

  for (const t of tests) {
    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;

    db.prepare(
      "UPDATE interactions SET type = 'conversion' WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).run(t.id, cid);

    converted++;
    logger.info('Webhook conversion registered', { cid: cid.slice(0, 8), test: t.name });
  }

  res.json({ ok: true, converted });
});

// Also accept GET for platforms that only support GET postbacks
router.get('/conversion', (req, res) => {
  const db = getDb();

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const cid = req.query.cid || req.query.cp_uid;
  if (!cid) return res.json({ converted: 0, error: 'cid is required' });

  let converted = 0;
  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();

  for (const t of tests) {
    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;

    db.prepare(
      "UPDATE interactions SET type = 'conversion' WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).run(t.id, cid);

    converted++;
    logger.info('Webhook conversion registered (GET)', { cid: cid.slice(0, 8), test: t.name });
  }

  res.json({ ok: true, converted });
});

module.exports = router;
