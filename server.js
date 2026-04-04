const express      = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit    = require('express-rate-limit');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');

const { getDb, UPLOADS, getSetting, getSettings } = require('./lib/database');
const { requireAuth, handleLogin, handleLogout, loginPage } = require('./middleware/auth');
const { sendEvent, buildEventId } = require('./lib/metaCapi');
const logger = require('./lib/logger');

const app     = express();
const PORT    = process.env.PORT || 3000;
const SITE_URL = process.env.SITE_URL || null; // set in Coolify env vars

// ── Trust proxy (needed for rate limiting behind nginx/EasyPanel) ──────────
app.set('trust proxy', 1);

// ── Rate limiters ─────────────────────────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs:    60 * 1000,      // 1 minute
  max:         120,            // 120 req/min per IP on public routes
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Muitas requisições — tente novamente em breve' },
});

const trackLimiter = rateLimit({
  windowMs:    60 * 1000,
  max:         60,
  standardHeaders: true,
  legacyHeaders:   false,
});

const apiLimiter = rateLimit({
  windowMs:    60 * 1000,
  max:         300,
  standardHeaders: true,
  legacyHeaders:   false,
});

// ── Core middleware ───────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth routes (public) ──────────────────────────────────────────────────
app.get('/auth/login',  (req, res) => res.send(loginPage()));
app.post('/auth/login', handleLogin);
app.get('/auth/logout', handleLogout);

// ── Apply auth to everything except public paths ──────────────────────────
app.use(requireAuth);

// ── API routes ────────────────────────────────────────────────────────────
app.use('/api/tests',    apiLimiter,   require('./routes/tests'));
app.use('/api/track',    trackLimiter, require('./routes/tracking'));
app.use('/api/reports',  apiLimiter,   require('./routes/reports'));
app.use('/api/ga4',      apiLimiter,   require('./routes/ga4'));
app.use('/api/settings', apiLimiter,   require('./routes/settings'));

// ── Health check (unauthenticated) ───────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    const db   = getDb();
    const tests = db.prepare('SELECT COUNT(*) AS n FROM tests').get().n;
    res.json({ status: 'ok', tests, ts: new Date().toISOString() });
  } catch (e) {
    res.status(503).json({ status: 'error', msg: e.message });
  }
});

// ── Helper: detect device from UA ────────────────────────────────────────
function getDeviceType(ua = '') {
  if (!ua) return 'unknown';
  if (/tablet|ipad|playbook|silk/i.test(ua)) return 'tablet';
  if (/mobile|android|iphone|ipod|blackberry|windows phone/i.test(ua)) return 'mobile';
  return 'desktop';
}

function parseUtm(url = '') {
  try {
    const u = new URL(url.startsWith('http') ? url : 'http://x' + url);
    return {
      utm_source:   u.searchParams.get('utm_source')   || null,
      utm_medium:   u.searchParams.get('utm_medium')   || null,
      utm_campaign: u.searchParams.get('utm_campaign') || null,
      utm_term:     u.searchParams.get('utm_term')     || null,
      utm_content:  u.searchParams.get('utm_content')  || null,
    };
  } catch { return {}; }
}

// Merge UTMs: current URL params take priority over referer params
function resolveUtm(req) {
  const fromUrl     = parseUtm('http://x' + req.url);
  const referer     = req.headers['referer'] || req.headers['referrer'] || '';
  const fromReferer = parseUtm(referer);
  try {
    const u = new URL('http://x' + req.url);
    return {
      utm_source:   fromUrl.utm_source   || fromReferer.utm_source   || null,
      utm_medium:   fromUrl.utm_medium   || fromReferer.utm_medium   || null,
      utm_campaign: fromUrl.utm_campaign || fromReferer.utm_campaign || null,
      utm_term:     fromUrl.utm_term     || fromReferer.utm_term     || null,
      utm_content:  fromUrl.utm_content  || fromReferer.utm_content  || null,
      fbclid:       u.searchParams.get('fbclid') || null,
      gclid:        u.searchParams.get('gclid')  || null,
      ttclid:       u.searchParams.get('ttclid') || null,
      referrer:     referer || null,
    };
  } catch {
    return { utm_source: null, utm_medium: null, utm_campaign: null, utm_term: null, utm_content: null, fbclid: null, gclid: null, ttclid: null, referrer: referer || null };
  }
}

