'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// KONFIGURASI
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'konveksi.db');
const IS_PROD = process.env.NODE_ENV === 'production';
const SESSION_HOURS = 12;
const SESSION_COOKIE = 'kp_session';
const BCRYPT_COST = 12;
const MIN_PASSWORD = 8;
const MAX_PAGE = 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

// Semua menu yang dikenal aplikasi (dipakai untuk validasi hak akses)
const MENU_IDS = ['dashboard', 'inventory', 'marketplace', 'live_content', 'fabrics', 'cutting',
  'tailors', 'supplies', 'hpp', 'finance', 'payroll', 'tasks', 'audit', 'accounts', 'menu_settings', 'settings'];

// Koleksi data -> menu yang mengendalikannya (untuk RBAC)
const COLLECTION_MENU = {
  inventory: 'inventory',
  fabrics: 'fabrics',
  cutting: 'cutting',
  tailors: 'tailors',
  invoices: 'tailors',
  qc_rejects: 'tailors',
  supplies: 'supplies',
  employees: 'payroll',
  payroll_history: 'payroll',
  kasbon: 'payroll',
  cashbook: 'finance',
  marketplace_sales: 'marketplace',
  wholesale_orders: 'marketplace',
  live_reports: 'live_content',
  content_reports: 'live_content',
  tasks: 'tasks',
  brands: 'brands',
  product_models: 'hpp',
  assets: 'finance'
};

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    job_title TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'sub')),
    permissions TEXT NOT NULL DEFAULT '[]',
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    created_by TEXT,
    updated_at TEXT NOT NULL,
    updated_by TEXT,
    deleted_at TEXT,
    deleted_by TEXT,
    PRIMARY KEY (collection, id)
  );
  CREATE INDEX IF NOT EXISTS idx_records_coll ON records(collection, deleted_at);

  CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    user_id TEXT,
    username TEXT,
    action TEXT NOT NULL,
    collection TEXT,
    record_id TEXT,
    detail TEXT
  );
  CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// ---------------------------------------------------------------------------
// HELPER
// ---------------------------------------------------------------------------
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const cleanKeys = (obj) => Object.fromEntries(
  Object.entries(obj).filter(([k]) => !['__proto__', 'constructor', 'prototype'].includes(k))
);
const sanitizePerms = (arr) => (Array.isArray(arr) ? arr.filter((x) => MENU_IDS.includes(x)) : []);
const skuKey = (d) => [d.model, d.color, d.size].map((x) => String(x || '').trim().toLowerCase()).join('|');
const validUsername = (u) => /^[a-z0-9_.-]{3,30}$/.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= MIN_PASSWORD && p.length <= 200;

function audit(user, action, collection, recordId, detail) {
  db.prepare(`INSERT INTO audit_log (id, at, user_id, username, action, collection, record_id, detail)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(newId(), nowIso(), user ? user.id : null, user ? user.username : 'system',
      action, collection || null, recordId || null, detail ? String(detail).slice(0, 500) : null);
}

function getRow(collection, id) {
  return db.prepare('SELECT * FROM records WHERE collection = ? AND id = ?').get(collection, id);
}
function toItem(row) {
  return {
    id: row.id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    data: JSON.parse(row.data)
  };
}
function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
}
function toUser(u) {
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    jobTitle: u.job_title,
    role: u.role,
    active: !!u.active,
    permissions: JSON.parse(u.permissions)
  };
}
function canUse(user, menuId) {
  if (user.role === 'owner') return true;
  return JSON.parse(user.permissions).includes(menuId);
}

// Hash dummy untuk menyamakan waktu respons saat username tidak ditemukan
const DUMMY_HASH = bcrypt.hashSync('dummy-password-untuk-timing', BCRYPT_COST);

// ---------------------------------------------------------------------------
// SESI & COOKIE
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function loadSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.deleted_at IS NULL AND u.active = 1
  `).get(sha256(token), nowIso()) || null;
}
function setSessionCookie(res, token, expires) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly', 'SameSite=Strict', 'Path=/',
    `Expires=${expires.toUTCString()}`
  ];
  if (IS_PROD) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}
function revokeSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// ---------------------------------------------------------------------------
// RATE LIMIT LOGIN (sederhana, in-memory)
// ---------------------------------------------------------------------------
const loginFails = new Map();
function isLocked(key) {
  const a = loginFails.get(key);
  if (!a) return false;
  if (Date.now() > a.resetAt) { loginFails.delete(key); return false; }
  return a.count >= LOGIN_MAX_FAILS;
}
function recordFail(key) {
  const a = loginFails.get(key) || { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS };
  a.count += 1;
  loginFails.set(key, a);
}

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------
function requireAuth(req, res, next) {
  const u = loadSession(req);
  if (!u) return res.status(401).json({ error: 'Belum login atau sesi sudah habis.' });
  req.user = u;
  next();
}
function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Hanya Owner yang boleh melakukan ini.' });
  next();
}
function collectionParam(req, res, next) {
  const menu = COLLECTION_MENU[req.params.collection];
  if (!menu) return res.status(404).json({ error: 'Koleksi data tidak dikenal.' });
  req.collection = req.params.collection;
  req.menu = menu;
  next();
}
function checkMenu(req, res, next) {
  if (!canUse(req.user, req.menu)) return res.status(403).json({ error: 'Anda tidak punya akses ke menu ini.' });
  next();
}

