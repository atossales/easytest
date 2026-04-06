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
// Body: { period: 'morning'|'evening', number?: '5511...', days?: 1|3|7|30 }
router.post('/test-send', express.json(), async (req, res) => {
  const { period, number, days } = req.body || {};
  const target = number || getSetting('wa_number_1');
  if (!target) return res.status(400).json({ error: 'Número não configurado' });

  try {
    const text = await buildReportText(period || 'morning', days || 1);
    const r    = await sendMessage(target, text);
    res.json({ ok: r.ok, detail: r });
  } catch (e) {
    logger.error('WhatsApp test-send failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-now — force send to all numbers
// Body: { period?: string, days?: 1|3|7|30 }
router.post('/send-now', express.json(), async (req, res) => {
  try {
    await sendDailyReport(req.body?.period || 'manual', req.body?.days || 1);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/whatsapp/send-text — send arbitrary text to all configured numbers
// Body: { text: string }
router.post('/send-text', express.json(), async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text é obrigatório' });

  const nums = [getSetting('wa_number_1'), getSetting('wa_number_2')].filter(Boolean);
  if (!nums.length) return res.status(400).json({ error: 'Nenhum número configurado' });

  const results = [];
  for (const num of nums) {
    const r = await sendMessage(num, text);
    results.push({ num: num.slice(0, 4) + '****', ok: r.ok });
    logger.info('send-text dispatched', { num: num.slice(0, 4) + '****', ok: r.ok });
  }
  res.json({ ok: true, results });
});

// GET /api/whatsapp/preview — preview the report message text
// Query: ?period=morning&days=7
router.get('/preview', async (req, res) => {
  try {
    const text = await buildReportText(req.query.period || 'morning', req.query.days || 1);
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
