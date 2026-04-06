const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getDb } = require('../lib/database');
const logger    = require('../lib/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

function extractCid(body) {
  // 1. Try all known UTM array locations (The Members passes UTMs as [{name, value}])
  // transaction.approved → body.data.order.utms
  // other events         → body.data.utms or body.payload.data.utms
  const utms =
    body?.data?.order?.utms ||
    body?.payload?.data?.utms ||
    body?.data?.utms ||
    [];
  if (Array.isArray(utms)) {
    for (const u of utms) {
      if ((u?.key === 'cp_uid' || u?.name === 'cp_uid') && u?.value) return u.value;
    }
  }

  // 2. Try top-level cp_uid fields
  const direct = body?.cp_uid || body?.data?.cp_uid || body?.payload?.cp_uid;
  if (direct) return direct;

  return null;
}

function getEvent(body) {
  return body?.payload?.event || body?.event || '';
}

// Extract sale amount in cents from The Members payload
// The Members sends amounts in BRL (reais), e.g. 97.00 for R$97
// We multiply by 100 to convert to cents
function extractRevenueCents(body) {
  const toC = v => (v > 0 ? Math.round(parseFloat(v) * 100) : 0);

  // transaction.approved: data.order.transaction.amount (in BRL)
  const fromTx = body?.data?.order?.transaction?.amount ||
                 body?.data?.order?.transaction?.total_amount;
  if (fromTx > 0) return toC(fromTx);
  // release.access: data.order.total (in BRL)
  const fromOrder = body?.data?.order?.total || body?.data?.total;
  if (fromOrder > 0) return toC(fromOrder);
  // payload wrapper
  const fromPayload = body?.payload?.data?.transaction?.amount;
  if (fromPayload > 0) return toC(fromPayload);
  return 0;
}

function isConversionEvent(event) {
  if (!event) return false;
  const e = event.toLowerCase();
  return e.includes('approv') || e.includes('aprovad') ||
         e.includes('acesso') || e.includes('access') ||
         e.includes('completed') || e.includes('concluíd') ||
         e.includes('compra');
}

// Returns 0 for Cadastros, 1 for Initiate Checkout, null if not a funnel event
function getFunnelStepIndex(event) {
  if (!event) return null;
  const e = event.toLowerCase();
  // Cadastro / lead / registro
  if (e.includes('lead') || e.includes('cadastr') || e.includes('registr') ||
      e.includes('subscrib') || e.includes('signup') || e.includes('sign_up') ||
      e.includes('optin') || e.includes('opt_in')) return 0;
  // Initiate checkout
  if (e.includes('checkout') || e.includes('cart') || e.includes('carrinho') ||
      e.includes('initiat') || e.includes('order')) return 1;
  return null;
}

// ── POST /api/webhook/the-members ─────────────────────────────────────────
router.post('/the-members', express.json(), (req, res) => {
  const db = getDb();

  // Validate x-signature header (timing-safe comparison to prevent timing attacks)
  const token = process.env.THE_MEMBERS_WEBHOOK_TOKEN;
  if (token) {
    const sig = req.headers['x-signature'] || '';
    const sigBuffer = Buffer.from(sig);
    const expBuffer = Buffer.from(token);
    if (sigBuffer.length !== expBuffer.length || !crypto.timingSafeEqual(sigBuffer, expBuffer)) {
      logger.warn('The Members webhook: invalid signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const event = getEvent(req.body);
  logger.info('The Members webhook received', { event, body: JSON.stringify(req.body).slice(0, 2000) });

  // Extract cp_uid from UTMs passed through checkout link
  let cid = extractCid(req.body) || req.query.cid || req.query.cp_uid;

  if (!cid) {
    logger.warn('The Members webhook: no cp_uid found in payload', { event, body: JSON.stringify(req.body).slice(0, 300) });
    return res.json({ ok: true, converted: 0, funnel: 0, reason: 'cp_uid not found — make sure checkout link has ?cp_uid= parameter' });
  }

  const isConversion = isConversionEvent(event);
  const funnelStepIdx = isConversion ? null : getFunnelStepIndex(event);
  const revenueCents  = isConversion ? extractRevenueCents(req.body) : 0;

  // Skip events that are neither conversion nor funnel steps
  if (!isConversion && funnelStepIdx === null) {
    return res.json({ ok: true, skipped: true, event });
  }

  let converted = 0;
  let funnelRecorded = 0;
  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();

  for (const t of tests) {
    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;

    if (isConversion) {
      db.prepare(
        "UPDATE interactions SET type = 'conversion', revenue_cents = ? WHERE test_id = ? AND client_id = ? AND type = 'view'"
      ).run(revenueCents, t.id, cid);
      converted++;
      logger.info('The Members webhook: conversion registered', {
        cid: cid.slice(0, 8), test: t.name, event, revenue_cents: revenueCents,
      });
    } else if (funnelStepIdx !== null) {
      const already = db.prepare(
        'SELECT id FROM funnel_events WHERE test_id = ? AND client_id = ? AND step_index = ?'
      ).get(t.id, cid, funnelStepIdx);
      if (!already) {
        db.prepare(
          'INSERT INTO funnel_events (test_id, variation_id, client_id, step_index) VALUES (?, ?, ?, ?)'
        ).run(t.id, ix.variation_id, cid, funnelStepIdx);
        funnelRecorded++;
        logger.info('The Members webhook: funnel step recorded', {
          cid: cid.slice(0, 8), test: t.name, event, step: funnelStepIdx,
        });
      }
    }
  }

  res.json({ ok: true, converted, funnel: funnelRecorded, event });
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

  const revenueCents = Math.round(parseFloat(req.body?.revenue_cents || req.body?.amount || 0) || 0);

  let converted = 0;
  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();
  for (const t of tests) {
    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;
    db.prepare(
      "UPDATE interactions SET type = 'conversion', revenue_cents = ? WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).run(revenueCents, t.id, cid);
    converted++;
    logger.info('Webhook conversion registered', { cid: cid.slice(0, 8), revenue_cents: revenueCents });
  }

  res.json({ ok: true, converted });
});

router.get('/conversion', (req, res) => {
  const db = getDb();

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.query.secret !== secret) return res.status(401).json({ error: 'Unauthorized' });

  const cid = req.query.cid || req.query.cp_uid;
  if (!cid) return res.json({ converted: 0, error: 'cid is required' });

  const revenueCents = Math.round(parseFloat(req.query.revenue_cents || req.query.amount || 0) || 0);

  let converted = 0;
  const tests = db.prepare('SELECT * FROM tests WHERE active = 1').all();
  for (const t of tests) {
    const ix = db.prepare(
      "SELECT * FROM interactions WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).get(t.id, cid);
    if (!ix) continue;
    db.prepare(
      "UPDATE interactions SET type = 'conversion', revenue_cents = ? WHERE test_id = ? AND client_id = ? AND type = 'view'"
    ).run(revenueCents, t.id, cid);
    converted++;
  }

  res.json({ ok: true, converted });
});

module.exports = router;
