const express = require('express');
const router  = express.Router();
const { getDb } = require('../lib/database');
const logger    = require('../lib/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

function extractCid(body) {
  // 1. Try payload.data.utms array (The Members passes UTMs/custom params here)
  const utms = body?.payload?.data?.utms || body?.data?.utms || [];
  if (Array.isArray(utms)) {
    for (const u of utms) {
      const val = u?.cp_uid || u?.utm_content || u?.utm_term || u?.value;
      if (val && val.length > 8) return val;
    }
    // Also check if utms is array of {key, value} pairs
    for (const u of utms) {
      if ((u?.key === 'cp_uid' || u?.name === 'cp_uid') && u?.value) return u.value;
    }
  }

  // 2. Try query string (GET postback fallback)
  return null;
}

function getEvent(body) {
  return body?.payload?.event || body?.event || '';
}

// Events that mean "conversion confirmed"
const CONVERSION_EVENTS = new Set([
  'transaction.approved',
  'release.access',
  'order.completed',
]);

// ── POST /api/webhook/the-members ─────────────────────────────────────────
router.post('/the-members', express.json(), (req, res) => {
  const db = getDb();

  // Validate x-signature header
  const token = process.env.THE_MEMBERS_WEBHOOK_TOKEN;
  if (token) {
    const sig = req.headers['x-signature'];
    if (sig !== token) {
      logger.warn('The Members webhook: invalid signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = getEvent(req.body);
  logger.info('The Members webhook received', { event });

  // Only process confirmed conversion events
  if (!CONVERSION_EVENTS.has(event)) {
    return res.json({ ok: true, skipped: true, event });
  }

  // Extract cp_uid from UTMs passed through checkout link
  let cid = extractCid(req.body) || req.query.cid || req.query.cp_uid;

  if (!cid) {
    logger.warn('The Members webhook: no cp_uid found in payload', { event, body: JSON.stringify(req.body).slice(0, 300) });
    return res.json({ ok: true, converted: 0, reason: 'cp_uid not found — make sure checkout link has ?cp_uid= parameter' });
  }

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
    logger.info('The Members webhook: conversion registered', {
      cid: cid.slice(0, 8), test: t.name, event,
    });
  }

  res.json({ ok: true, converted, event });
});

// ── Generic GET/POST /api/webhook/conversion ──────────────────────────────
// Manual postback or other platforms
router.post('/conversion', express.json(), (req, res) => {
  const db = getDb();

  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.query.secret || req.body?.secret;
    if (provided !== secret) return res.status(401).json({ error: 'Unauthorized' });
  }

  const cid = req.query.cid || req.query.cp_uid || req.body?.cid || req.body?.cp_uid;
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
    logger.info('Webhook conversion registered', { cid: cid.slice(0, 8) });
  }

  res.json({ ok: true, converted });
});

router.get('/conversion', (req, res) => {
  const db = getDb();

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

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
  }

  res.json({ ok: true, converted });
});

module.exports = router;