// Bot detection via UA
const BOT_RE = /googlebot|bingbot|slurp|duckduckbot|baiduspider|yandexbot|sogou|exabot|facebot|ia_archiver|semrush|ahrefs|mj12bot|dotbot|rogerbot|seznambot|petalbot|applebot|headlesschrome|python-requests|curl\/|wget\/|axios\/|node-fetch/i;
function isBot(ua = '') { return BOT_RE.test(ua); }

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
}

function hashIp(ip) {
  return ip ? crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16) : null;
}

// ── Weighted variation assignment ─────────────────────────────────────────
// Uses the `percentage` field as weight, falling back to the `remaining` counter.
function assignVariation(db, test, clientId) {
  const vars = db.prepare('SELECT * FROM variations WHERE test_id = ? ORDER BY id').all(test.id);
  if (!vars.length) return null;

  // Refill remaining counters when all are exhausted
  if (!vars.some(v => v.remaining > 0)) {
    db.prepare('UPDATE variations SET remaining = MAX(1, percentage / 10) WHERE test_id = ?').run(test.id);
  }

  const avail = db.prepare('SELECT * FROM variations WHERE test_id = ? AND remaining > 0 ORDER BY id').all(test.id);
  if (!avail.length) return null;

  // Weighted random selection by percentage
  const total  = avail.reduce((s, v) => s + v.percentage, 0);
  let rand     = Math.random() * total;
  let chosen   = avail[avail.length - 1];
  for (const v of avail) {
    rand -= v.percentage;
    if (rand <= 0) { chosen = v; break; }
  }

  db.prepare('UPDATE variations SET remaining = remaining - 1 WHERE id = ?').run(chosen.id);

  const alreadyTracked = db.prepare(
    "SELECT id FROM interactions WHERE test_id = ? AND client_id = ?"
  ).get(test.id, clientId);

  if (!alreadyTracked) {
    db.prepare(
      "INSERT INTO interactions (client_id, type, test_id, variation_id) VALUES (?, 'view', ?, ?)"
    ).run(clientId, test.id, chosen.id);
  }

  return chosen;
}

