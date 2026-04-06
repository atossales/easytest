const crypto = require('crypto');

const SESSION_COOKIE = 'et_session';
const SESSION_TTL    = 8 * 60 * 60 * 1000; // 8 hours

// In-memory session store (sufficient for single-instance deployment)
const sessions = new Map();

function getPassword() {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    // No password configured — block all logins
    return null;
  }
  return pw;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() - s.createdAt > SESSION_TTL) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// Routes that don't need auth (public visitor-facing)
const PUBLIC_PREFIXES = ['/t/', '/p/', '/embed.js', '/split.js', '/api/track', '/api/split', '/api/webhook', '/auth/', '/health'];

function requireAuth(req, res, next) {
  const isPublic = PUBLIC_PREFIXES.some(p => req.path.startsWith(p));
  if (isPublic) return next();

  const token = req.cookies?.[SESSION_COOKIE];
  if (isValidSession(token)) return next();

  // API requests get 401, browser requests get redirect
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'Não autenticado' });
  }
  res.redirect('/auth/login');
}

function handleLogin(req, res) {
  const { password } = req.body;
  const configuredPassword = getPassword();
  if (configuredPassword === null) {
    return res.status(503).send(loginPage('ADMIN_PASSWORD não configurado — defina a variável de ambiente'));
  }
  if (password === configuredPassword) {
    const token = createSession();
    res.cookie(SESSION_COOKIE, token, {
      maxAge: SESSION_TTL,
      httpOnly: true,
      sameSite: 'Lax',
      secure: process.env.HTTPS_ENABLED === 'true',
    });
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Senha incorreta'));
}

function handleLogout(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) sessions.delete(token);
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/auth/login');
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>EasyTest — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;900&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Montserrat',sans-serif;background:#F8F8F8;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#fff;border:1px solid #E4E4E4;border-radius:16px;padding:40px;width:360px;box-shadow:0 4px 24px rgba(0,0,0,.06)}
.logo{width:40px;height:40px;background:#0065FF;border-radius:10px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:900;font-size:18px;margin:0 auto 20px}
h1{font-size:20px;font-weight:900;text-align:center;margin-bottom:6px}
p{font-size:12px;color:#6B6B6B;text-align:center;margin-bottom:24px}
label{display:block;font-size:11px;font-weight:700;color:#404040;margin-bottom:5px;text-transform:uppercase;letter-spacing:.3px}
input{width:100%;padding:10px 12px;border:1.5px solid #D4D4D4;border-radius:8px;font-family:'Montserrat',sans-serif;font-size:13px;font-weight:500;outline:none;transition:border .12s}
input:focus{border-color:#0065FF;box-shadow:0 0 0 3px rgba(0,101,255,.1)}
button{width:100%;margin-top:16px;padding:11px;background:#0065FF;color:#fff;border:none;border-radius:8px;font-family:'Montserrat',sans-serif;font-weight:700;font-size:13px;cursor:pointer}
button:hover{background:#0050CC}
.err{background:#FFECEC;color:#FF4D4D;border-radius:8px;padding:9px 12px;font-size:11px;font-weight:600;margin-bottom:14px;text-align:center}
</style>
</head>
<body>
<div class="box">
  <div class="logo">E</div>
  <h1>EasyTest</h1>
  <p>Plataforma de testes A/B</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <form method="POST" action="/auth/login">
    <div style="margin-bottom:16px">
      <label>Senha de acesso</label>
      <input type="password" name="password" placeholder="••••••••" autofocus required>
    </div>
    <button type="submit">Entrar</button>
  </form>
</div>
</body>
</html>`;
}

module.exports = { requireAuth, handleLogin, handleLogout, loginPage };
