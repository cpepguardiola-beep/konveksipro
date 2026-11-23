'use strict';
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const DB = path.join(__dirname, 'data', 'test.db');
for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.unlinkSync(f); } catch (_) {} }

const proc = spawn(process.execPath, ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), DB_FILE: DB, OWNER_PASSWORD: 'owner-pass-123' },
  stdio: ['ignore', 'pipe', 'pipe']
});
let logs = '';
proc.stdout.on('data', (d) => { logs += d; });
proc.stderr.on('data', (d) => { logs += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(method, p, { body, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const r = await fetch(BASE + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, json, setCookie: r.headers.get('set-cookie') };
}
const cookieOf = (sc) => sc.split(';')[0];

(async () => {
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch(BASE + '/api/auth/me'); break; } catch (_) { await sleep(100); }
    }

    // 1. Login salah & benar
    let r = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'salah-banget' } });
    assert.equal(r.status, 401);
    r = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'owner-pass-123' } });
    assert.equal(r.status, 200);
    assert.match(r.setCookie, /HttpOnly/);
    assert.match(r.setCookie, /SameSite=Strict/);
    const owner = cookieOf(r.setCookie);

    // 2. Akses tanpa login ditolak
    r = await call('GET', '/api/c/fabrics');
    assert.equal(r.status, 401);

    // 3. Create -> UUID
    r = await call('POST', '/api/c/fabrics', { cookie: owner, body: { data: { name: 'Katun Tes', color: 'Navy', meters: 10 } } });
    assert.equal(r.status, 201);
    const fid = r.json.id;
    assert.match(fid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(r.json.version, 1);

    // 4. Edit: versi salah -> 409, versi benar -> 200
    r = await call('PATCH', `/api/c/fabrics/${fid}`, { cookie: owner, body: { version: 9, data: { meters: 5 } } });
    assert.equal(r.status, 409);
    r = await call('PATCH', `/api/c/fabrics/${fid}`, { cookie: owner, body: { version: 1, data: { meters: 5 } } });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.meters, 5);
    assert.equal(r.json.data.name, 'Katun Tes');
    assert.equal(r.json.version, 2);

    // 5. Soft delete: wajib konfirmasi, lalu hilang dari daftar tapi tidak hilang dari DB
    r = await call('DELETE', `/api/c/fabrics/${fid}`, { cookie: owner, body: {} });
    assert.equal(r.status, 400);
    r = await call('DELETE', `/api/c/fabrics/${fid}`, { cookie: owner, body: { confirm: true } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/c/fabrics', { cookie: owner });
    assert.ok(!r.json.items.find((x) => x.id === fid));
    r = await call('GET', '/api/c/fabrics?deleted=1', { cookie: owner });
    assert.ok(r.json.items.find((x) => x.id === fid && x.deletedAt));

    // 6. Pulihkan
    r = await call('POST', `/api/c/fabrics/${fid}/restore`, { cookie: owner });
    assert.equal(r.status, 200);
    assert.equal(r.json.deletedAt, null);

    // 7. Buat sub akun dengan hak akses hanya "fabrics"
    r = await call('POST', '/api/users', { cookie: owner, body: { username: 'gudang', name: 'Rina Gudang', jobTitle: 'Gudang', permissions: ['fabrics', 'bukan_menu'], password: 'gudang-pass-1' } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.user.permissions, ['fabrics']);
    const subId = r.json.user.id;

    r = await call('POST', '/api/auth/login', { body: { username: 'gudang', password: 'gudang-pass-1' } });
    assert.equal(r.status, 200);
    const sub = cookieOf(r.setCookie);
    r = await call('GET', '/api/c/fabrics', { cookie: sub });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/c/tailors', { cookie: sub });
    assert.equal(r.status, 403);
    r = await call('GET', '/api/audit', { cookie: sub });
    assert.equal(r.status, 403);
    r = await call('GET', '/api/users', { cookie: sub });
    assert.equal(r.status, 403);
    r = await call('POST', `/api/c/fabrics/${fid}/restore`, { cookie: sub });
    assert.equal(r.status, 403);

    // 8. Sub akun tidak bisa mengubah akun Owner
    r = await call('GET', '/api/users', { cookie: owner });
    const ownerId = r.json.items.find((u) => u.role === 'owner').id;
    r = await call('PATCH', `/api/users/${ownerId}`, { cookie: owner, body: { active: false } });
    assert.equal(r.status, 400);

    // 9. Nonaktifkan sub -> sesi lamanya langsung tidak berlaku
    r = await call('PATCH', `/api/users/${subId}`, { cookie: owner, body: { active: false } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/c/fabrics', { cookie: sub });
    assert.equal(r.status, 401);
    r = await call('PATCH', `/api/users/${subId}`, { cookie: owner, body: { active: true } });
    assert.equal(r.status, 200);

    // 10. Rate limit login: 5 kegagalan lalu terkunci
    for (let i = 0; i < 5; i++) {
      await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'x' + i } });
    }
    r = await call('POST', '/api/auth/login', { body: { username: 'owner', password: 'owner-pass-123' } });
    assert.equal(r.status, 429);

    // 11. Owner: soft delete akun sub, lalu tidak bisa login
    r = await call('DELETE', `/api/users/${subId}`, { cookie: owner, body: { confirm: true } });
    assert.equal(r.status, 200);
    r = await call('POST', '/api/auth/login', { body: { username: 'gudang', password: 'gudang-pass-1' } });
    assert.equal(r.status, 401);

    // 12. Audit log tercatat dan tidak bisa diubah
    r = await call('GET', '/api/audit', { cookie: owner });
    assert.ok(r.json.items.length >= 5);
    const { DatabaseSync } = require('node:sqlite');
    const d = new DatabaseSync(DB);
    const u = d.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get();
    assert.ok(u.password_hash.startsWith('$2'), 'password harus berupa bcrypt hash');
    assert.ok(!u.password_hash.includes('owner-pass-123'));
    assert.throws(() => d.exec("UPDATE audit_log SET action = 'X'"), /append-only/);
    assert.throws(() => d.exec('DELETE FROM audit_log'), /append-only/);

    // 12b. Brand: empat brand default ada, brandId harus valid, barcode harus unik
    r = await call('GET', '/api/brands', { cookie: owner });
    assert.equal(r.json.items.length, 4);
    const brandId = r.json.items[0].id;
    r = await call('POST', '/api/c/fabrics', { cookie: owner, body: { data: { name: 'Kain Brand', brandId } } });
    assert.equal(r.status, 201);
    r = await call('POST', '/api/c/fabrics', { cookie: owner, body: { data: { name: 'Kain Salah', brandId: 'bukan-brand' } } });
    assert.equal(r.status, 400);
    r = await call('POST', '/api/c/inventory', { cookie: owner, body: { data: { model: 'Elza', barcode: '8990001' } } });
    assert.equal(r.status, 201);
    r = await call('POST', '/api/c/inventory', { cookie: owner, body: { data: { model: 'Syerif', barcode: '8990001' } } });
    assert.equal(r.status, 409);
    r = await call('POST', '/api/c/brands', { cookie: owner, body: { data: { name: 'Brand Baru', code: 'BBR' } } });
    assert.equal(r.status, 201);

    // 12c. HPP: harus cocok dengan Excel (Kurta 16 = 86.716,80), tersinkron ke harga kain & biaya standar
    r = await call('POST', '/api/c/fabrics', { cookie: owner, body: { data: { name: 'Kaen Tojiro', pricePerMeter: 18864, meters: 100 } } });
    const kainId = r.json.id;
    r = await call('POST', '/api/c/product_models', { cookie: owner, body: { data: { jenis: 'Kurta', nomor: '16', kainMeter: 2.45, fabricId: kainId, hargaTayang: 150000 } } });
    assert.equal(r.status, 201);
    const modelId = r.json.id;
    r = await call('GET', '/api/hpp/models', { cookie: owner });
    let mdl = r.json.items.find((m) => m.id === modelId);
    assert.ok(Math.abs(mdl.perhitungan.hpp - 86716.8) < 0.01, 'HPP Kurta 16 harus 86716.8, dapat ' + mdl.perhitungan.hpp);
    // ubah harga kain -> HPP ikut berubah
    await call('PATCH', `/api/c/fabrics/${kainId}`, { cookie: owner, body: { version: 1, data: { pricePerMeter: 20000 } } });
    r = await call('GET', '/api/hpp/models', { cookie: owner });
    mdl = r.json.items.find((m) => m.id === modelId);
    assert.ok(Math.abs(mdl.perhitungan.hpp - 89500) < 0.01, 'setelah harga kain naik HPP harus 89500');
    // ubah biaya jahit standar di pengaturan -> HPP ikut berubah
    r = await call('PUT', '/api/settings', { cookie: owner, body: { biayaStandar: { jahit: 15000 } } });
    assert.equal(r.status, 200);
    r = await call('GET', '/api/hpp/models', { cookie: owner });
    mdl = r.json.items.find((m) => m.id === modelId);
    assert.ok(Math.abs(mdl.perhitungan.hpp - 91500) < 0.01, 'setelah biaya jahit naik HPP harus 91500');
    assert.equal(mdl.perhitungan.hargaTayang, 150000);
    await call('PUT', '/api/settings', { cookie: owner, body: { biayaStandar: { jahit: 13000 } } });

    // 12d. Invoice: jumlah, pajak, sisa, status, dan nomor otomatis dihitung server
    r = await call('POST', '/api/c/invoices', { cookie: owner, body: { data: { type: 'jahit', tailor: 'Pak Slamet', items: [
      { model: 'Elza', color: 'Navy', size: 'No. 6', qty: 24, price: 13000 },
      { model: 'Syerif', color: 'Putih', size: 'No. 8', qty: 10, price: 13000 }
    ], dibayar: 100000 } } });
    assert.equal(r.status, 201);
    assert.equal(r.json.data.subtotal, 442000);
    assert.equal(r.json.data.sisa, 342000);
    assert.equal(r.json.data.status, 'Sebagian');
    assert.match(r.json.data.no, /^JHT-\d{6}-001$/);
    const invId = r.json.id;
    r = await call('PATCH', `/api/c/invoices/${invId}`, { cookie: owner, body: { version: 1, data: { dibayar: 442000 } } });
    assert.equal(r.json.data.status, 'Lunas');
    assert.equal(r.json.data.sisa, 0);

    // 12e. Aset & penyusutan garis lurus: 12 juta / 60 bulan, mulai 10 Jan 2026, per 23 Nov 2026 = 10 bulan = 2 juta
    r = await call('POST', '/api/c/assets', { cookie: owner, body: { data: { nama: 'Mesin Jahit Juki', kategori: 'Mesin', tanggal: '2026-01-10', harga: 12000000, nilaiSisa: 0, umurBulan: 60 } } });
    assert.equal(r.status, 201);
    r = await call('GET', '/api/reports/neraca?asOf=2026-11-23', { cookie: owner });
    assert.equal(r.status, 200);
    const aMesin = r.json.aset.detailAset.find((a) => a.nama === 'Mesin Jahit Juki');
    assert.equal(aMesin.akumulasi, 2000000);
    assert.equal(aMesin.nilaiBuku, 10000000);
    assert.ok(typeof r.json.selisih === 'number');
    r = await call('GET', '/api/reports/laba-rugi?from=2026-01-01&to=2026-12-31', { cookie: owner });
    assert.equal(r.status, 200);
    assert.ok(r.json.penyusutan > 0, 'penyusutan harus masuk laba rugi');
    assert.equal(typeof r.json.labaBersih, 'number');

    // 13. Logout mencabut sesi
    r = await call('POST', '/api/auth/logout', { cookie: owner });
    r = await call('GET', '/api/auth/me', { cookie: owner });
    assert.equal(r.status, 401);

    console.log('SEMUA TES LULUS (termasuk brand & barcode)');
  } catch (e) {
    console.error('TES GAGAL:', e.message);
    console.error('--- log server ---\n' + logs);
    process.exitCode = 1;
  } finally {
    proc.kill();
  }
})();
