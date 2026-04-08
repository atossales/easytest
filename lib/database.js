const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_DIR  = path.join(__dirname, '..', 'db');
const DB_PATH = path.join(DB_DIR, 'easytest.db');
const UPLOADS = path.join(DB_DIR, 'uploads');
let db;

function getDb() {
  if (!db) {
    [DB_DIR, UPLOADS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    init();
    migrate();
  }
  return db;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tests (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      active              INTEGER DEFAULT 1,
      name                TEXT NOT NULL,
      test_uri            TEXT UNIQUE,
      conversion_page_url TEXT,
      ga4_measurement_id  TEXT,
      ga4_api_secret      TEXT,
      meta_pixel_id       TEXT,
      created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS variations (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      percentage    INTEGER NOT NULL DEFAULT 50,
      remaining     INTEGER NOT NULL DEFAULT 0,
      test_id       INTEGER NOT NULL,
      file_path     TEXT,
      file_original TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS interactions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id    TEXT NOT NULL,
      type         TEXT DEFAULT 'view',
      test_id      INTEGER NOT NULL,
      variation_id INTEGER NOT NULL,
      referrer     TEXT,
      device_type  TEXT DEFAULT 'unknown',
      utm_source   TEXT,
      utm_medium   TEXT,
      utm_campaign TEXT,
      utm_term     TEXT,
      utm_content  TEXT,
      ip_hash      TEXT,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE,
      FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_ix_test     ON interactions(test_id);
    CREATE INDEX IF NOT EXISTS idx_ix_var      ON interactions(variation_id);
    CREATE INDEX IF NOT EXISTS idx_ix_client   ON interactions(client_id);
    CREATE INDEX IF NOT EXISTS idx_ix_type     ON interactions(type);
    CREATE INDEX IF NOT EXISTS idx_ix_date     ON interactions(created_at);
    CREATE INDEX IF NOT EXISTS idx_tests_uri   ON tests(test_uri);
  `);
}

// Safe additive migrations — only run once, idempotent
function migrate() {
  const interactionCols = db.prepare("PRAGMA table_info(interactions)").all().map(c => c.name);
  const interactionToAdd = [
    ['device_type',  'TEXT DEFAULT "unknown"'],
    ['utm_source',   'TEXT'],
    ['utm_medium',   'TEXT'],
    ['utm_campaign', 'TEXT'],
    ['utm_term',     'TEXT'],
    ['utm_content',  'TEXT'],
    ['ip_hash',      'TEXT'],
    ['fbclid',       'TEXT'],
    ['gclid',        'TEXT'],
    ['ttclid',       'TEXT'],
    ['is_bot',          'INTEGER DEFAULT 0'],
    ['revenue_cents',   'INTEGER DEFAULT 0'],
  ];
  for (const [col, def] of interactionToAdd) {
    if (!interactionCols.includes(col)) {
      db.exec(`ALTER TABLE interactions ADD COLUMN ${col} ${def}`);
    }
  }

  const testCols = db.prepare("PRAGMA table_info(tests)").all().map(c => c.name);
  if (!testCols.includes('auto_paused')) {
    db.exec('ALTER TABLE tests ADD COLUMN auto_paused INTEGER DEFAULT 0');
  }
  if (!testCols.includes('auto_paused_at')) {
    db.exec('ALTER TABLE tests ADD COLUMN auto_paused_at DATETIME');
  }
  if (!testCols.includes('custom_domain')) {
    db.exec('ALTER TABLE tests ADD COLUMN custom_domain TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tests_domain ON tests(custom_domain)');
  }
  if (!testCols.includes('head_snippet')) {
    db.exec('ALTER TABLE tests ADD COLUMN head_snippet TEXT');
  }
  if (!testCols.includes('body_snippet')) {
    db.exec('ALTER TABLE tests ADD COLUMN body_snippet TEXT');
  }
  if (!testCols.includes('meta_pixel_events')) {
    db.exec('ALTER TABLE tests ADD COLUMN meta_pixel_events TEXT');
  }

  const varCols = db.prepare("PRAGMA table_info(variations)").all().map(c => c.name);
  if (!varCols.includes('active')) {
    db.exec('ALTER TABLE variations ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  }

  if (!testCols.includes('funnel_steps')) {
    db.exec('ALTER TABLE tests ADD COLUMN funnel_steps TEXT');
  }

  // test_insights — cached AI feedback per test (generated every 4h by insight-agent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS test_insights (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id      INTEGER NOT NULL UNIQUE,
      insight_text TEXT NOT NULL,
      views_snap   INTEGER DEFAULT 0,
      conv_snap    INTEGER DEFAULT 0,
      cr_snap      TEXT DEFAULT '0.00',
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ti_test ON test_insights(test_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS funnel_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      test_id      INTEGER NOT NULL,
      variation_id INTEGER NOT NULL,
      client_id    TEXT NOT NULL,
      step_index   INTEGER NOT NULL,
      created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (test_id)      REFERENCES tests(id)      ON DELETE CASCADE,
      FOREIGN KEY (variation_id) REFERENCES variations(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_fe_test   ON funnel_events(test_id);
    CREATE INDEX IF NOT EXISTS idx_fe_client ON funnel_events(client_id, test_id, step_index);
    CREATE INDEX IF NOT EXISTS idx_ix_test_client  ON interactions(test_id, client_id);
    CREATE INDEX IF NOT EXISTS idx_ix_test_var_type ON interactions(test_id, variation_id, type);
    CREATE INDEX IF NOT EXISTS idx_ix_test_type_date ON interactions(test_id, type, created_at);
    CREATE INDEX IF NOT EXISTS idx_fe_test_client ON funnel_events(test_id, client_id);
  `);
}

function getSetting(key) {
  const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function setSetting(key, value) {
  if (value === null || value === undefined) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
  }
}

function getSettings(...keys) {
  const result = {};
  for (const k of keys) result[k] = getSetting(k);
  return result;
}

module.exports = { getDb, UPLOADS, getSetting, setSetting, getSettings };
