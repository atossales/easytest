/**
 * Performance Guard — pausa automática de VARIAÇÕES com CR ruim.
 *
 * Opera no nível de variação, não de teste:
 *   - O teste continua ativo; só a variação ruim é pausada
 *   - Tráfego redistribuído automaticamente entre variações restantes
 *
 * Lógica por variação:
 *   A cada 30 minutos, para cada variação ativa de cada teste ativo:
 *   - Calcula CR de hoje (BRT) e CR médio dos últimos 7 dias (baseline)
 *   - Só avalia se views_hoje >= MIN_VIEWS
 *   - Só dispara se a variação JÁ converteu no período de 7 dias (hasHistory)
 *   - Se cr_hoje < baseline * RATIO  → pausa a variação
 *   - Se cr_hoje < FLOOR absoluto    → pausa a variação
 *   - Nunca pausa a última variação ativa (teste ficaria sem tráfego)
 *
 *   À meia-noite BRT:
 *   - Reativa todas as variações com auto_paused=1
 *   - Redistribui percentuais igualmente
 *
 * Configurações (tabela settings):
 *   guard_enabled        = '1'      (liga/desliga o guard)
 *   guard_min_views      = '30'     (mínimo de visitas hoje por variação)
 *   guard_cr_ratio       = '0.4'    (% da média histórica = limiar dinâmico)
 *   guard_absolute_floor = '0.15'   (CR % mínimo absoluto)
 */

const { getDb, getSetting } = require('../lib/database');
const logger = require('../lib/logger');

// ── Helpers de tempo BRT ──────────────────────────────────────────────────────

function nowBRT() {
  const d = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return { h: d.getUTCHours(), m: d.getUTCMinutes() };
}

function todayFilterBRT() {
  return `DATE(datetime(created_at,'-3 hours')) = DATE(datetime('now','-3 hours'))`;
}

function last7dFilterBRT() {
  return `datetime(created_at,'-3 hours') >= datetime('now','-3 hours','-7 days')`;
}

// Redistribui percentuais igualmente entre variações ativas do teste
function redistributePercentages(db, testId) {
  const active = db.prepare(
    `SELECT id FROM variations WHERE test_id = ? AND COALESCE(active,1) = 1 AND COALESCE(auto_paused,0) = 0`
  ).all(testId);
  if (!active.length) return;
  const pct = Math.floor(100 / active.length);
  const rem = 100 - pct * active.length;
  const upd = db.prepare('UPDATE variations SET percentage = ?, remaining = ? WHERE id = ?');
  active.forEach((v, i) => upd.run(i === 0 ? pct + rem : pct, Math.max(1, Math.floor((i === 0 ? pct + rem : pct) / 10)), v.id));
}

// ── Avalia e pausa variações ruins ───────────────────────────────────────────

