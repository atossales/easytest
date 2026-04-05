const express = require('express');
const router  = express.Router();
const { getSetting, setSetting } = require('../lib/database');

const ALLOWED_KEYS = [
  'meta_pixel_id',
  'meta_access_token',
  'meta_test_event_code',
  'ga4_property_id',
  'ga4_service_account',
  'site_url',
  // AI + WhatsApp (managed via /api/ai and /api/whatsapp routes)
  'ai_system_prompt',
  'wa_enabled', 'wa_number_1', 'wa_number_2',
  'wa_morning_time', 'wa_evening_time', 'wa_message_template',
];

// GET /api/settings
router.get('/', (req, res) => {
  const result = {};
  for (const k of ALLOWED_KEYS) {
    let v = getSetting(k);
    // Mask sensitive values
    if (k === 'meta_access_token' && v) v = v.slice(0, 6) + '••••••••••••' + v.slice(-4);
    if (k === 'ga4_service_account' && v) {
      try { const p = JSON.parse(v); v = { client_email: p.client_email, masked: true }; } catch { v = null; }
    }
    result[k] = v;
  }
  res.json(result);
});

// POST /api/settings — save one or more keys
router.post('/', (req, res) => {
  const saved = [];
  for (const [k, v] of Object.entries(req.body)) {
    if (!ALLOWED_KEYS.includes(k)) continue;
    setSetting(k, v || null);
    saved.push(k);
  }
  res.json({ saved });
});

// DELETE /api/settings/:key
router.delete('/:key', (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.includes(key)) return res.status(400).json({ error: 'Chave inválida' });
  setSetting(key, null);
  res.json({ deleted: key });
});

module.exports = router;
