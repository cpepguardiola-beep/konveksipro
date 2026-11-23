'use strict';
// Mengimpor daftar model HPP (dari PERKIRAAN_HPP_ELBARR) lewat API.
// Pemakaian: OWNER_PASS=password-anda npm run import-hpp
// Bersifat aman dijalankan ulang: model yang sudah ada (jenis + nomor) dilewati.
const fs = require('fs');
const path = require('path');
const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.OWNER_USER || 'owner';
const PASS = process.env.OWNER_PASS;
if (!PASS) { console.error('Isi OWNER_PASS dulu.'); process.exit(1); }

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) { console.error('Login gagal:', (await login.json()).error); process.exit(1); }
  const H = { 'Content-Type': 'application/json', Cookie: login.headers.get('set-cookie').split(';')[0] };
  const src = JSON.parse(fs.readFileSync(path.join(__dirname, 'data-hpp-elbarr.json'), 'utf-8'));

  const brands = (await (await fetch(`${BASE}/api/brands`, { headers: H })).json()).items;
  const brand = brands.find((b) => b.name === 'elbarr.id');
  if (!brand) { console.error('Brand elbarr.id tidak ditemukan.'); process.exit(1); }

  // Kain: buat sekali di Stok Kain, lalu semua model memakainya (agar tersinkron)
  let kain = (await (await fetch(`${BASE}/api/c/fabrics`, { headers: H })).json()).items.find((f) => f.data.name === src.kainNama);
  if (!kain) {
    const r = await fetch(`${BASE}/api/c/fabrics`, { method: 'POST', headers: H, body: JSON.stringify({ data: { brandId: brand.id, name: src.kainNama, color: 'Berbagai', meters: 0, pricePerMeter: src.kainHargaPerMeter, supplier: '' } }) });
    kain = await r.json();
    console.log(`Kain "${src.kainNama}" dibuat di Stok Kain @ Rp ${src.kainHargaPerMeter}/m`);
  }

  const existing = (await (await fetch(`${BASE}/api/c/product_models`, { headers: H })).json()).items;
  let added = 0, skipped = 0;
  for (const m of src.models) {
    if (existing.some((e) => e.data.jenis === m.jenis && String(e.data.nomor) === m.nomor)) { skipped++; continue; }
    const r = await fetch(`${BASE}/api/c/product_models`, { method: 'POST', headers: H, body: JSON.stringify({ data: {
      brandId: brand.id, jenis: m.jenis, nomor: m.nomor, namaModel: m.namaModel, kainMeter: m.kainMeter,
      fabricId: kain.id, hargaTayang: 0, catatan: m.catatan
    } }) });
    if (r.ok) added++;
  }
  console.log(`Model ditambahkan: ${added}, dilewati (sudah ada): ${skipped}.`);
  console.log('Harga tayang belum diisi. Isi lewat menu Perkiraan HPP.');
})();