// Validasi referensi: brandId harus brand aktif; barcode produk harus unik.
function checkRefs(collection, data, selfId) {
  if (collection !== 'brands' && data.brandId !== undefined && data.brandId !== null && data.brandId !== '') {
    const b = getRow('brands', String(data.brandId));
    if (!b || b.deleted_at) return { status: 400, msg: 'Brand tidak valid atau sudah dihapus.' };
  }
  if (collection === 'inventory' && data.barcode) {
    const dup = db.prepare(`SELECT id FROM records WHERE collection = 'inventory' AND deleted_at IS NULL
                            AND id != ? AND json_extract(data, '$.barcode') = ?`).get(selfId || '', String(data.barcode));
    if (dup) return { status: 409, msg: 'Barcode sudah dipakai produk lain.' };
  }
  return null;
}

// Penyiapan data sebelum disimpan: invoice dihitung ulang di server (jumlah, pajak, sisa, status, nomor).
function nextInvoiceNo(type, date) {
  const prefix = type === 'penjualan' ? 'PNJ' : 'JHT';
  const ym = (date || todayStr()).slice(0, 7).replace('-', '');
  const n = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = 'invoices' AND json_extract(data, '$.no') LIKE ?")
    .get(`${prefix}-${ym}-%`).n;
  return `${prefix}-${ym}-${String(n + 1).padStart(3, '0')}`;
}
function prepareRecord(collection, data, isNew) {
  if (collection !== 'invoices') return data;
  const hasItems = Array.isArray(data.items);
  if (hasItems) {
    data.items = data.items.filter(isPlainObject).map((it) => {
      const qty = Math.max(0, Number(it.qty) || 0);
      const price = Math.max(0, Number(it.price) || 0);
      return {
        model: String(it.model || '').slice(0, 100), color: String(it.color || '').slice(0, 60),
        size: String(it.size || '').slice(0, 40), desc: String(it.desc || '').slice(0, 200),
        qty, price, amount: qty * price
      };
    });
  }
  const subtotal = hasItems ? data.items.reduce((s, i) => s + i.amount, 0) : Math.max(0, Number(data.total) || 0);
  const pct = Math.min(100, Math.max(0, Number(data.pajakPersen) || 0));
  const pajak = Math.round((subtotal * pct) / 100);
  const total = subtotal + pajak;
  const dibayar = Math.min(total, Math.max(0, Number(data.dibayar) || 0));
  const sisa = total - dibayar;
  data.type = data.type === 'penjualan' ? 'penjualan' : 'jahit';
  data.date = validDate(data.date, todayStr());
  data.subtotal = subtotal;
  data.pajakPersen = pct;
  data.pajak = pajak;
  data.total = total;
  data.dibayar = dibayar;
  data.sisa = sisa;
  data.status = sisa === 0 ? 'Lunas' : dibayar > 0 ? 'Sebagian' : 'Belum Lunas';
  if (isNew && !data.no) data.no = nextInvoiceNo(data.type, data.date);
  return data;
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------
app.post('/api/auth/login', async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${username}`;

  if (isLocked(key)) {
    return res.status(429).json({ error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 15 menit.' });
  }

  const u = db.prepare('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL').get(username);
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);

  if (!u || !ok || !u.active) {
    recordFail(key);
    audit(null, 'LOGIN_GAGAL', null, null, `username=${username}`);
    return res.status(401).json({ error: 'Username atau password salah.' });
  }

  loginFails.delete(key);
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), u.id, nowIso(), expires.toISOString());
  setSessionCookie(res, token, expires);
  audit(u, 'LOGIN', null, null, null);
  res.json({ user: toUser(u) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  res.json({ user: toUser(req.user) });
});

app.post('/api/auth/password', requireAuth, (req, res) => {
  const current = String(req.body?.currentPassword || '');
  const next = req.body?.newPassword;
  if (!bcrypt.compareSync(current, req.user.password_hash)) {
    return res.status(400).json({ error: 'Password lama tidak sesuai.' });
  }
  if (!validPassword(next)) {
    return res.status(400).json({ error: `Password baru minimal ${MIN_PASSWORD} karakter.` });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(bcrypt.hashSync(next, BCRYPT_COST), req.user.id);
  revokeSessions(req.user.id);
  clearSessionCookie(res);
  audit(req.user, 'GANTI_PASSWORD', null, req.user.id, 'Mengganti password sendiri.');
  res.json({ ok: true, message: 'Password diubah. Silakan login ulang.' });
});

// ---------------------------------------------------------------------------
// AKUN SUB (OWNER)
// ---------------------------------------------------------------------------
app.get('/api/users/directory', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, job_title FROM users WHERE deleted_at IS NULL AND active = 1 ORDER BY name').all();
  res.json({ items: rows.map((r) => ({ id: r.id, name: r.name, jobTitle: r.job_title })) });
});

app.get('/api/users', requireAuth, requireOwner, (req, res) => {
  const rows = db.prepare('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY created_at').all();
  res.json({ items: rows.map(toUser) });
});

app.post('/api/users', requireAuth, requireOwner, async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim().slice(0, 100);
  const jobTitle = String(req.body?.jobTitle || '').trim().slice(0, 100);
  const password = req.body?.password;
  if (!validUsername(username)) return res.status(400).json({ error: 'Username 3-30 karakter: huruf kecil, angka, titik, strip, atau garis bawah.' });
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi.' });
  if (!validPassword(password)) return res.status(400).json({ error: `Password minimal ${MIN_PASSWORD} karakter.` });
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username sudah dipakai.' });

  const id = newId();
  db.prepare(`INSERT INTO users (id, username, name, job_title, role, permissions, password_hash, active, created_at)
              VALUES (?, ?, ?, ?, 'sub', ?, ?, 1, ?)`)
    .run(id, username, name, jobTitle, JSON.stringify(sanitizePerms(req.body?.permissions)),
      await bcrypt.hash(password, BCRYPT_COST), nowIso());
  audit(req.user, 'AKUN_BUAT', 'users', id, `Membuat akun ${username}.`);
  res.status(201).json({ user: toUser(getUser(id)) });
});

app.patch('/api/users/:id', requireAuth, requireOwner, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  const b = req.body || {};
  if (u.role === 'owner' && (b.active === false || b.permissions !== undefined)) {
    return res.status(400).json({ error: 'Akun Owner tidak bisa dinonaktifkan atau dibatasi.' });
  }
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 100) : u.name;
  if (!name) return res.status(400).json({ error: 'Nama wajib diisi.' });
  const jobTitle = b.jobTitle !== undefined ? String(b.jobTitle).trim().slice(0, 100) : u.job_title;
  const perms = b.permissions !== undefined ? sanitizePerms(b.permissions) : JSON.parse(u.permissions);
  const active = b.active !== undefined ? (b.active ? 1 : 0) : u.active;

  db.prepare('UPDATE users SET name = ?, job_title = ?, permissions = ?, active = ? WHERE id = ?')
    .run(name, jobTitle, JSON.stringify(perms), active, u.id);
  if (!active) revokeSessions(u.id);
  audit(req.user, 'AKUN_UBAH', 'users', u.id, `Mengubah akun ${u.username}.`);
  res.json({ user: toUser(getUser(u.id)) });
});

app.post('/api/users/:id/password', requireAuth, requireOwner, async (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (!validPassword(req.body?.newPassword)) return res.status(400).json({ error: `Password minimal ${MIN_PASSWORD} karakter.` });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(await bcrypt.hash(req.body.newPassword, BCRYPT_COST), u.id);
  revokeSessions(u.id);
  audit(req.user, 'AKUN_PASSWORD', 'users', u.id, `Reset password akun ${u.username}.`);
  res.json({ ok: true });
});

app.delete('/api/users/:id', requireAuth, requireOwner, (req, res) => {
  const u = getUser(req.params.id);
  if (!u) return res.status(404).json({ error: 'Akun tidak ditemukan.' });
  if (u.role === 'owner') return res.status(400).json({ error: 'Akun Owner tidak bisa dihapus.' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Penghapusan harus dikonfirmasi (confirm: true).' });
  db.prepare('UPDATE users SET deleted_at = ?, active = 0 WHERE id = ?').run(nowIso(), u.id);
  revokeSessions(u.id);
  audit(req.user, 'AKUN_HAPUS', 'users', u.id, `Menghapus akun ${u.username} (soft delete).`);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// PENGATURAN APLIKASI
// ---------------------------------------------------------------------------
const SETTING_TYPES = {
  companyName: 'string', alamatUsaha: 'string', npwp: 'string', websiteUsaha: 'string', teleponUsaha: 'string',
  lowStockThreshold: 'int', machineAssetValue: 'int', modalAwal: 'int', ppnPersen: 'number', biayaStandar: 'biaya'
};
const BIAYA_KEYS = ['kacing', 'keras', 'setrika', 'packing', 'jahit', 'benang', 'potong', 'iklan'];
const BIAYA_DEFAULT = { kacing: 1000, keras: 150, setrika: 500, packing: 1000, jahit: 13000, benang: 350, potong: 2500, iklan: 22000 };
function getSettings() {
  const out = {};
  db.prepare('SELECT key, value FROM app_settings').all().forEach((r) => { out[r.key] = JSON.parse(r.value); });
  out.biayaStandar = { ...BIAYA_DEFAULT, ...(isPlainObject(out.biayaStandar) ? out.biayaStandar : {}) };
  return out;
}
const validDate = (s, def) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : def);
const todayStr = () => new Date().toISOString().slice(0, 10);
const prevDay = (s) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const requireMenuId = (menu) => (req, res, next) => (canUse(req.user, menu) ? next() : res.status(403).json({ error: 'Anda tidak punya akses ke menu ini.' }));

app.get('/api/settings', requireAuth, (req, res) => {
  res.json({ settings: getSettings() });
});

app.put('/api/settings', requireAuth, requireOwner, (req, res) => {
  const b = req.body || {};
  const up = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [key, type] of Object.entries(SETTING_TYPES)) {
    if (b[key] === undefined) continue;
    let val = b[key];
    if (type === 'string') val = String(val).trim().slice(0, 150);
    else if (type === 'int') val = Math.max(0, parseInt(val, 10) || 0);
    else if (type === 'number') val = Math.min(100, Math.max(0, Number(val) || 0));
    else if (type === 'biaya') {
      if (!isPlainObject(val)) continue;
      const cur = getSettings().biayaStandar; // biaya yang tidak dikirim tetap memakai nilai lama
      val = Object.fromEntries(BIAYA_KEYS.map((k) => [k, val[k] !== undefined ? Math.max(0, Number(val[k]) || 0) : cur[k]]));
    }
    up.run(key, JSON.stringify(val));
  }
  audit(req.user, 'PENGATURAN_UBAH', null, null, 'Memperbarui pengaturan aplikasi.');
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// DATA MASTER & TRANSAKSI (GENERIK, DENGAN UUID, EDIT, SOFT DELETE)
// ---------------------------------------------------------------------------
app.get('/api/brands', requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id, data FROM records WHERE collection = 'brands' AND deleted_at IS NULL ORDER BY created_at").all();
  res.json({ items: rows.map((r) => ({ ...JSON.parse(r.data), id: r.id })) });
});

function liveRows(collection) {
  return db.prepare('SELECT * FROM records WHERE collection = ? AND deleted_at IS NULL ORDER BY created_at').all(collection).map(toItem);
}
function brandOk(item, brandId) {
  return !brandId || !item.data.brandId || item.data.brandId === brandId;
}
function hitungHpp(model, fabrics, std) {
  const d = model.data;
  const kainHarga = d.fabricId && fabrics[d.fabricId] ? Number(fabrics[d.fabricId].pricePerMeter) || 0 : Number(d.kainHarga) || 0;
  const kainMeter = Number(d.kainMeter) || 0;
  const kainTotal = kainMeter * kainHarga;
  const ov = isPlainObject(d.biaya) ? d.biaya : {};
  const biaya = {};
  BIAYA_KEYS.forEach((k) => {
    biaya[k] = ov[k] !== undefined && ov[k] !== null && ov[k] !== '' ? Number(ov[k]) || 0 : std[k];
  });
  const hpp = kainTotal + Object.values(biaya).reduce((s, v) => s + v, 0);
  const hargaTayang = Number(d.hargaTayang) || 0;
  const margin = hargaTayang ? hargaTayang - hpp : null;
  return {
    kainMeter, kainHarga, kainTotal, biaya, hpp, hargaTayang, margin,
    pct: hargaTayang ? Math.round((margin / hargaTayang) * 100) : null,
    sumberKain: d.fabricId && fabrics[d.fabricId] ? 'Stok Kain (otomatis)' : 'Manual'
  };
}

app.get('/api/hpp/models', requireAuth, requireMenuId('hpp'), (req, res) => {
  const std = getSettings().biayaStandar;
  const fabrics = Object.fromEntries(liveRows('fabrics').map((f) => [f.id, f.data]));
  const brandId = String(req.query.brandId || '');
  const items = liveRows('product_models').filter((m) => brandOk(m, brandId))
    .map((m) => ({ ...m, perhitungan: hitungHpp(m, fabrics, std) }));
  res.json({ items, biayaStandar: std });
});

// ---------------------------------------------------------------------------
// LAPORAN KEUANGAN: laba rugi, neraca, penyusutan aset
// ---------------------------------------------------------------------------
const EXCLUDE_BEBAN = ['Kasbon', 'Aset', 'Gaji', 'Prive'];

function akumulasiPenyusutan(asset, asOf) {
  const a = asset.data;
  const cost = Number(a.harga) || 0;
  const salvage = Math.min(cost, Number(a.nilaiSisa) || 0);
  const life = Math.max(0, Math.round(Number(a.umurBulan) || 0));
  if (!life || !validDate(a.tanggal, '') || !asOf || asOf < a.tanggal) return 0;
  const [sy, sm, sd] = a.tanggal.split('-').map(Number);
  const [y, m, d] = asOf.split('-').map(Number);
  let months = (y - sy) * 12 + (m - sm);
  if (d < sd) months -= 1;
  months = Math.min(life, Math.max(0, months));
  return Math.round(((cost - salvage) / life) * months);
}

function labaRugi(from, to, brandId) {
  const inR = (dt) => dt && dt >= from && dt <= to;
  const inv = liveRows('inventory');
  const hppMap = Object.fromEntries(inv.map((i) => [skuKey(i.data), Number(i.data.hpp) || 0]));
  const sales = liveRows('marketplace_sales').filter((x) => brandOk(x, brandId) && inR(x.data.date));
  let penjualanMarket = 0, hppMarket = 0, itemTanpaHpp = 0;
  sales.forEach((s) => {
    const qty = Number(s.data.qty) || 0;
    penjualanMarket += qty * (Number(s.data.price) || 0);
    const key = skuKey(s.data);
    if (hppMap[key] === undefined) itemTanpaHpp += 1; else hppMarket += qty * hppMap[key];
  });
  const grosir = liveRows('wholesale_orders').filter((x) => brandOk(x, brandId) && inR(x.data.date) && x.data.status !== 'Baru');
  const penjualanGrosir = grosir.reduce((s, x) => s + (Number(x.data.total) || 0), 0);
  const cash = liveRows('cashbook').filter((x) => brandOk(x, brandId) && inR(x.data.date));
  const bebanMap = {};
  cash.forEach((c) => {
    if (c.data.type !== 'OUT') return;
    const cat = c.data.category || 'Lainnya';
    if (EXCLUDE_BEBAN.includes(cat)) return;
    bebanMap[cat] = (bebanMap[cat] || 0) + (Number(c.data.amount) || 0);
  });
  const bebanOps = Object.values(bebanMap).reduce((s, v) => s + v, 0);
  const gaji = liveRows('payroll_history').filter((x) => inR(x.data.date))
    .reduce((s, x) => s + (Number(x.data.baseSalary) || 0) + (Number(x.data.allowance) || 0) + (Number(x.data.bonus) || 0), 0);
  const penyusutan = liveRows('assets').filter((a) => brandOk(a, brandId))
    .reduce((s, a) => s + akumulasiPenyusutan(a, to) - akumulasiPenyusutan(a, prevDay(from)), 0);
  const penjualan = penjualanMarket + penjualanGrosir;
  const labaKotor = penjualan - hppMarket;
  const labaBersih = labaKotor - bebanOps - gaji - penyusutan;
  return {
    from, to, penjualanMarket, penjualanGrosir, penjualan, hppMarket, labaKotor,
    bebanOps, bebanPerKategori: bebanMap, gaji, penyusutan, labaBersih,
    catatan: [
      itemTanpaHpp ? `${itemTanpaHpp} penjualan marketplace belum punya HPP (SKU tidak ditemukan di Stok Barang Jadi), jadi HPP-nya dihitung 0.` : null,
      'HPP pesanan grosir belum dihitung. Laba kotor grosir sama dengan total penjualannya.',
      `Kategori yang tidak dihitung sebagai beban operasional: ${EXCLUDE_BEBAN.join(', ')}.`
    ].filter(Boolean)
  };
}

function neraca(asOf, brandId) {
  const cash = liveRows('cashbook').filter((x) => brandOk(x, brandId) && x.data.date <= asOf);
  const saldoDompet = {};
  cash.forEach((c) => {
    const w = c.data.wallet || 'Kas Tunai';
    const amt = Number(c.data.amount) || 0;
    saldoDompet[w] = (saldoDompet[w] || 0) + (c.data.type === 'IN' ? amt : -amt);
  });
  const kas = Object.values(saldoDompet).reduce((s, v) => s + v, 0);
  const piutangKasbon = liveRows('kasbon').filter((k) => k.data.status !== 'Lunas' && (k.data.date || '') <= asOf)
    .reduce((s, k) => s + (Number(k.data.amount) || 0), 0);
  const piutangGrosir = liveRows('wholesale_orders').filter((o) => brandOk(o, brandId) && o.data.status === 'Dikirim' && (o.data.date || '') <= asOf)
    .reduce((s, o) => s + (Number(o.data.total) || 0), 0);
  const persediaanBarang = liveRows('inventory').filter((i) => brandOk(i, brandId))
    .reduce((s, i) => s + (Number(i.data.stock) || 0) * (Number(i.data.hpp) || 0), 0);
  const persediaanKain = liveRows('fabrics').filter((f) => brandOk(f, brandId))
    .reduce((s, f) => s + (Number(f.data.meters) || 0) * (Number(f.data.pricePerMeter) || 0), 0);
  const aset = liveRows('assets').filter((a) => brandOk(a, brandId) && (a.data.tanggal || '') <= asOf).map((a) => {
    const harga = Number(a.data.harga) || 0;
    const akum = akumulasiPenyusutan(a, asOf);
    return { id: a.id, version: a.version, nama: a.data.nama, kategori: a.data.kategori, tanggal: a.data.tanggal,
      harga, akumulasi: akum, nilaiBuku: harga - akum };
  });
  const asetTetap = aset.reduce((s, a) => s + a.nilaiBuku, 0);
  const utangJahit = liveRows('invoices').filter((i) => brandOk(i, brandId) && (i.data.date || '') <= asOf && i.data.type !== 'penjualan')
    .reduce((s, i) => s + (i.data.sisa !== undefined ? Number(i.data.sisa) : (i.data.status === 'Lunas' ? 0 : Number(i.data.total) || 0)), 0);
  const totalAset = kas + piutangKasbon + piutangGrosir + persediaanBarang + persediaanKain + asetTetap;
  const modalAwal = Number(getSettings().modalAwal) || 0;
  const lrKumulatif = labaRugi('0000-01-01', asOf, brandId).labaBersih;
  const totalEkuitas = modalAwal + lrKumulatif;
  const totalKewajiban = utangJahit;
  return {
    asOf,
    aset: { kas, saldoDompet, piutangKasbon, piutangGrosir, persediaanBarang, persediaanKain, asetTetap, detailAset: aset, totalAset },
    kewajiban: { utangJahit, totalKewajiban },
    ekuitas: { modalAwal, labaDitahan: lrKumulatif, totalEkuitas },
    selisih: totalAset - (totalKewajiban + totalEkuitas),
    catatan: [
      'Persediaan barang jadi dan kain dinilai dengan kondisi saat ini, bukan pada tanggal laporan.',
      'Neraca seimbang hanya jika semua transaksi (penjualan, pembelian, dan gaji) sudah tercatat di Buku Kas.'
    ]
  };
}

app.get('/api/reports/laba-rugi', requireAuth, requireMenuId('finance'), (req, res) => {
  const from = validDate(req.query.from, todayStr().slice(0, 8) + '01');
  const to = validDate(req.query.to, todayStr());
  res.json(labaRugi(from, to, String(req.query.brandId || '')));
});

app.get('/api/reports/neraca', requireAuth, requireMenuId('finance'), (req, res) => {
  res.json(neraca(validDate(req.query.asOf, todayStr()), String(req.query.brandId || '')));
});

app.get('/api/c/:collection', requireAuth, collectionParam, checkMenu, (req, res) => {
  const includeDeleted = req.query.deleted === '1' && req.user.role === 'owner';
  const rows = db.prepare(`
    SELECT * FROM records WHERE collection = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    ORDER BY created_at DESC LIMIT ?
  `).all(req.collection, MAX_PAGE);
  res.json({ items: rows.map(toItem) });
});

app.get('/api/c/:collection/:id', requireAuth, collectionParam, checkMenu, (req, res) => {
  const row = getRow(req.collection, req.params.id);
  if (!row) return res.status(404).json({ error: 'Data tidak ditemukan.' });
  res.json(toItem(row));
});

app.post('/api/c/:collection', requireAuth, collectionParam, checkMenu, (req, res) => {
  const data = req.body?.data;
  if (!isPlainObject(data) || Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'Data tidak valid.' });
  }
  const clean = prepareRecord(req.collection, cleanKeys(data), true);
  const refErr = checkRefs(req.collection, clean, '');
  if (refErr) return res.status(refErr.status).json({ error: refErr.msg });
  const id = newId();
  const t = nowIso();
  db.prepare(`INSERT INTO records (collection, id, data, version, created_at, created_by, updated_at, updated_by)
              VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
    .run(req.collection, id, JSON.stringify(clean), t, req.user.id, t, req.user.id);
  audit(req.user, 'BUAT', req.collection, id, `Field: ${Object.keys(clean).join(', ')}`);
  res.status(201).json(toItem(getRow(req.collection, id)));
});

