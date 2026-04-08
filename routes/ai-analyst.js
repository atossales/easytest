const express = require('express');
const router  = express.Router();
const https   = require('https');
const { getDb, getSetting } = require('../lib/database');
const { callGemini }        = require('../jobs/report-builder');
const logger                = require('../lib/logger');

// ── Helpers ────────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req  = https.request({ hostname: opts.hostname, path: opts.pathname + opts.search, headers }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const opts    = new URL(url);
    const payload = JSON.stringify(body);
    const req     = https.request({
      hostname: opts.hostname,
      path: opts.pathname + opts.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Clarity API ────────────────────────────────────────────────────────────

async function getClarityMetrics(projectId, token, startDate, endDate, url = null) {
  const base = `https://www.clarity.ms/export-data/api/v1/${projectId}/metrics`;
  const params = new URLSearchParams({ startDate, endDate, pageSize: 50 });
  if (url) params.set('url', url);
  try {
    return await httpsGet(`${base}?${params}`, { Authorization: `Bearer ${token}` });
  } catch (e) {
    logger.warn('Clarity API error', { msg: e.message });
    return null;
  }
}

async function getClarityPages(projectId, token, startDate, endDate) {
  const base = `https://www.clarity.ms/export-data/api/v1/${projectId}/pages`;
  const params = new URLSearchParams({ startDate, endDate, pageSize: 20, orderBy: 'sessionCount', sortOrder: 'desc' });
  try {
    return await httpsGet(`${base}?${params}`, { Authorization: `Bearer ${token}` });
  } catch (e) {
    logger.warn('Clarity pages API error', { msg: e.message });
    return null;
  }
}

// ── Build analysis prompt ──────────────────────────────────────────────────

const DEFAULT_SYSTEM_PROMPT = `Você é especialista em conversão de landing pages. Analise os dados e escreva em português brasileiro.

REGRAS — sem exceção:
- Máximo 180 palavras
- Zero markdown: proibido usar #, ##, **, *, ---, traços, colchetes
- Emojis para separar seções, ponto final nas frases
- Linguagem de conversa, não de relatório corporativo
- Use os números reais dos dados, não invente

FORMATO (exatamente assim, sem adicionar seções extras):

📊 Situação
[1-2 frases: o que está acontecendo com a taxa de conversão e receita]

🏆 Vencedora
[Diga qual variação está ganhando e por quê de forma simples — o que ela tem que as outras não têm]

❌ Perdedoras
[Por que as outras estão ficando para trás — 1 frase direta]

⚡ Faça agora
1. [ação concreta e específica]
2. [ação concreta e específica]
3. [ação concreta e específica]`;

function brtDateStr() {
  const d  = new Date(Date.now() - 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yy = d.getUTCFullYear();
  return `${dd}/${mm}/${yy}`;
}

function buildPrompt({ testData, clarityMetrics, clarityPages, scope, periodLabel }) {
  // Load custom system prompt from settings (fallback to default)
  const systemPrompt = getSetting('ai_system_prompt') || DEFAULT_SYSTEM_PROMPT;

  const abSection = testData ? `
## Dados do Teste A/B (EasyTest)
- Nome: ${testData.name}
- Total de views (período): ${testData.total_views}
- Total de conversões (período): ${testData.total_conversions}
- Taxa geral: ${testData.overall_rate}%
- Receita total (período): R$ ${((testData.total_revenue || 0) / 100).toFixed(2)}

Variações:
${(testData.variations || []).map(v =>
  `  • ${v.name}: ${v.views} views, ${v.conversions} conv, ${v.conversion_rate}% CR, R$ ${((v.revenue_cents || 0) / 100).toFixed(2)} receita`
).join('\n')}
` : '';

  const claritySection = clarityMetrics ? `
## Dados do Microsoft Clarity
${JSON.stringify(clarityMetrics, null, 2).slice(0, 3000)}
` : '';

  const pagesSection = clarityPages ? `
## Páginas com mais sessões (Clarity)
${JSON.stringify(clarityPages, null, 2).slice(0, 2000)}
` : '';

  return `${systemPrompt}

---
**Data atual:** ${brtDateStr()} (horário de Brasília)
**Período analisado:** ${periodLabel}

${scope === 'all' ? '## ANÁLISE GERAL — TODAS AS PÁGINAS' : '## ANÁLISE DE PÁGINA ESPECÍFICA'}
${abSection}
${claritySection}
${pagesSection}
`;
}

// ── Shared range parser ────────────────────────────────────────────────────

function parseRange(rangeParam) {
  // Returns { start: Date, end: Date } in UTC
  const today = new Date();
  if (rangeParam === 'yesterday') {
    const start = new Date(today); start.setDate(today.getDate() - 1);
    const end   = new Date(today); end.setDate(today.getDate() - 1);
    return { start, end: today };
  }
  const days  = parseInt(rangeParam || '7') || 7;
  const start = new Date(today); start.setDate(today.getDate() - days);
  return { start, end: today };
}

// ── GET /api/ai/analyze — análise geral de todas as páginas ───────────────
router.get('/analyze', async (req, res) => {
  const clarityToken   = process.env.CLARITY_API_TOKEN;
  const clarityProject = process.env.CLARITY_PROJECT_ID;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada nas variáveis de ambiente' });
  }

  const db         = getDb();
  const rangeParam = req.query.range || '7';
  const { start, end } = parseRange(rangeParam);
  const fmt        = d => d.toISOString().split('T')[0];
  const periodLabel = rangeParam === 'yesterday' ? 'Ontem'
    : rangeParam === '1' ? 'Hoje'
    : `Últimos ${rangeParam} dias`;

  // Aggregate EasyTest data
  const tests = db.prepare(`
    SELECT t.id, t.name,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='view')       AS total_views,
      (SELECT COUNT(*) FROM interactions WHERE test_id=t.id AND type='conversion') AS total_conversions,
      (SELECT COALESCE(SUM(revenue_cents),0) FROM interactions WHERE test_id=t.id AND type='conversion') AS total_revenue
    FROM tests t WHERE t.active=1
  `).all();

  const overallViews   = tests.reduce((s, t) => s + t.total_views, 0);
  const overallConv    = tests.reduce((s, t) => s + t.total_conversions, 0);
  const overallRevenue = tests.reduce((s, t) => s + t.total_revenue, 0);
  const overallRate    = overallViews > 0 ? (overallConv / overallViews * 100).toFixed(2) : '0.00';

  const testData = {
    name: 'Todas as páginas ativas',
    total_views: overallViews,
    total_conversions: overallConv,
    overall_rate: overallRate,
    total_revenue: overallRevenue,
    variations: tests.map(t => ({
      name: t.name,
      views: t.total_views,
      conversions: t.total_conversions,
      conversion_rate: t.total_views > 0 ? (t.total_conversions / t.total_views * 100).toFixed(2) : '0.00',
      revenue_cents: t.total_revenue,
    })),
  };

  // Clarity data (optional)
  let clarityMetrics = null;
  let clarityPages   = null;
  if (clarityToken && clarityProject) {
    [clarityMetrics, clarityPages] = await Promise.all([
      getClarityMetrics(clarityProject, clarityToken, fmt(start), fmt(end)),
      getClarityPages(clarityProject, clarityToken, fmt(start), fmt(end)),
    ]);
  }

  try {
    const prompt   = buildPrompt({ testData, clarityMetrics, clarityPages, scope: 'all', periodLabel });
    const analysis = await callGemini(prompt);
    logger.info('AI analysis generated', { scope: 'all', tests: tests.length });
    res.json({ ok: true, analysis, generated_at: new Date().toISOString(), has_clarity: !!clarityToken });
  } catch (e) {
    logger.error('AI analysis failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/ai/analyze/:id — análise de um teste específico ─────────────
router.get('/analyze/:id', async (req, res) => {
  const clarityToken   = process.env.CLARITY_API_TOKEN;
  const clarityProject = process.env.CLARITY_PROJECT_ID;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada nas variáveis de ambiente' });
  }

  const db   = getDb();
  const id   = req.params.id;
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(id);
  if (!test) return res.status(404).json({ error: 'Teste não encontrado' });

  const rangeParam   = req.query.range || '7';
  const { start, end } = parseRange(rangeParam);
  const fmt = d => d.toISOString().split('T')[0];

  // BRT date filter matching the selected period
  let dateFilter;
  if (rangeParam === 'yesterday') {
    dateFilter = `DATE(datetime(created_at,'-3 hours')) = DATE(datetime('now','-3 hours','-1 day'))`;
  } else {
    const days = parseInt(rangeParam) || 7;
    dateFilter = days === 1
      ? `DATE(datetime(created_at,'-3 hours')) = DATE(datetime('now','-3 hours'))`
      : `datetime(created_at,'-3 hours') >= datetime('now','-3 hours','-${days} days')`;
  }

  const periodLabel = rangeParam === 'yesterday' ? 'Ontem'
    : rangeParam === '1' ? 'Hoje'
    : `Últimos ${rangeParam} dias`;

  const NO_BOT = 'AND COALESCE(is_bot,0)=0';
  const vars   = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(id);

  const totalViews = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND ${dateFilter} ${NO_BOT}`).get(id).c || 0;
  const totalConv  = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='conversion' AND ${dateFilter} ${NO_BOT}`).get(id).c || 0;
  const totalRev   = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND type='conversion' AND ${dateFilter} ${NO_BOT}`).get(id).r || 0;

  const variations = vars.map(v => {
    const views = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? AND ${dateFilter} ${NO_BOT}`).get(id, v.id).c || 0;
    const conv  = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' AND ${dateFilter} ${NO_BOT}`).get(id, v.id).c || 0;
    const rev   = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' AND ${dateFilter} ${NO_BOT}`).get(id, v.id).r || 0;
    return { name: v.name, views, conversions: conv, conversion_rate: (views > 0 ? (conv / views * 100).toFixed(2) : '0.00'), revenue_cents: rev };
  });

  const testData = {
    name: test.name,
    total_views: totalViews,
    total_conversions: totalConv,
    overall_rate: totalViews > 0 ? (totalConv / totalViews * 100).toFixed(2) : '0.00',
    total_revenue: totalRev,
    variations,
  };

  // Clarity data for this test's URL
  let clarityMetrics = null;
  if (clarityToken && clarityProject) {
    const pageUrl = test.custom_domain
      ? `https://${test.custom_domain}`
      : (process.env.SITE_URL ? `${process.env.SITE_URL}/t/${test.test_uri}` : null);
    clarityMetrics = await getClarityMetrics(clarityProject, clarityToken, fmt(start), fmt(end), pageUrl || undefined);
  }

  try {
    const prompt   = buildPrompt({ testData, clarityMetrics, clarityPages: null, scope: 'single', periodLabel });
    const analysis = await callGemini(prompt);
    logger.info('AI analysis generated', { scope: 'single', testId: id });
    res.json({ ok: true, analysis, generated_at: new Date().toISOString(), has_clarity: !!clarityToken });
  } catch (e) {
    logger.error('AI analysis failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/ai/insights/:id — retorna último insight salvo do teste ─────────
router.get('/insights/:id', (req, res) => {
  const db  = getDb();
  const row = db.prepare('SELECT * FROM test_insights WHERE test_id = ?').get(req.params.id);
  if (!row) return res.json({ ok: true, insight: null });
  res.json({
    ok: true,
    insight: row.insight_text,
    views_snap: row.views_snap,
    conv_snap: row.conv_snap,
    cr_snap: row.cr_snap,
    generated_at: row.generated_at,
  });
});

// ── POST /api/ai/insights/:id/refresh — gera insight manualmente ─────────────
router.post('/insights/:id/refresh', async (req, res) => {
  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada' });
  }
  try {
    const { generateInsight } = require('../jobs/insight-agent');
    const insight = await generateInsight(Number(req.params.id));
    const db  = getDb();
    const row = db.prepare('SELECT * FROM test_insights WHERE test_id = ?').get(req.params.id);
    res.json({ ok: true, insight, generated_at: row ? row.generated_at : new Date().toISOString() });
  } catch (e) {
    const status = e.message.includes('insuficientes') ? 400 : 500;
    res.status(status).json({ error: e.message });
  }
});

// ── GET /api/ai/system-prompt ─────────────────────────────────────────────
router.get('/system-prompt', (req, res) => {
  res.json({ prompt: getSetting('ai_system_prompt') || DEFAULT_SYSTEM_PROMPT });
});

// ── POST /api/ai/system-prompt ────────────────────────────────────────────
router.post('/system-prompt', express.json(), (req, res) => {
  const { prompt } = req.body;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt inválido' });
  const { setSetting } = require('../lib/database');
  setSetting('ai_system_prompt', prompt.trim());
  logger.info('AI system prompt updated');
  res.json({ ok: true });
});

// ── POST /api/ai/reset-prompt ─────────────────────────────────────────────
router.post('/reset-prompt', (req, res) => {
  const { setSetting } = require('../lib/database');
  setSetting('ai_system_prompt', null);
  res.json({ ok: true, prompt: DEFAULT_SYSTEM_PROMPT });
});

module.exports = { router, DEFAULT_SYSTEM_PROMPT };
