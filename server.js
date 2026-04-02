const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb, UPLOADS } = require('./lib/database');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/tests', require('./routes/tests'));
app.use('/api/track', require('./routes/tracking'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/ga4', require('./routes/ga4'));

// ── GA4 Measurement Protocol (server-side) ──
async function sendGA4Event(test, eventName, params) {
  if (!test.ga4_measurement_id || !test.ga4_api_secret) return;
  try {
    await fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${test.ga4_measurement_id}&api_secret=${test.ga4_api_secret}`, {
      method: 'POST',
      body: JSON.stringify({ client_id: params.client_id || uuidv4(), events: [{ name: eventName, params }] })
    });
  } catch (e) { console.error('GA4 MP error:', e.message); }
}

// ── Assign variation helper ──
function assignVariation(db, test, clientId) {
  const vars = db.prepare('SELECT * FROM variations WHERE test_id=? ORDER BY id').all(test.id);
  if (!vars.length) return null;

  if (!vars.some(v => v.remaining > 0)) {
    db.prepare('UPDATE variations SET remaining = MAX(1, percentage/10) WHERE test_id=?').run(test.id);
  }

  const avail = db.prepare('SELECT * FROM variations WHERE test_id=? AND remaining>0 ORDER BY id').all(test.id);
  if (!avail.length) return null;

  const chosen = avail[Math.floor(Math.random() * avail.length)];
  db.prepare('UPDATE variations SET remaining=remaining-1 WHERE id=?').run(chosen.id);

  if (!db.prepare("SELECT * FROM interactions WHERE test_id=? AND client_id=?").get(test.id, clientId)) {
    db.prepare("INSERT INTO interactions (client_id, type, test_id, variation_id) VALUES (?,'view',?,?)").run(clientId, test.id, chosen.id);
  }

  return chosen;
}

// ── /t/:slug — Test entry point (visitors land here) ──
app.get('/t/:slug', (req, res) => {
  const db = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE test_uri=? AND active=1').get(req.params.slug);
  if (!test) return res.status(404).send('<h1>Teste não encontrado</h1>');

  let cid = req.cookies?.cp_uid;
  if (!cid) { cid = uuidv4(); res.cookie('cp_uid', cid, { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' }); }

  // Check existing assignment
  const existing = req.cookies?.[`cp_t${test.id}`];
  if (existing) {
    const v = db.prepare('SELECT * FROM variations WHERE id=? AND test_id=?').get(+existing, test.id);
    if (v?.file_path) return res.redirect(`/p/${test.id}/${v.id}`);
  }

  const chosen = assignVariation(db, test, cid);
  if (!chosen) return res.status(500).send('Sem variações');

  res.cookie(`cp_t${test.id}`, String(chosen.id), { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' });

  // GA4 server-side
  sendGA4Event(test, 'ab_test_view', { client_id: cid, test_name: test.name, variation_name: chosen.name, variation_id: String(chosen.id) });

  if (chosen.file_path) return res.redirect(`/p/${test.id}/${chosen.id}`);
  res.status(404).send('Variação sem arquivo');
});

// ── /p/:tid/:vid — Serve hosted page with auto-injected tracking ──
app.get('/p/:tid/:vid', (req, res) => {
  const db = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id=?').get(req.params.tid);
  const v = db.prepare('SELECT * FROM variations WHERE id=? AND test_id=?').get(req.params.vid, req.params.tid);
  if (!test || !v?.file_path) return res.status(404).send('Página não encontrada');

  const fp = path.join(UPLOADS, v.file_path);
  if (!fs.existsSync(fp)) return res.status(404).send('Arquivo não encontrado');

  let html = fs.readFileSync(fp, 'utf8');
  const host = req.protocol + '://' + req.get('host');

  // Build tracking to inject
  const tracking = `
<!-- EasyTest Tracking -->
<script>
(function(){
  var H="${host}",T=${test.id},V=${v.id};
  function ck(n){var a=n+"=",d=decodeURIComponent(document.cookie),c=d.split(";");for(var i=0;i<c.length;i++){var s=c[i].trim();if(s.indexOf(a)===0)return s.substring(a.length)}return""}
  function sc(n,v,d){document.cookie=n+"="+v+";max-age="+(d*86400)+";path=/;SameSite=Lax"}
  if(!ck("cp_uid"))sc("cp_uid",(crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).substr(2)),30);
  sc("cp_t"+T,V,30);
  ${test.ga4_measurement_id ? `
  (function(){var s=document.createElement('script');s.async=true;s.src='https://www.googletagmanager.com/gtag/js?id=${test.ga4_measurement_id}';document.head.appendChild(s);
  window.dataLayer=window.dataLayer||[];function g(){dataLayer.push(arguments)}window.gtag=g;g('js',new Date());g('config','${test.ga4_measurement_id}');
  g('event','ab_test_view',{test_id:'${test.id}',test_name:'${test.name.replace(/'/g,"\\'")}',variation_name:'${v.name.replace(/'/g,"\\'")}',variation_id:'${v.id}'});})();` : ''}
  ${test.meta_pixel_id ? `
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init','${test.meta_pixel_id}');fbq('track','PageView');fbq('trackCustom','ABTestView',{test_id:'${test.id}',variation:'${v.name.replace(/'/g,"\\'")}'});` : ''}
})();
</script>`;

  if (html.includes('</body>')) html = html.replace('</body>', tracking + '\n</body>');
  else if (html.includes('</html>')) html = html.replace('</html>', tracking + '\n</html>');
  else html += '\n' + tracking;

  res.type('html').send(html);
});

// ── /embed.js ──
app.get('/embed.js', (req, res) => {
  const h = req.protocol + '://' + req.get('host');
  res.type('application/javascript').send(`(function(){var H="${h}";function p(u,d,c){var x=new XMLHttpRequest();x.open("POST",H+u,true);x.setRequestHeader("Content-Type","application/json");x.withCredentials=true;x.onload=function(){if(x.status<300)try{c(JSON.parse(x.responseText))}catch(e){c(null)}};x.send(JSON.stringify(d))}p("/api/track/conversion",{page_url:location.href},function(r){if(r&&r.converted>0){if(typeof gtag==="function")gtag("event","ab_test_conversion",{conversions:r.converted});if(typeof fbq==="function"){fbq("track","Lead");fbq("trackCustom","ABTestConversion",{conversions:r.converted})}}})})();`);
});

// SPA fallback
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/p/') || req.path.startsWith('/t/') || req.path === '/embed.js') return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => console.log(`\n  ⚡ EasyTest v3 → http://localhost:${PORT}\n`));