// ── GA4 Measurement Protocol helper ──────────────────────────────────────
async function sendGA4Event(test, eventName, params) {
  if (!test.ga4_measurement_id || !test.ga4_api_secret) return;
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${test.ga4_measurement_id}&api_secret=${test.ga4_api_secret}`,
      {
        method: 'POST',
        body: JSON.stringify({
          client_id: params.client_id || uuidv4(),
          events: [{ name: eventName, params }],
        }),
      }
    );
  } catch (e) { logger.warn('GA4 MP error', { msg: e.message }); }
}

// ── /t/:slug — Visitor entry point ───────────────────────────────────────
app.get('/t/:slug', publicLimiter, (req, res) => {
  const db   = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE test_uri = ? AND active = 1').get(req.params.slug);
  if (!test) return res.status(404).send('<h1 style="font-family:sans-serif">Teste não encontrado</h1>');

  // Visitor ID cookie
  let cid = req.cookies?.cp_uid;
  if (!cid) {
    cid = uuidv4();
    res.cookie('cp_uid', cid, { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' });
  }

  // Sticky variation — if already assigned, reuse
  const existing = req.cookies?.[`cp_t${test.id}`];
  if (existing) {
    const v = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(+existing, test.id);
    if (v?.file_path) return res.redirect(`/p/${test.id}/${v.id}`);
  }

  const chosen = assignVariation(db, test, cid);
  if (!chosen) return res.status(500).send('Nenhuma variação disponível');

  res.cookie(`cp_t${test.id}`, String(chosen.id), { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' });

  // Capture UTM + device + referrer and update the interaction row
  const ua     = req.headers['user-agent'] || '';
  const ip     = getClientIp(req);
  const utm    = resolveUtm(req);
  const device = getDeviceType(ua);
  const bot    = isBot(ua) ? 1 : 0;

  db.prepare(`
    UPDATE interactions SET referrer = ?, device_type = ?,
      utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?,
      fbclid = ?, gclid = ?, ttclid = ?, ip_hash = ?, is_bot = ?
    WHERE test_id = ? AND client_id = ?
  `).run(utm.referrer, device, utm.utm_source, utm.utm_medium, utm.utm_campaign, utm.utm_term, utm.utm_content,
         utm.fbclid, utm.gclid, utm.ttclid, hashIp(ip), bot, test.id, cid);

  // Gap 3: persist UTMs in cookie so they survive the redirect to /p/:tid/:vid
  if (utm.utm_source || utm.fbclid || utm.gclid || utm.ttclid) {
    const utmPayload = JSON.stringify({
      s: utm.utm_source, m: utm.utm_medium, c: utm.utm_campaign,
      t: utm.utm_term, co: utm.utm_content,
      fb: utm.fbclid, gc: utm.gclid, tt: utm.ttclid,
    });
    res.cookie('cp_utm', utmPayload, { maxAge: 1800000, httpOnly: false, sameSite: 'Lax' }); // 30 min
  }

  // GA4 Measurement Protocol — server-side view event
  const eventId = buildEventId(test.id, chosen.id, cid);
  sendGA4Event(test, 'ab_test_view', {
    client_id: cid,
    test_name: test.name,
    variation_name: chosen.name,
    variation_id: String(chosen.id),
    event_id: eventId,
  });

  // Meta CAPI — server-side view event
  const { meta_pixel_id, meta_access_token, meta_test_event_code } = getSettings(
    'meta_pixel_id', 'meta_access_token', 'meta_test_event_code'
  );

  if (meta_pixel_id && meta_access_token) {
    const siteUrl = SITE_URL || getSetting('site_url') || `${req.protocol}://${req.get('host')}`;
    sendEvent({
      pixelId:        meta_pixel_id,
      accessToken:    meta_access_token,
      eventName:      'ViewContent',
      eventSourceUrl: `${siteUrl}/t/${test.test_uri}`,
      clientIp:       ip,
      clientUserAgent: ua,
      clientId:       cid,
      fbc:            req.cookies?._fbc,
      fbp:            req.cookies?._fbp,
      eventId,
      customData: {
        content_name: test.name,
        content_ids:  [String(chosen.id)],
        variation:    chosen.name,
      },
      testMode: !!meta_test_event_code,
    }).catch(() => {});
  }

  logger.debug('Visitor assigned', { slug: req.params.slug, variation: chosen.name, device, cid: cid.slice(0, 8) });

  if (chosen.file_path) return res.redirect(`/p/${test.id}/${chosen.id}`);
  res.status(404).send('Variação sem arquivo HTML');
});

