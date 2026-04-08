/**
 * Performance Guard — desativação automática de testes com CR ruim.
 *
 * Lógica (Solução 2 com floor absoluto):
 *   A cada 30 minutos, para cada teste ativo:
 *   - Calcula CR de hoje (BRT) e CR médio dos últimos 7 dias (baseline)
 *   - Se views_hoje >= MIN_VIEWS E (cr_hoje < baseline * RATIO OU cr_hoje < FLOOR)
 *     → pausa o teste (active=0, auto_paused=1)
 *
 *   À meia-noite BRT:
 *   - Reativa todos os testes com auto_paused=1
 *
 * Configurações (tabela settings):
 *   guard_enabled        = '1'      (liga/desliga o guard)
 *   guard_min_views      = '30'     (mínimo de visitas hoje antes de avaliar)
 *   guard_cr_ratio       = '0.4'    (% da média histórica = limiar dinâmico)
 *   guard_absolute_floor = '0.15'   (CR % mínimo absoluto — protege testes novos)
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

// ── Avalia e pausa testes ruins ───────────────────────────────────────────────

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
    const id = test.id;

    // Views e conversões de hoje (BRT)
    const viewsToday = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='view' AND ${todayDf} ${NO_BOT}`
    ).get(id).c || 0;

    if (viewsToday < MIN_VIEWS) continue; // dados insuficientes para avaliar

    const convToday = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='conversion' AND ${todayDf} ${NO_BOT}`
    ).get(id).c || 0;

    const crToday = viewsToday > 0 ? (convToday / viewsToday * 100) : 0;

    // Baseline: CR médio dos últimos 7 dias (excluindo hoje para não distorcer)
    const views7d = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='view' AND ${week7Df} ${NO_BOT}`
    ).get(id).c || 0;

    const conv7d = db.prepare(
      `SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='conversion' AND ${week7Df} ${NO_BOT}`
    ).get(id).c || 0;

    const crBaseline = views7d > 0 ? (conv7d / views7d * 100) : null;

    // Regra combinada:
    // - Dinâmica: cr hoje < baseline * ratio  (só se há histórico de 7 dias)
    // - Floor absoluto: cr hoje < floor  (só se há histórico que prove que o teste JÁ converteu)
    //   → evita pausar testes novos que ainda não têm conversões registradas
    const hasHistory    = crBaseline !== null && conv7d > 0;
    const belowBaseline = hasHistory && crToday < crBaseline * CR_RATIO;
    const belowFloor    = hasHistory && crToday < FLOOR;

    if (belowBaseline || belowFloor) {
      db.prepare(
        `UPDATE tests SET active = 0, auto_paused = 1, auto_paused_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(id);

      const reason = belowBaseline
        ? `CR hoje ${crToday.toFixed(2)}% < ${(crBaseline * CR_RATIO).toFixed(2)}% (baseline ${crBaseline.toFixed(2)}% × ${CR_RATIO})`
        : `CR hoje ${crToday.toFixed(2)}% < floor absoluto ${FLOOR}%`;

      logger.warn('Performance guard: test auto-paused', {
        testId: id,
        testName: test.name,
        viewsToday,
        crToday: crToday.toFixed(2),
        crBaseline: crBaseline !== null ? crBaseline.toFixed(2) : 'sem histórico',
        reason,
      });

      paused++;
    }
  }

  if (paused > 0) {
    logger.info(`Performance guard: ${paused} test(s) paused this run`);
  }
}

// ── Reativação à meia-noite BRT ───────────────────────────────────────────────

function runMidnightReset() {
  const db = getDb();
  const result = db.prepare(
    `UPDATE tests SET active = 1, auto_paused = 0, auto_paused_at = NULL WHERE auto_paused = 1`
  ).run();

  if (result.changes > 0) {
    logger.info(`Performance guard: midnight reset — ${result.changes} test(s) reactivated`);
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

const THIRTY_MIN = 30 * 60 * 1000;
const ONE_MIN    = 60 * 1000;

let _midnightFiredToday = null;

function startGuardScheduler() {
  logger.info('Performance guard scheduler started (every 30min + midnight reset)');

  // Guard a cada 30 minutos
  setInterval(() => {
    runGuard().catch(e => logger.error('Performance guard run error', { msg: e.message }));
  }, THIRTY_MIN);

  // Checagem de meia-noite — roda a cada minuto para não perder a janela
  setInterval(() => {
    const { h, m } = nowBRT();
    const today = new Date().toISOString().slice(0, 10);

    if (h === 0 && m === 0 && _midnightFiredToday !== today) {
      _midnightFiredToday = today;
      try {
        runMidnightReset();
      } catch (e) {
        logger.error('Performance guard midnight reset error', { msg: e.message });
      }
    }
  }, ONE_MIN);

  // Primeira avaliação 5min após o boot
  setTimeout(() => {
    runGuard().catch(e => logger.error('Performance guard initial run error', { msg: e.message }));
  }, 5 * 60 * 1000);
}

module.exports = { startGuardScheduler, runGuard, runMidnightReset };
