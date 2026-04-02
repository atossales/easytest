const express = require('express');
const router = express.Router();
const { getSetting, setSetting } = require('../lib/database');
const { GoogleAuth } = require('google-auth-library');

// POST /api/ga4/connect — save GA4 credentials
router.post('/connect', (req, res) => {
  const { property_id, service_account_json } = req.body;
  if (!property_id) return res.status(400).json({ error: 'Property ID obrigatório' });
  if (!service_account_json) return res.status(400).json({ error: 'Service Account JSON obrigatório' });

  try {
    const parsed = typeof service_account_json === 'string' ? JSON.parse(service_account_json) : service_account_json;
    if (!parsed.client_email || !parsed.private_key) return res.status(400).json({ error: 'JSON inválido — precisa ter client_email e private_key' });
    setSetting('ga4_property_id', property_id);
    setSetting('ga4_service_account', JSON.stringify(parsed));
    res.json({ success: true, client_email: parsed.client_email });
  } catch (e) { res.status(400).json({ error: 'JSON inválido: ' + e.message }); }
});

// GET /api/ga4/status — check connection
router.get('/status', (req, res) => {
  const pid = getSetting('ga4_property_id');
  const sa = getSetting('ga4_service_account');
  if (!pid || !sa) return res.json({ connected: false });
  try {
    const parsed = JSON.parse(sa);
    res.json({ connected: true, property_id: pid, client_email: parsed.client_email });
  } catch { res.json({ connected: false }); }
});

// DELETE /api/ga4/disconnect
router.delete('/disconnect', (req, res) => {
  setSetting('ga4_property_id', null);
  setSetting('ga4_service_account', null);
  res.json({ success: true });
});

// GET /api/ga4/report — fetch data from GA4 Data API
router.get('/report', async (req, res) => {
  const pid = getSetting('ga4_property_id');
  const saJson = getSetting('ga4_service_account');
  if (!pid || !saJson) return res.status(400).json({ error: 'GA4 não conectado' });

  const range = req.query.range || '30';
  const startDate = range === 'all' ? '2020-01-01' : `${range}daysAgo`;

  try {
    const credentials = JSON.parse(saJson);
    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/analytics.readonly']
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    // Query GA4 Data API for ab_test events
    const body = {
      dateRanges: [{ startDate, endDate: 'today' }],
      dimensions: [
        { name: 'eventName' },
        { name: 'customEvent:test_id' },
        { name: 'customEvent:variation_name' }
      ],
      metrics: [
        { name: 'eventCount' },
        { name: 'conversions' }
      ],
      dimensionFilter: {
        orGroup: {
          expressions: [
            { filter: { fieldName: 'eventName', stringFilter: { value: 'ab_test_view' } } },
            { filter: { fieldName: 'eventName', stringFilter: { value: 'ab_test_conversion' } } }
          ]
        }
      }
    };

    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    // Parse response into clean format
    const events = (data.rows || []).map(row => ({
      event: row.dimensionValues[0]?.value,
      test_id: row.dimensionValues[1]?.value,
      variation: row.dimensionValues[2]?.value,
      count: parseInt(row.metricValues[0]?.value || '0'),
      conversions: parseInt(row.metricValues[1]?.value || '0')
    }));

    // Also fetch general metrics
    const generalBody = {
      dateRanges: [{ startDate, endDate: 'today' }],
      metrics: [
        { name: 'sessions' },
        { name: 'conversions' },
        { name: 'totalUsers' },
        { name: 'engagedSessions' }
      ]
    };

    const genResponse = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(generalBody)
    });

    const genData = await genResponse.json();
    const general = genData.rows?.[0]?.metricValues?.map((v, i) => ({
      metric: ['sessions', 'conversions', 'totalUsers', 'engagedSessions'][i],
      value: parseInt(v.value || '0')
    })) || [];

    res.json({ events, general, raw_rows: data.rowCount || 0 });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao consultar GA4: ' + e.message });
  }
});

// GET /api/ga4/realtime — basic realtime data
router.get('/realtime', async (req, res) => {
  const pid = getSetting('ga4_property_id');
  const saJson = getSetting('ga4_service_account');
  if (!pid || !saJson) return res.json({ active_users: 0 });

  try {
    const credentials = JSON.parse(saJson);
    const auth = new GoogleAuth({ credentials, scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
    const client = await auth.getClient();
    const token = await client.getAccessToken();

    const response = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runRealtimeReport`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metrics: [{ name: 'activeUsers' }] })
    });

    const data = await response.json();
    const activeUsers = parseInt(data.rows?.[0]?.metricValues?.[0]?.value || '0');
    res.json({ active_users: activeUsers });
  } catch { res.json({ active_users: 0 }); }
});

module.exports = router;