// ── /p/:tid/:vid — Serve variation HTML with injected tracking ────────────
app.get('/p/:tid/:vid', publicLimiter, (req, res) => {
  const db   = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE id = ?').get(req.params.tid);
  const v    = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(req.params.vid, req.params.tid);

  if (!test || !v?.file_path) return res.status(404).send('Página não encontrada');

  // Path traversal protection
  const fp = path.resolve(UPLOADS, path.basename(v.file_path));
  if (!fp.startsWith(UPLOADS)) return res.status(403).send('Acesso negado');
  if (!fs.existsSync(fp)) return res.status(404).send('Arquivo não encontrado no servidor');

  let html = fs.readFileSync(fp, 'utf8');
  const host    = req.protocol + '://' + req.get('host');
  const cid     = req.cookies?.cp_uid || uuidv4();
  const eventId = buildEventId(test.id, v.id, cid);

  // Inject custom head snippet
  if (test.head_snippet) {
    if (html.includes('</head>')) html = html.replace('</head>', test.head_snippet + '\n</head>');
    else html = test.head_snippet + '\n' + html;
  }

  // Inject custom body snippet
  if (test.body_snippet) {
    if (html.includes('</body>')) html = html.replace('</body>', test.body_snippet + '\n</body>');
    else html += '\n' + test.body_snippet;
  }

  // Build Meta Pixel standard event calls
  const ALLOWED_PIXEL_EVENTS = new Set([
    'ViewContent','Search','AddToCart','AddToWishlist','InitiateCheckout','AddPaymentInfo',
    'Purchase','Lead','CompleteRegistration','Contact','CustomizeProduct','Donate',
    'FindLocation','Schedule','StartTrial','SubmitApplication','Subscribe',
  ]);
  let pixelExtraEvents = '';
  if (test.meta_pixel_events) {
    try {
      const evts = JSON.parse(test.meta_pixel_events);
      pixelExtraEvents = evts.filter(e => ALLOWED_PIXEL_EVENTS.has(e)).map(e => `  fbq('track','${e}');`).join('\n');
    } catch {}
  }

  const tracking = `
<!-- EasyTest Tracking -->
<script>
(function(){
  var H="${host}",T=${test.id},V=${v.id};
  var EID="${eventId}";
  function ck(n){var a=n+"=",d=decodeURIComponent(document.cookie),c=d.split(";");for(var i=0;i<c.length;i++){var s=c[i].trim();if(s.indexOf(a)===0)return s.substring(a.length)}return""}
  function sc(n,v,d){document.cookie=n+"="+v+";max-age="+(d*86400)+";path=/;SameSite=Lax"}
  if(!ck("cp_uid"))sc("cp_uid",(crypto&&crypto.randomUUID?crypto.randomUUID():Math.random().toString(36).substr(2)),30);
  sc("cp_t"+T,V,30);
  ${test.ga4_measurement_id ? `
  (function(){
    var s=document.createElement('script');s.async=true;
    s.src='https://www.googletagmanager.com/gtag/js?id=${test.ga4_measurement_id}';
    document.head.appendChild(s);
    window.dataLayer=window.dataLayer||[];
    function g(){dataLayer.push(arguments)}window.gtag=g;
    g('js',new Date());g('config','${test.ga4_measurement_id}');
    g('event','ab_test_view',{
      test_id:'${test.id}',
      test_name:'${test.name.replace(/'/g,"\\'")}',
      variation_name:'${v.name.replace(/'/g,"\\'")}',
      variation_id:'${v.id}',
      event_id: EID
    });
  })();` : ''}
  ${test.meta_pixel_id ? `
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  fbq('init','${test.meta_pixel_id}');
  fbq('track','PageView');
${pixelExtraEvents}
  fbq('trackCustom','ABTestView',{
    test_id:'${test.id}',
    variation:'${v.name.replace(/'/g,"\\'")}',
    eventID: EID
  });` : ''}
})();
</script>`;

  if (html.includes('</body>'))      html = html.replace('</body>', tracking + '\n</body>');
  else if (html.includes('</html>')) html = html.replace('</html>', tracking + '\n</html>');
  else html += '\n' + tracking;

  res.type('html').send(html);
});

// ── /embed.js ─────────────────────────────────────────────────────────────
app.get('/embed.js', (req, res) => {
  const h = SITE_URL || getSetting('site_url') || (req.protocol + '://' + req.get('host'));
  res.type('application/javascript').send(`
(function(){
  var H="${h}";
  function post(u,d,cb){
    var x=new XMLHttpRequest();
    x.open("POST",H+u,true);
    x.setRequestHeader("Content-Type","application/json");
    x.withCredentials=true;
    x.onload=function(){if(x.status<300)try{cb(JSON.parse(x.responseText))}catch(e){cb(null)}};
    x.send(JSON.stringify(d));
  }
  post("/api/track/conversion",{page_url:location.href},function(r){
    if(r&&r.converted>0){
      if(typeof gtag==="function")gtag("event","ab_test_conversion",{conversions:r.converted});
      if(typeof fbq==="function"){fbq("track","Lead");fbq("trackCustom","ABTestConversion",{conversions:r.converted});}
    }
  });
})();`);
});

