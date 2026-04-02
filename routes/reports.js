const express = require('express');
const router  = express.Router();
const { getDb } = require('../lib/database');
const { analyzeVariations, minSampleSize } = require('../lib/statistics');

const COLORS = ['#0065FF','#00C48C','#FF6B6B','#FFB84D','#A855F7','#06B6D4','#F43F5E','#10B981','#8B5CF6','#EC4899'];

function safeRange(r) {
  const n = parseInt(r);
  return isNaN(n) ? null : n;
}

function dateFilter(range, alias = 'created_at') {
  const n = safeRange(range);
  return n ? `AND ${alias} >= datetime('now','-${n} days')` : '';
}

// GET /api/reports
router.get('/', (req, res) => {
  const db   = getDb();
  const df   = dateFilter(req.query.range || '30', 'i.created_at');
  const tests = db.prepare('SELECT * FROM tests ORDER BY created_at DESC').all();

  const overview = tests.map(t => {
    const views       = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id = ? ${df}`).get(t.id).c || 0;
    const conversions = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id = ? AND i.type = 'conversion' ${df}`).get(t.id).c || 0;
    return { ...t, views, conversions, conversion_rate: +(views > 0 ? (conversions / views * 100).toFixed(2) : 0) };
  });

  const ranking = [...overview].filter(t => t.views > 0).sort((a, b) => b.conversion_rate - a.conversion_rate);
  const tv = overview.reduce((s, t) => s + t.views, 0);
  const tc = overview.reduce((s, t) => s + t.conversions, 0);

  res.json({
    tests: overview,
    ranking,
    totals: {
      total_tests:      tests.length,
      active_tests:     tests.filter(t => t.active).length,
      total_views:      tv,
      total_conversions: tc,
      overall_rate:     tv > 0 ? (tc / tv * 100).toFixed(2) : '0.00',
    },
  });
});

// GET /api/reports/:id
router.get('/:id', (req, res) => {
  const db    = getDb();
  const { id } = req.params;
  const range = req.query.range || '30';
  const df    = dateFilter(range);
  const cdf   = dateFilter(range, 'i.created_at');

  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  if (!test) return res.status(404).json({ error: 'Não encontrado' });

  const vars = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(id);

  // Per-variation stats
  const stats = vars.map(v => {
    const views       = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id = ? AND variation_id = ? ${df}`).get(id, v.id).c || 0;
    const conversions = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id = ? AND variation_id = ? AND type = 'conversion' ${df}`).get(id, v.id).c || 0;
    return { ...v, views, conversions, conversion_rate: +(views > 0 ? (conversions / views * 100).toFixed(2) : 0) };
  });

  // Statistical significance vs control (first variation)
  const enrichedStats = analyzeVariations(stats);

  // Winner
  const winner = [...enrichedStats].sort((a, b) => b.conversion_rate - a.conversion_rate)[0] || null;

  // Minimum sample size hint (based on control's current rate + 20% MDE)
  const control   = enrichedStats[0];
  const sampleHint = control?.views > 0
    ? minSampleSize(control.conversions / control.views, 0.20)
    : null;

  // Time-series chart data
  const rows = db.prepare(`
    SELECT v.name AS vn, DATE(i.created_at) AS d,
           COUNT(*) AS total,
           COUNT(CASE WHEN i.type = 'conversion' THEN 1 END) AS convs
    FROM variations v
    JOIN interactions i ON v.id = i.variation_id
    WHERE i.test_id = ? ${cdf}
    GROUP BY v.name, d
    ORDER BY d
  `).all(id);

  const labels = [...new Set(rows.map(r => r.d))].sort();
  const ds     = {};
  rows.forEach(r => {
    if (!ds[r.vn]) {
      const idx    = Object.keys(ds).length;
      ds[r.vn]     = { label: r.vn, data: {}, backgroundColor: COLORS[idx % COLORS.length], borderColor: COLORS[idx % COLORS.length] };
    }
    ds[r.vn].data[r.d] = r.total;
  });

  // Device breakdown
  const devices = db.prepare(`
    SELECT COALESCE(device_type, 'unknown') AS device, COUNT(*) AS count
    FROM interactions WHERE test_id = ? ${df}
    GROUP BY device ORDER BY count DESC
  `).all(id);

  // UTM breakdown (top 10 sources)
  const utmSources = db.prepare(`
    SELECT COALESCE(utm_source, 'direct') AS source,
           COALESCE(utm_medium, '') AS medium,
           COUNT(*) AS views,
           COUNT(CASE WHEN type = 'conversion' THEN 1 END) AS conversions
    FROM interactions WHERE test_id = ? ${df}
    GROUP BY utm_source, utm_medium
    ORDER BY views DESC LIMIT 10
  `).all(id);

  const tv = enrichedStats.reduce((s, v) => s + v.views, 0);
  const tc = enrichedStats.reduce((s, v) => s + v.conversions, 0);

  res.json({
    test,
    summary: {
      total_views:             tv,
      total_conversions:       tc,
      overall_conversion_rate: +(tv > 0 ? (tc / tv * 100).toFixed(2) : 0),
      sample_needed:           sampleHint,
    },
    variations: enrichedStats,
    winner,
    chart: {
      labels,
      datasets: Object.values(ds).map(d => ({ ...d, data: labels.map(l => d.data[l] || 0) })),
    },
    breakdown: { devices, utmSources },
  });
});

// GET /api/reports/:id/export.csv
router.get('/:id/export.csv', (req, res) => {
  const db    = getDb();
  const { id } = req.params;
  const test  = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  if (!test) return res.status(404).send('Não encontrado');

  const rows = db.prepare(`
    SELECT i.id, i.client_id, i.type, v.name AS variation, i.device_type,
           i.utm_source, i.utm_medium, i.utm_campaign, i.referrer, i.created_at
    FROM interactions i
    JOIN variations v ON v.id = i.variation_id
    WHERE i.test_id = ?
    ORDER BY i.created_at DESC
  `).all(id);

  const headers = ['id','client_id','type','variation','device_type','utm_source','utm_medium','utm_campaign','referrer','created_at'];
  const csv = [
    headers.join(','),
    ...rows.map(r => headers.map(h => JSON.stringify(r[h] ?? '')).join(',')),
  ].join('\n');

  const filename = `easytest-${test.name.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

module.exports = router;