// Edit parsial (merge). Wajib kirim "version" terakhir yang Anda lihat untuk mencegah tabrakan edit.
app.patch('/api/c/:collection/:id', requireAuth, collectionParam, checkMenu, (req, res) => {
  const row = getRow(req.collection, req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Data tidak ditemukan.' });

  const expected = Number(req.body?.version);
  if (!Number.isInteger(expected)) return res.status(400).json({ error: 'Field "version" wajib dikirim.' });
  if (expected !== row.version) {
    return res.status(409).json({ error: 'Data sudah diubah pengguna lain. Muat ulang lalu coba lagi.', current: toItem(row) });
  }
  const patch = req.body?.data;
  if (!isPlainObject(patch)) return res.status(400).json({ error: 'Data perubahan tidak valid.' });

  const cleanPatch = cleanKeys(patch);
  const merged = prepareRecord(req.collection, { ...JSON.parse(row.data), ...cleanPatch }, false);
  const refErr = checkRefs(req.collection, merged, req.params.id);
  if (refErr) return res.status(refErr.status).json({ error: refErr.msg });
  db.prepare(`UPDATE records SET data = ?, version = version + 1, updated_at = ?, updated_by = ?
              WHERE collection = ? AND id = ?`)
    .run(JSON.stringify(merged), nowIso(), req.user.id, req.collection, req.params.id);
  audit(req.user, 'UBAH', req.collection, req.params.id, `Ubah: ${Object.keys(cleanPatch).join(', ')}`);
  res.json(toItem(getRow(req.collection, req.params.id)));
});

// Soft delete: data tidak benar-benar dihapus, hanya ditandai deleted_at.
app.delete('/api/c/:collection/:id', requireAuth, collectionParam, checkMenu, (req, res) => {
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'Penghapusan harus dikonfirmasi (confirm: true).' });
  }
  const row = getRow(req.collection, req.params.id);
  if (!row || row.deleted_at) return res.status(404).json({ error: 'Data tidak ditemukan.' });
  db.prepare(`UPDATE records SET deleted_at = ?, deleted_by = ?, version = version + 1
              WHERE collection = ? AND id = ?`)
    .run(nowIso(), req.user.id, req.collection, req.params.id);
  audit(req.user, 'HAPUS', req.collection, req.params.id, 'Soft delete.');
  res.json({ ok: true });
});

