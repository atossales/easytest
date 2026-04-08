const express = require('express');
const router  = express.Router();
const { getDb } = require('../lib/database');

// GET /api/notifications?since=ISO_TIMESTAMP
router.get('/', (req, res) => {
  const db = getDb();

  // since = last visit timestamp from localStorage (sent by frontend)
  const sinceRaw = req.query.since ? new Date(req.query.since) : null;
  const sinceValid = sinceRaw && !isNaN(sinceRaw.getTime());
  const since = sinceValid ? sinceRaw : new Date(Date.now() - 24 * 60 * 60 * 1000);

  const sinceIso = since.toISOString();
  const notifications = [];

  // ── 1. Testes pausados automaticamente pelo Guard ─────────────────────────
  const paused = db.prepare(`
    SELECT id, name, auto_paused_at FROM tests WHERE auto_paused = 1
  `).all();

  for (const t of paused) {
    notifications.push({
      id:      'guard-' + t.id,
      type:    'guard',
      icon:    '⏸',
      title:   'Guard pausou um teste',
      message: '"' + t.name + '" foi pausado automaticamente por CR abaixo do limite.',
      time:    t.auto_paused_at,
      testId:  t.id,
      read:    false,
    });
  }

  // ── 2. Resumo de atividade desde a última visita ───────────────────────────
  const activityRows = db.prepare(`
    SELECT
      t.id, t.name,
      SUM(CASE WHEN i.type='view'       THEN 1 ELSE 0 END) AS new_views,
      SUM(CASE WHEN i.type='conversion' THEN 1 ELSE 0 END) AS new_convs
    FROM tests t
    LEFT JOIN interactions i
      ON i.test_id = t.id
      AND i.created_at >= ?
      AND COALESCE(i.is_bot,0) = 0
    WHERE t.active = 1
    GROUP BY t.id
    HAVING new_views > 0 OR new_convs > 0
    ORDER BY new_views DESC
  `).all(sinceIso);

  if (activityRows.length > 0) {
    const totalViews = activityRows.reduce((s, a) => s + (a.new_views || 0), 0);
    const totalConvs = activityRows.reduce((s, a) => s + (a.new_convs || 0), 0);
    const detailLines = activityRows.slice(0, 5).map(a =>
      '"' + a.name + '": +' + a.new_views + ' views, +' + a.new_convs + ' conv.'
    ).join(' · ');

    notifications.push({
      id:      'summary-since',
      type:    'summary',
      icon:    '📊',
      title:   'Atividade enquanto você estava fora',
      message: '+' + totalViews + ' views e +' + totalConvs + ' conversões. ' + detailLines,
      time:    new Date().toISOString(),
      testId:  null,
      read:    false,
    });
  }

  // ── 3. Testes sem dados há mais de 48h (possível problema de snippet) ──────
  const stale = db.prepare(`
    SELECT t.id, t.name,
      MAX(i.created_at) AS last_interaction
    FROM tests t
    LEFT JOIN interactions i ON i.test_id = t.id
    WHERE t.active = 1 AND COALESCE(t.auto_paused,0) = 0
    GROUP BY t.id
    HAVING last_interaction IS NULL
       OR last_interaction < datetime('now','-48 hours')
  `).all();

  for (const t of stale) {
    notifications.push({
      id:      'stale-' + t.id,
      type:    'stale',
      icon:    '⚠️',
      title:   'Teste sem visitas recentes',
      message: '"' + t.name + '" está ativo mas sem visitas nas últimas 48h. Verifique o snippet.',
      time:    t.last_interaction || new Date(Date.now() - 48 * 3600000).toISOString(),
      testId:  t.id,
      read:    false,
    });
  }

  // Sort: guard first, then summary, then stale — most recent first within each type
  const order = { guard: 0, summary: 1, stale: 2 };
  notifications.sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9));

  res.json({ notifications, since: sinceIso });
});

module.exports = router;