async function runGuard() {
  const db = getDb();

  const enabled = getSetting('guard_enabled');
  if (enabled === '0') {
    logger.info('Performance guard: disabled via settings, skipping');
    return;
  }

  const MIN_VIEWS = parseFloat(getSetting('guard_min_views') || '30');
  const CR_RATIO  = parseFloat(getSetting('guard_cr_ratio')  || '0.4');
  const FLOOR     = parseFloat(getSetting('guard_absolute_floor') || '0.15');
  const NO_BOT    = "AND COALESCE(is_bot,0)=0";

  const todayDf = todayFilterBRT();
  const week7Df = last7dFilterBRT();

  const tests = db.prepare('SELECT id, name FROM tests WHERE active = 1').all();
  let paused = 0;

  for (const test of tests) {
    const testId = test.id;

    // Todas as variações ativas deste teste
    const variations = db.prepare(
      `SELECT id, name FROM variations WHERE test_id = ? AND COALESCE(active,1) = 1 AND COALESCE(auto_paused,0) = 0`
    ).all(testId);

    // Nunca avaliar se só há 1 variação ativa — pausar deixaria o teste sem tráfego
    if (variations.length <= 1) continue;

    for (const v of variations) {
      const vid = v.id;

      // Views de hoje para esta variação
      const viewsToday = db.prepare(
        `SELECT COUNT(*) AS c FROM interactions WHERE variation_id=? AND type='view' AND ${todayDf} ${NO_BOT}`
      ).get(vid).c || 0;

      if (viewsToday < MIN_VIEWS) continue; // dados insuficientes

      const convToday = db.prepare(
        `SELECT COUNT(*) AS c FROM interactions WHERE variation_id=? AND type='conversion' AND ${todayDf} ${NO_BOT}`
      ).get(vid).c || 0;

      const crToday = viewsToday > 0 ? (convToday / viewsToday * 100) : 0;

      // Baseline: CR dos últimos 7 dias para esta variação
      const views7d = db.prepare(
        `SELECT COUNT(*) AS c FROM interactions WHERE variation_id=? AND type='view' AND ${week7Df} ${NO_BOT}`
      ).get(vid).c || 0;

      const conv7d = db.prepare(
        `SELECT COUNT(*) AS c FROM interactions WHERE variation_id=? AND type='conversion' AND ${week7Df} ${NO_BOT}`
      ).get(vid).c || 0;

      const crBaseline = views7d > 0 ? (conv7d / views7d * 100) : null;

      // Só dispara se a variação já tem histórico de conversões
      const hasHistory    = crBaseline !== null && conv7d > 0;
      const belowBaseline = hasHistory && crToday < crBaseline * CR_RATIO;
      const belowFloor    = hasHistory && crToday < FLOOR;

      if (!belowBaseline && !belowFloor) continue;

      // Verifica se ainda haverá pelo menos 1 variação ativa após pausar esta
      const activeAfter = db.prepare(
        `SELECT COUNT(*) AS c FROM variations WHERE test_id = ? AND COALESCE(active,1) = 1 AND COALESCE(auto_paused,0) = 0 AND id != ?`
      ).get(testId, vid).c;

      if (activeAfter < 1) {
        logger.info('Performance guard: skipping pause — would leave test with no active variations', {
          testId, varId: vid, varName: v.name,
        });
        continue;
      }

      // Pausa a variação (não o teste)
      db.prepare(
        `UPDATE variations SET active = 0, auto_paused = 1 WHERE id = ?`
      ).run(vid);

      // Redistribui tráfego entre variações restantes
      redistributePercentages(db, testId);

      const reason = belowBaseline
        ? `CR hoje ${crToday.toFixed(2)}% < ${(crBaseline * CR_RATIO).toFixed(2)}% (baseline ${crBaseline.toFixed(2)}% × ${CR_RATIO})`
        : `CR hoje ${crToday.toFixed(2)}% < floor absoluto ${FLOOR}%`;

      logger.warn('Performance guard: variation auto-paused', {
        testId, testName: test.name,
        varId: vid, varName: v.name,
        viewsToday, crToday: crToday.toFixed(2),
        crBaseline: crBaseline !== null ? crBaseline.toFixed(2) : 'sem histórico',
        reason,
      });

      paused++;
    }
  }

  if (paused > 0) {
    logger.info(`Performance guard: ${paused} variation(s) paused this run`);
  }
}

// ── Reativação à meia-noite BRT ───────────────────────────────────────────────

function runMidnightReset() {
  const db = getDb();

  // Reativa variações pausadas automaticamente
  const vars = db.prepare(
    `SELECT DISTINCT test_id FROM variations WHERE auto_paused = 1`
  ).all();

  db.prepare(
    `UPDATE variations SET active = 1, auto_paused = 0 WHERE auto_paused = 1`
  ).run();

  // Redistribui percentuais para cada teste afetado
  for (const { test_id } of vars) {
    redistributePercentages(db, test_id);
  }

  if (vars.length > 0) {
    logger.info(`Performance guard: midnight reset — variations reactivated in ${vars.length} test(s)`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const THIRTY_MIN = 30 * 60 * 1000;
const ONE_MIN    = 60 * 1000;

let _midnightFiredToday = null;

function startGuardScheduler() {
  logger.info('Performance guard scheduler started (every 30min + midnight reset)');

  setInterval(() => {
    runGuard().catch(e => logger.error('Performance guard run error', { msg: e.message }));
  }, THIRTY_MIN);

  setInterval(() => {
    const { h, m } = nowBRT();
    const today = new Date().toISOString().slice(0, 10);
    if (h === 0 && m === 0 && _midnightFiredToday !== today) {
      _midnightFiredToday = today;
      try { runMidnightReset(); }
      catch (e) { logger.error('Performance guard midnight reset error', { msg: e.message }); }
    }
  }, ONE_MIN);

  // Primeira avaliação 5min após o boot
  setTimeout(() => {
    runGuard().catch(e => logger.error('Performance guard initial run error', { msg: e.message }));
  }, 5 * 60 * 1000);
}

module.exports = { startGuardScheduler, runGuard, runMidnightReset };
