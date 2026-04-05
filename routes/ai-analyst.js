const express = require('express');
const router  = express.Router();
const https   = require('https');
const { getDb } = require('../lib/database');
const logger    = require('../lib/logger');

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

// ── Gemini Flash ───────────────────────────────────────────────────────────

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

  const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
  };

  const resp = await httpsPost(url, body, {});
  const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini não retornou texto: ' + JSON.stringify(resp).slice(0, 300));
  return text;
}

// ── Build analysis prompt ──────────────────────────────────────────────────

function buildPrompt({ testData, clarityMetrics, clarityPages, scope }) {
  const abSection = testData ? `
## Dados do Teste A/B (EasyTest)
- Nome: ${testData.name}
- Total de views: ${testData.total_views}
- Total de conversões: ${testData.total_conversions}
- Taxa geral: ${testData.overall_rate}%
- Receita total: R$ ${((testData.total_revenue || 0) / 100).toFixed(2)}

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

  return `Você é um especialista sênior em tráfego pago (Meta Ads, Google Ads) e UX/UI de landing pages de alta conversão.

Analise os dados abaixo e entregue um relatório executivo em português brasileiro, estruturado assim:

**1. DIAGNÓSTICO GERAL** — O que os números estão dizendo? Qual é a saúde atual do funil?

**2. ANÁLISE DE TRÁFEGO** — Qualidade do tráfego, canais, padrões comportamentais (rage clicks, dead clicks, scroll depth se disponível).

**3. ANÁLISE DE UX/UI** — Com base no comportamento (Clarity), o que está travando o visitante? Onde está o maior abandono?

**4. ANÁLISE POR VARIAÇÃO** (se houver teste A/B) — Qual variação está ganhando e por quê? O que explica a diferença?

**5. RECEITA E ROI** — Qual variação gera mais dinheiro? Qual o ticket médio? Tem orderbump impactando?

**6. AÇÕES PRIORITÁRIAS** — Liste as 3 a 5 ações mais importantes ordenadas por impacto esperado. Seja específico.

**7. ALERTAS** — O que precisa de atenção imediata?

Seja direto, específico e prático. Evite linguagem vaga. Use dados reais dos inputs abaixo.

---
${scope === 'all' ? '## ANÁLISE GERAL — TODAS AS PÁGINAS' : '## ANÁLISE DE PÁGINA ESPECÍFICA'}
${abSection}
${claritySection}
${pagesSection}
`;
}

// ── GET /api/ai/analyze — análise geral de todas as páginas ───────────────
router.get('/analyze', async (req, res) => {
  const clarityToken   = process.env.CLARITY_API_TOKEN;
  const clarityProject = process.env.CLARITY_PROJECT_ID;

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada nas variáveis de ambiente' });
  }

  const db    = getDb();
  const range = parseInt(req.query.range || '7');
  const today = new Date();
  const start = new Date(today); start.setDate(today.getDate() - range);
  const fmt   = d => d.toISOString().split('T')[0];

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
      getClarityMetrics(clarityProject, clarityToken, fmt(start), fmt(today)),
      getClarityPages(clarityProject, clarityToken, fmt(start), fmt(today)),
    ]);
  }

  try {
    const prompt   = buildPrompt({ testData, clarityMetrics, clarityPages, scope: 'all' });
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

  const range = parseInt(req.query.range || '7');
  const today = new Date();
  const start = new Date(today); start.setDate(today.getDate() - range);
  const fmt   = d => d.toISOString().split('T')[0];

  const NO_BOT = 'AND COALESCE(is_bot,0)=0';
  const vars   = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(id);

  const totalViews = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? ${NO_BOT}`).get(id).c || 0;
  const totalConv  = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND type='conversion' ${NO_BOT}`).get(id).c || 0;
  const totalRev   = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND type='conversion' ${NO_BOT}`).get(id).r || 0;

  const variations = vars.map(v => {
    const views = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? ${NO_BOT}`).get(id, v.id).c || 0;
    const conv  = db.prepare(`SELECT COUNT(*) AS c FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' ${NO_BOT}`).get(id, v.id).c || 0;
    const rev   = db.prepare(`SELECT COALESCE(SUM(revenue_cents),0) AS r FROM interactions WHERE test_id=? AND variation_id=? AND type='conversion' ${NO_BOT}`).get(id, v.id).r || 0;
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
    clarityMetrics = await getClarityMetrics(clarityProject, clarityToken, fmt(start), fmt(today), pageUrl || undefined);
  }

  try {
    const prompt   = buildPrompt({ testData, clarityMetrics, clarityPages: null, scope: 'single' });
    const analysis = await callGemini(prompt);
    logger.info('AI analysis generated', { scope: 'single', testId: id });
    res.json({ ok: true, analysis, generated_at: new Date().toISOString(), has_clarity: !!clarityToken });
  } catch (e) {
    logger.error('AI analysis failed', { msg: e.message });
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
