const express = require('express');
const router = express.Router();
const { getDb } = require('../lib/database');

router.get('/', (req, res) => {
  const db = getDb();
  const range = req.query.range || '30';
  const df = range !== 'all' ? `AND i.created_at >= datetime('now','-${parseInt(range)} days')` : '';
  const tests = db.prepare('SELECT * FROM tests ORDER BY created_at DESC').all();
  const overview = tests.map(t => {
    const v = db.prepare(`SELECT COUNT(*) as c FROM interactions i WHERE i.test_id=? ${df}`).get(t.id).c || 0;
    const c = db.prepare(`SELECT COUNT(*) as c FROM interactions i WHERE i.test_id=? AND i.type='conversion' ${df}`).get(t.id).c || 0;
    return { ...t, views: v, conversions: c, conversion_rate: +(v > 0 ? (c / v * 100).toFixed(2) : 0) };
  });
  const ranking = [...overview].filter(t => t.views > 0).sort((a, b) => b.conversion_rate - a.conversion_rate);
  const tv = overview.reduce((s, t) => s + t.views, 0), tc = overview.reduce((s, t) => s + t.conversions, 0);
  res.json({ tests: overview, ranking, totals: { total_tests: tests.length, active_tests: tests.filter(t => t.active).length, total_views: tv, total_conversions: tc, overall_rate: tv > 0 ? (tc / tv * 100).toFixed(2) : '0.00' } });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const range = req.query.range || '30';
  const test = db.prepare('SELECT * FROM tests WHERE id=?').get(id);
  if (!test) return res.status(404).json({ error: 'Not found' });
  const vars = db.prepare('SELECT * FROM variations WHERE test_id=? ORDER BY id').all(id);
  const df = range !== 'all' ? `AND created_at >= datetime('now','-${parseInt(range)} days')` : '';
  const stats = vars.map(v => {
    const vw = db.prepare(`SELECT COUNT(*) as c FROM interactions WHERE test_id=? AND variation_id=? ${df}`).get(id, v.id).c || 0;
    const cv = db.prepare(`SELECT COUNT(*) as c FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' ${df}`).get(id, v.id).c || 0;
    return { ...v, views: vw, conversions: cv, conversion_rate: +(vw > 0 ? (cv / vw * 100).toFixed(2) : 0) };
  });
  const cdf = range !== 'all' ? `AND i.created_at >= datetime('now','-${parseInt(range)} days')` : '';
  const rows = db.prepare(`SELECT v.name AS vn, DATE(i.created_at) AS d, COUNT(*) AS t, COUNT(CASE WHEN i.type='conversion' THEN 1 END) AS c
    FROM variations v JOIN interactions i ON v.id=i.variation_id WHERE i.test_id=? ${cdf} GROUP BY v.name,d ORDER BY d`).all(id);
  const labels = [...new Set(rows.map(r => r.d))].sort();
  const colors = ['#0065FF','#00C48C','#FF6B6B','#FFB84D','#A855F7','#06B6D4','#F43F5E','#10B981','#8B5CF6','#EC4899'];
  const ds = {}; rows.forEach(r => { if (!ds[r.vn]) { const i = Object.keys(ds).length; ds[r.vn] = { label: r.vn, data: {}, backgroundColor: colors[i % colors.length], borderColor: colors[i % colors.length] }; } ds[r.vn].data[r.d] = r.t; });
  const tv = stats.reduce((s, v) => s + v.views, 0), tc = stats.reduce((s, v) => s + v.conversions, 0);
  res.json({ test, summary: { total_views: tv, total_conversions: tc, overall_conversion_rate: +(tv > 0 ? (tc / tv * 100).toFixed(2) : 0) },
    variations: stats, chart: { labels, datasets: Object.values(ds).map(d => ({ ...d, data: labels.map(l => d.data[l] || 0) })) } });
});

module.exports = router;