// ── Custom domain handler ─────────────────────────────────────────────────
// Runs before SPA fallback. If the incoming hostname matches a test's
// custom_domain, treat it as the entry point (same logic as /t/:slug).
app.get('*', publicLimiter, (req, res, next) => {
  const host = req.hostname;
  const db   = getDb();
  const test = db.prepare('SELECT * FROM tests WHERE custom_domain = ? AND active = 1').get(host);
  if (!test) return next();

  let cid = req.cookies?.cp_uid;
  if (!cid) {
    cid = uuidv4();
    res.cookie('cp_uid', cid, { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' });
  }

  const existing = req.cookies?.[`cp_t${test.id}`];
  if (existing) {
    const v = db.prepare('SELECT * FROM variations WHERE id = ? AND test_id = ?').get(+existing, test.id);
    if (v?.file_path) return res.redirect(`/p/${test.id}/${v.id}`);
  }

  const chosen = assignVariation(db, test, cid);
  if (!chosen) return res.status(500).send('Nenhuma variação disponível');

  res.cookie(`cp_t${test.id}`, String(chosen.id), { maxAge: 2592000000, httpOnly: false, sameSite: 'Lax' });

  const ua     = req.headers['user-agent'] || '';
  const ip     = getClientIp(req);
  const utm    = resolveUtm(req);
  const device = getDeviceType(ua);
  const bot    = isBot(ua) ? 1 : 0;

  db.prepare(`
    UPDATE interactions SET referrer = ?, device_type = ?,
      utm_source = ?, utm_medium = ?, utm_campaign = ?, utm_term = ?, utm_content = ?,
      fbclid = ?, gclid = ?, ttclid = ?, ip_hash = ?, is_bot = ?
    WHERE test_id = ? AND client_id = ?
  `).run(utm.referrer, device, utm.utm_source, utm.utm_medium, utm.utm_campaign,
         utm.utm_term, utm.utm_content, utm.fbclid, utm.gclid, utm.ttclid, hashIp(ip), bot, test.id, cid);

  if (utm.utm_source || utm.fbclid || utm.gclid || utm.ttclid) {
    const utmPayload = JSON.stringify({ s: utm.utm_source, m: utm.utm_medium, c: utm.utm_campaign, t: utm.utm_term, co: utm.utm_content, fb: utm.fbclid, gc: utm.gclid, tt: utm.ttclid });
    res.cookie('cp_utm', utmPayload, { maxAge: 1800000, httpOnly: false, sameSite: 'Lax' });
  }

  const eventId = buildEventId(test.id, chosen.id, cid);
  sendGA4Event(test, 'ab_test_view', { client_id: cid, test_name: test.name, variation_name: chosen.name, variation_id: String(chosen.id), event_id: eventId });

  logger.debug('Custom domain visitor', { host, variation: chosen.name, device, cid: cid.slice(0, 8) });

  if (chosen.file_path) return res.redirect(`/p/${test.id}/${chosen.id}`);
  res.status(404).send('Variação sem arquivo HTML');
});

// ── SPA fallback ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  const skip = ['/api/', '/p/', '/t/', '/embed.js', '/auth/', '/health'];
  if (skip.some(p => req.path.startsWith(p))) return;
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler ──────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { msg: err.message, path: req.path });
  const status = err.status || 500;
  const msg    = process.env.NODE_ENV === 'production' ? 'Erro interno do servidor' : err.message;
  res.status(status).json({ error: msg });
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`EasyTest v3 started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
});