// Pulihkan data yang sudah dihapus (hanya Owner)
app.post('/api/c/:collection/:id/restore', requireAuth, requireOwner, collectionParam, (req, res) => {
  const row = getRow(req.collection, req.params.id);
  if (!row || !row.deleted_at) return res.status(404).json({ error: 'Data terhapus tidak ditemukan.' });
  db.prepare(`UPDATE records SET deleted_at = NULL, deleted_by = NULL, version = version + 1
              WHERE collection = ? AND id = ?`)
    .run(req.collection, req.params.id);
  audit(req.user, 'PULIHKAN', req.collection, req.params.id, 'Data dipulihkan dari soft delete.');
  res.json(toItem(getRow(req.collection, req.params.id)));
});

// ---------------------------------------------------------------------------
// AUDIT LOG (READ ONLY, APPEND ONLY)
// ---------------------------------------------------------------------------
app.get('/api/audit', requireAuth, (req, res) => {
  if (!canUse(req.user, 'audit')) return res.status(403).json({ error: 'Tidak punya akses ke riwayat audit.' });
  const limit = Math.min(Number(req.query.limit) || 300, 1000);
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY at DESC LIMIT ?').all(limit);
  res.json({ items: rows });
});

// ---------------------------------------------------------------------------
// IMPORT DATA DARI APLIKASI LAMA (BACKUP JSON LOCALSTORAGE)
// Hanya bisa dijalankan jika database masih kosong.
// ---------------------------------------------------------------------------
const LEGACY_MAP = {
  inventory: 'inventory', fabrics: 'fabrics', cutting: 'cutting', tailors: 'tailors',
  invoices: 'invoices', qcRejects: 'qc_rejects', employees: 'employees',
  payrollHistory: 'payroll_history', kasbonList: 'kasbon', cashbook: 'cashbook',
  tasks: 'tasks', wholesaleOrders: 'wholesale_orders'
};

