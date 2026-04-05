const express = require('express');
const router  = express.Router();
const { getSetting, setSetting } = require('../lib/database');
const { sendMessage }            = require('../lib/whatsapp');
const { sendDailyReport, buildReportText } = require('../jobs/daily-report');
const logger = require('../lib/logger');

const WA_KEYS = [
  'wa_enabled',
  'wa_number_1',
  'wa_number_2',
  'wa_morning_time',
  'wa_evening_time',
  'wa_message_template',
];

// GET /api/whatsapp/config
router.get('/config', (req, res) => {
  const cfg = {};
  for (const k of WA_KEYS) cfg[k] = getSetting(k);
  // Mask numbers partially
  if (cfg.wa_number_1) cfg.wa_number_1_display = cfg.wa_number_1.slice(0, 4) + '****' + cfg.wa_number_1.slice(-4);
  if (cfg.wa_number_2) cfg.wa_number_2_display = cfg.wa_number_2.slice(0, 4) + '****' + cfg.wa_number_2.slice(-4);
  res.json(cfg);
});

// POST /api/whatsapp/config
router.post('/config', express.json(), (req, res) => {
  const allowed = WA_KEYS;
  for (const [k, v] of Object.entries(req.body)) {
    if (!allowed.includes(k)) continue;
    setSetting(k, v !== null && v !== '' ? String(v) : null);
  }
  logger.info('WhatsApp config updated');
  res.json({ ok: true });
});

// POST /api/whatsapp/test-send
// Body: { period: 'morning'|'evening', number?: '5511...' }
router.post('/test-send', express.json(), async (req, res) => {
  const { period, number } = req.body || {};
  const target = number || getSetting('wa_number_1');
  if (!target) return res.status(400).json({ error: 'Número não configurado' });

  try {
    const text = await buildReportText(period || 'morning');
    const r    = await sendMessage(target, text);
    res.json({ ok: r.ok, detail: r });
  } catch (e) {
    logger.error('WhatsApp test-send failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-now — force send to all numbers
router.post('/send-now', express.json(), async (req, res) => {
  try {
    await sendDailyReport(req.body?.period || 'manual');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/whatsapp/preview — preview the report message text
router.get('/preview', async (req, res) => {
  try {
    const text = await buildReportText(req.query.period || 'morning');
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
