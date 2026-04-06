/**
 * Shared Gemini caller — reused by ai-analyst.js and daily-report.js
 */

const https = require('https');

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u       = new URL(url);
    const payload = JSON.stringify(body);
    const req     = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); } });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

  const url  = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
  const resp = await httpsPost(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
  });

  const text = resp?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini sem resposta: ' + JSON.stringify(resp).slice(0, 300));

  // Strip markdown that Gemini insists on adding despite instructions
  return text
    .replace(/^#{1,6}\s+/gm, '')      // ### Título → Título
    .replace(/\*\*(.+?)\*\*/g, '$1')   // **bold** → bold
    .replace(/\*(.+?)\*/g, '$1')       // *italic* → italic
    .replace(/^-{3,}\s*$/gm, '')       // --- separadores
    .replace(/^>\s+/gm, '')            // > blockquote
    .replace(/`(.+?)`/g, '$1')         // `code` → code
    .trim();
}

module.exports = { callGemini };