app.post('/api/import/legacy', requireAuth, requireOwner, async (req, res) => {
  const legacy = req.body;
  if (!isPlainObject(legacy)) return res.status(400).json({ error: 'Format backup tidak valid.' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM records').get().n;
  if (count > 0) return res.status(409).json({ error: 'Import hanya boleh saat database masih kosong.' });

  const report = { records: {}, users: 0, skipped: [] };
  db.exec('BEGIN');
  try {
    for (const [legacyKey, collection] of Object.entries(LEGACY_MAP)) {
      const arr = legacy[legacyKey];
      if (!Array.isArray(arr)) continue;
      report.records[collection] = 0;
      for (const item of arr) {
        if (!isPlainObject(item)) continue;
        const { id: legacyId, ...rest } = item;
        const data = cleanKeys({ ...rest, legacyId: legacyId ?? null });
        const id = newId();
        const t = nowIso();
        db.prepare(`INSERT INTO records (collection, id, data, version, created_at, created_by, updated_at, updated_by)
                    VALUES (?, ?, ?, 1, ?, ?, ?, ?)`)
          .run(collection, id, JSON.stringify(data), t, req.user.id, t, req.user.id);
        report.records[collection] += 1;
      }
    }

    if (Array.isArray(legacy.accounts)) {
      for (const acc of legacy.accounts) {
        const username = String(acc.username || '').trim().toLowerCase();
        if (!validUsername(username) || db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
          report.skipped.push(`akun ${username || '(kosong)'}`);
          continue;
        }
        const pass = acc.password ? String(acc.password) : crypto.randomBytes(9).toString('base64url');
        if (pass.length < MIN_PASSWORD) report.weakPasswords = [...(report.weakPasswords || []), username];
        db.prepare(`INSERT INTO users (id, username, name, job_title, role, permissions, password_hash, active, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(newId(), username, String(acc.name || username), String(acc.jobTitle || ''),
            acc.role === 'owner' ? 'owner' : 'sub',
            JSON.stringify(sanitizePerms(acc.permissions)),
            bcrypt.hashSync(pass, BCRYPT_COST), acc.active === false ? 0 : 1, nowIso());
        report.users += 1;
      }
    }

    if (isPlainObject(legacy.settings)) {
      const up = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const key of Object.keys(SETTING_TYPES)) {
        if (legacy.settings[key] !== undefined) up.run(key, JSON.stringify(legacy.settings[key]));
      }
    }

    ['masterModels', 'masterColors', 'menuConfig', 'settings', 'accounts'].forEach((k) => {
      if (legacy[k] !== undefined && !(k in LEGACY_MAP)) report.skipped.push(k);
    });
    Object.keys(legacy).forEach((k) => {
      if (Array.isArray(legacy[k]) && !LEGACY_MAP[k] && k !== 'accounts') report.skipped.push(k);
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    console.error(err);
    return res.status(500).json({ error: 'Import gagal dan dibatalkan. Tidak ada data yang berubah.' });
  }

  audit(req.user, 'IMPORT_LEGACY', null, null, JSON.stringify(report.records));
  res.json({ ok: true, report });
});

// ---------------------------------------------------------------------------
// FRONTEND STATIS & ERROR HANDLER
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Format JSON tidak valid.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Data terlalu besar.' });
  console.error(err);
  res.status(500).json({ error: 'Terjadi kesalahan di server.' });
});

// ---------------------------------------------------------------------------
// SEED OWNER PERTAMA
// ---------------------------------------------------------------------------
function ensureOwner() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND deleted_at IS NULL").get().n;
  if (n > 0) return;
  const username = (process.env.OWNER_USERNAME || 'owner').trim().toLowerCase();
  let password = process.env.OWNER_PASSWORD;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  if (!validPassword(password)) throw new Error(`OWNER_PASSWORD minimal ${MIN_PASSWORD} karakter.`);
  db.prepare(`INSERT INTO users (id, username, name, job_title, role, permissions, password_hash, active, created_at)
              VALUES (?, ?, 'Owner', 'Pemilik Usaha', 'owner', '[]', ?, 1, ?)`)
    .run(newId(), username, bcrypt.hashSync(password, BCRYPT_COST), nowIso());
  console.log(`[setup] Akun Owner dibuat: username "${username}"`);
  if (generated) console.log(`[setup] Password sementara (tampil sekali, segera ganti): ${password}`);
}

const DEFAULT_BRANDS = [
  { name: 'elbarr.id', code: 'ELB' },
  { name: 'Alhans', code: 'ALH' },
  { name: 'Almosleem', code: 'ALM' },
  { name: 'Annizham', code: 'ANN' }
];
function ensureBrands() {
  const n = db.prepare("SELECT COUNT(*) AS n FROM records WHERE collection = 'brands'").get().n;
  if (n > 0) return;
  for (const b of DEFAULT_BRANDS) {
    const t = nowIso();
    db.prepare("INSERT INTO records (collection, id, data, version, created_at, updated_at) VALUES ('brands', ?, ?, 1, ?, ?)")
      .run(newId(), JSON.stringify(b), t, t);
  }
  console.log('[setup] 4 brand default dibuat: elbarr.id, Alhans, Almosleem, Annizham (bisa diubah di menu Brand & Channel).');
}

if (require.main === module) {
  ensureOwner();
  ensureBrands();
  app.listen(PORT, () => console.log(`KonveksiPro API berjalan di http://localhost:${PORT}`));
}

module.exports = { app, db };
