const express = require('express');
const router  = express.Router();
const { getDb } = require('../lib/database');
const { analyzeVariations, minSampleSize } = require('../lib/statistics');

const COLORS = ['#0065FF','#00C48C','#FF6B6B','#FFB84D','#A855F7','#06B6D4','#F43F5E','#10B981','#8B5CF6','#EC4899'];

function safeRange(r) {
  const n = parseInt(r);
  return isNaN(n) ? null : n;
}

// Supports: range (days), OR start+end (YYYY-MM-DD)
function dateFilter(range, alias = 'created_at', start = null, end = null) {
  if (start && end) {
    // Validate format to prevent injection
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (re.test(start) && re.test(end)) {
      // Use BRT (UTC-3) so "Hoje" and "Ontem" match the user's timezone
      return `AND DATE(datetime(${alias},'-3 hours')) BETWEEN '${start}' AND '${end}'`;
    }
  }
  const n = safeRange(range);
  return n ? `AND ${alias} >= datetime('now','-${n} days')` : '';
}

// Always exclude bots from reports
const NO_BOT = 'AND COALESCE(is_bot, 0) = 0';

// GET /api/reports
router.get('/', (req, res) => {
  const db   = getDb();
  const df   = dateFilter(req.query.range || '30', 'i.created_at', req.query.start, req.query.end);
  const tests = db.prepare('SELECT * FROM tests ORDER BY created_at DESC').all();

  // BRT today/yesterday for delta KPIs
  const todayStr     = new Date(Date.now() - 3*60*60*1000).toISOString().split('T')[0];
  const yesterdayStr = new Date(Date.now() - 3*60*60*1000 - 86400000).toISOString().split('T')[0];
  const dfToday = `AND DATE(datetime(created_at,'-3 hours'))='${todayStr}' ${NO_BOT}`;
  const dfYest  = `AND DATE(datetime(created_at,'-3 hours'))='${yesterdayStr}' ${NO_BOT}`;
  const revToday = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE type='conversion' ${dfToday}`).get().r || 0;
  const revYest  = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE type='conversion' ${dfYest}`).get().r || 0;

  const overview = tests.map(t => {
    const views       = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id = ? ${df} ${NO_BOT}`).get(t.id).c || 0;
    const conversions = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id = ? AND i.type = 'conversion' ${df} ${NO_BOT}`).get(t.id).c || 0;
    const revenue     = db.prepare(`SELECT COALESCE(SUM(i.revenue_cents),0) AS r FROM interactions i WHERE i.test_id = ? AND i.type = 'conversion' ${df} ${NO_BOT}`).get(t.id).r || 0;

    // Variation breakdown for dashboard cards (ctrl + best_variation)
    const vars = db.prepare('SELECT * FROM variations WHERE test_id = ? AND COALESCE(active,1)=1 ORDER BY id').all(t.id);
    const varStats = vars.map(v => {
      const vv = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id=? AND i.variation_id=? ${df} ${NO_BOT}`).get(t.id, v.id).c || 0;
      const vc = db.prepare(`SELECT COUNT(*) AS c FROM interactions i WHERE i.test_id=? AND i.variation_id=? AND i.type='conversion' ${df} ${NO_BOT}`).get(t.id, v.id).c || 0;
      return { ...v, views: vv, conversions: vc, conversion_rate: +(vv > 0 ? (vc/vv*100).toFixed(2) : 0) };
    });
    const enriched    = analyzeVariations(varStats);
    const ctrl        = enriched.find(v => v.isControl) || enriched[0] || null;
    const bestVar     = [...enriched].filter(v => !v.isControl && v.views > 0)
      .sort((a, b) => b.conversion_rate - a.conversion_rate)[0] || null;

    return { ...t, views, conversions, conversion_rate: +(views > 0 ? (conversions / views * 100).toFixed(2) : 0), revenue_cents: revenue, ctrl, best_variation: bestVar };
  });

  const ranking = [...overview].filter(t => t.views > 0).sort((a, b) => b.conversion_rate - a.conversion_rate).map(t => ({
    ...t, total_revenue_cents: t.revenue_cents,
  }));
  const tv = overview.reduce((s, t) => s + t.views, 0);
  const tc = overview.reduce((s, t) => s + t.conversions, 0);
  const tr = overview.reduce((s, t) => s + (t.revenue_cents || 0), 0);

  res.json({
    tests: overview,
    ranking,
    totals: {
      total_tests:              tests.length,
      active_tests:             tests.filter(t => t.active).length,
      total_views:              tv,
      total_conversions:        tc,
      overall_rate:             tv > 0 ? (tc / tv * 100).toFixed(2) : '0.00',
      total_revenue_cents:      tr,
      revenue_today_cents:      revToday,
      revenue_yesterday_cents:  revYest,
    },
  });
});

// GET /api/reports/:id
router.get('/:id', (req, res) => {
  const db    = getDb();
  const { id } = req.params;
  const range = req.query.range || '30';
  const { start, end } = req.query;
  const df    = dateFilter(range, 'created_at', start, end);
  const cdf   = dateFilter(range, 'i.created_at', start, end);

  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  if (!test) return res.status(404).json({ error: 'Não encontrado' });

  const vars = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(id);

  // Per-variation stats
  const stats = vars.map(v => {
    const views       = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id = ? AND variation_id = ? ${df} ${NO_BOT}`).get(id, v.id).c || 0;
    const conversions = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id = ? AND variation_id = ? AND type = 'conversion' ${df} ${NO_BOT}`).get(id, v.id).c || 0;
    const revenue     = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id = ? AND variation_id = ? AND type = 'conversion' ${df} ${NO_BOT}`).get(id, v.id).r || 0;
    return { ...v, views, conversions, conversion_rate: +(views > 0 ? (conversions / views * 100).toFixed(2) : 0), revenue_cents: revenue };
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
    FROM interactions WHERE test_id = ? ${df} ${NO_BOT}
    GROUP BY device ORDER BY count DESC
  `).all(id);

  // UTM breakdown completo — source+medium+campaign top 20
  const utmSources = db.prepare(`
    SELECT
      CASE WHEN utm_source IS NULL AND (referrer IS NULL OR referrer = '') THEN 'direct'
           WHEN utm_source IS NULL THEN 'organic'
           ELSE utm_source END AS source,
      COALESCE(utm_medium, '') AS medium,
      COALESCE(utm_campaign, '') AS campaign,
      COALESCE(utm_term, '') AS term,
      COALESCE(utm_content, '') AS content,
      COUNT(*) AS views,
      COUNT(CASE WHEN type = 'conversion' THEN 1 END) AS conversions
    FROM interactions WHERE test_id = ? ${df} ${NO_BOT}
    GROUP BY utm_source, utm_medium, utm_campaign, utm_term, utm_content
    ORDER BY views DESC LIMIT 20
  `).all(id);

  // Campanha breakdown
  const utmCampaigns = db.prepare(`
    SELECT
      COALESCE(utm_campaign, '(sem campanha)') AS campaign,
      COALESCE(utm_source, 'organic') AS source,
      COUNT(*) AS views,
      COUNT(CASE WHEN type = 'conversion' THEN 1 END) AS conversions
    FROM interactions WHERE test_id = ? AND utm_campaign IS NOT NULL ${df} ${NO_BOT}
    GROUP BY utm_campaign, utm_source
    ORDER BY views DESC LIMIT 10
  `).all(id);

  // Canal de tráfego + click IDs
  const trafficChannels = db.prepare(`
    SELECT
      CASE
        WHEN fbclid IS NOT NULL THEN 'Meta Ads'
        WHEN gclid  IS NOT NULL THEN 'Google Ads'
        WHEN ttclid IS NOT NULL THEN 'TikTok Ads'
        WHEN utm_medium IN ('cpc','ppc','paid','paid_social','paid-social') THEN 'Pago'
        WHEN utm_medium IN ('email','newsletter') THEN 'Email'
        WHEN utm_medium IN ('social','social-media') THEN 'Social Orgânico'
        WHEN utm_source IS NULL AND (referrer IS NULL OR referrer = '') THEN 'Direto'
        WHEN utm_source IS NOT NULL THEN 'Campanha'
        ELSE 'Orgânico'
      END AS channel,
      COUNT(*) AS views,
      COUNT(CASE WHEN type = 'conversion' THEN 1 END) AS conversions
    FROM interactions WHERE test_id = ? ${df} ${NO_BOT}
    GROUP BY channel ORDER BY views DESC
  `).all(id);

  // Click IDs summary (Meta/Google/TikTok)
  const clickIds = db.prepare(`
    SELECT
      COUNT(CASE WHEN fbclid IS NOT NULL THEN 1 END) AS meta_clicks,
      COUNT(CASE WHEN gclid  IS NOT NULL THEN 1 END) AS google_clicks,
      COUNT(CASE WHEN ttclid IS NOT NULL THEN 1 END) AS tiktok_clicks
    FROM interactions WHERE test_id = ? ${df} ${NO_BOT}
  `).get(id);

  const tv = enrichedStats.reduce((s, v) => s + v.views, 0);
  const tc = enrichedStats.reduce((s, v) => s + v.conversions, 0);
  const tr = enrichedStats.reduce((s, v) => s + (v.revenue_cents || 0), 0);

  // Funnel — always 4 fixed stages: Visitas, Cadastros, Init. Checkout, Conversões
  // funnel_steps index 0 = Cadastros URL, index 1 = Initiate Checkout URL
  const FUNNEL_STAGES = ['Visitas', 'Cadastros', 'Initiate Checkout', 'Conversões'];

  const varFunnels = enrichedStats.map(v => {
    const cadastros  = db.prepare('SELECT COUNT(DISTINCT client_id) AS c FROM funnel_events WHERE test_id = ? AND variation_id = ? AND step_index = 0').get(id, v.id).c || 0;
    const initChk    = db.prepare('SELECT COUNT(DISTINCT client_id) AS c FROM funnel_events WHERE test_id = ? AND variation_id = ? AND step_index = 1').get(id, v.id).c || 0;
    const counts = [v.views, cadastros, initChk, v.conversions];
    const max = counts[0] || 1;
    return {
      id: v.id,
      name: v.name,
      stages: counts.map((count, i) => ({
        name: FUNNEL_STAGES[i],
        count,
        pct: +(max > 0 ? (count / max * 100).toFixed(1) : 0),
      })),
      abandono: v.views - v.conversions,
    };
  });

  // Overall funnel (sum across all variations)
  const overallCounts = [0, 1, 2, 3].map(si =>
    varFunnels.reduce((sum, v) => sum + (v.stages[si]?.count || 0), 0)
  );
  const overallMax = overallCounts[0] || 1;
  const overallFunnel = {
    stages: overallCounts.map((count, i) => ({
      name: FUNNEL_STAGES[i],
      count,
      pct: +(overallMax > 0 ? (count / overallMax * 100).toFixed(1) : 0),
    })),
    abandono: overallCounts[0] - overallCounts[3],
  };

  const funnel = { stages: FUNNEL_STAGES, overall: overallFunnel, variations: varFunnels };

  res.json({
    test,
    summary: {
      total_views:             tv,
      total_conversions:       tc,
      total_revenue_cents:     tr,
      overall_conversion_rate: +(tv > 0 ? (tc / tv * 100).toFixed(2) : 0),
      sample_needed:           sampleHint,
    },
    variations: enrichedStats,
    winner,
    chart: {
      labels,
      datasets: Object.values(ds).map(d => ({ ...d, data: labels.map(l => d.data[l] || 0) })),
    },
    breakdown: { devices, utmSources, utmCampaigns, trafficChannels, clickIds },
    funnel,
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
