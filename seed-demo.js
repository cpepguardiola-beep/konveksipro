'use strict';
// Mengisi data contoh lewat API (untuk pratinjau). Jalankan setelah server menyala.
// Pemakaian: OWNER_PASS=password-anda npm run demo
const BASE = process.env.BASE || 'http://localhost:3000';
const USER = process.env.OWNER_USER || 'owner';
const PASS = process.env.OWNER_PASS;
if (!PASS) { console.error('Isi OWNER_PASS dulu.'); process.exit(1); }

(async () => {
  const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  if (!login.ok) { console.error('Login gagal:', (await login.json()).error); process.exit(1); }
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const H = { 'Content-Type': 'application/json', Cookie: cookie };
  const post = (c, data) => fetch(`${BASE}/api/c/${c}`, { method: 'POST', headers: H, body: JSON.stringify({ data }) }).then((r) => r.json());
  const d = new Date().toISOString().slice(0, 10);
  const ago = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

  await fetch(`${BASE}/api/settings`, { method: 'PUT', headers: H, body: JSON.stringify({ companyName: 'KonveksiPro Studio', lowStockThreshold: 10, machineAssetValue: 35000000 }) });

  const brands = (await (await fetch(`${BASE}/api/brands`, { headers: H })).json()).items;
  const B = (i) => brands[i % brands.length].id;

  // Stok barang jadi per brand, dengan HPP, harga jual, dan barcode
  const inv = [
    { brandId: B(0), model: 'Elza', color: 'Navy', size: 'No. 6', stock: 24, hpp: 52000, price: 85000, barcode: '8990000000011' },
    { brandId: B(0), model: 'Syerif', color: 'Putih', size: 'No. 8', stock: 6, hpp: 56000, price: 90000, barcode: '8990000000028' },
    { brandId: B(1), model: 'Nafiz', color: 'Marun', size: 'No. 10', stock: 4, hpp: 60000, price: 95000, barcode: '8990000000035' },
    { brandId: B(1), model: 'Polos', color: 'Hitam', size: 'No. 4', stock: 40, hpp: 38000, price: 75000, barcode: '8990000000042' },
    { brandId: B(2), model: 'Gamis Anak', color: 'Dusty', size: 'No. 12', stock: 18, hpp: 70000, price: 99000, barcode: '8990000000059' },
    { brandId: B(3), model: 'Koko Anak', color: 'Krem', size: 'No. 8', stock: 30, hpp: 64000, price: 89000, barcode: '8990000000066' }
  ];
  for (const x of inv) await post('inventory', x);

  await post('fabrics', { brandId: B(0), name: 'Katun Toyobo Fodu', color: 'Navy', meters: 85.5, pricePerMeter: 36000, supplier: 'Toko Kain Berkah' });
  await post('fabrics', { brandId: B(1), name: 'Katun Madinah', color: 'Abu', meters: 18.5, pricePerMeter: 34000, supplier: 'Sentra Tekstil' });
  await post('cutting', { brandId: B(0), date: d, model: 'Elza', color: 'Navy', size: 'No. 6', qty: 24, fabricUsed: 'Katun Toyobo Fodu (25.2 m)', cutter: 'Pak Hendra' });
  await post('tailors', { name: 'Pak Slamet', phone: '0812-3456-7890', specialty: 'Koko & Kemeja Anak' });
  await post('tailors', { name: 'Bu Yanti', phone: '0813-9876-5432', specialty: 'Gamis & Model Elza' });
  await post('invoices', { brandId: B(3), date: ago(9), tailor: 'Pak Slamet', total: 450000, status: 'Belum Setor', note: 'Jahit koko 30 pcs' });

  // Penjualan di berbagai channel, termasuk Instagram & WhatsApp
  const sales = [
    { brandId: B(0), channel: 'Shopee', orderNo: 'SHP-88211', model: 'Elza', color: 'Navy', size: 'No. 6', qty: 2, price: 85000 },
    { brandId: B(1), channel: 'TikTok Shop', orderNo: 'TT-40012', model: 'Polos', color: 'Hitam', size: 'No. 4', qty: 3, price: 75000 },
    { brandId: B(1), channel: 'Tokopedia', orderNo: 'TOK-5521', model: 'Polos', color: 'Hitam', size: 'No. 4', qty: 1, price: 75000 },
    { brandId: B(3), channel: 'Instagram', orderNo: 'IG-0091', model: 'Koko Anak', color: 'Krem', size: 'No. 8', qty: 2, price: 89000 },
    { brandId: B(3), channel: 'WhatsApp', orderNo: 'WA-0147', model: 'Koko Anak', color: 'Krem', size: 'No. 8', qty: 4, price: 89000 }
  ];
  for (const s of sales) await post('marketplace_sales', { ...s, date: ago(Math.floor(Math.random() * 20)) });
  await post('wholesale_orders', { brandId: B(2), date: ago(5), customer: 'Toko Mama Rara', total: 1980000, status: 'Baru', note: 'Gamis anak 20 pcs' });

  await post('employees', { name: 'Rina Gudang', position: 'Admin Gudang', baseSalary: 2500000, allowance: 300000 });
  await post('kasbon', { date: ago(20), personName: 'Pak Slamet', roleType: 'Penjahit', amount: 150000, note: 'Kasbon mingguan', status: 'Aktif' });
  await post('cashbook', { brandId: B(0), date: d, type: 'OUT', wallet: 'Kas Tunai', category: 'Operasional', desc: 'Listrik workshop', amount: 450000 });
  await post('tasks', { date: ago(2), title: 'Cek fisik stok Elza Navy No. 6', assignee: 'Rina Gudang', category: 'Gudang', priority: 'Tinggi', done: false });
  await post('tasks', { date: d, title: 'Follow up setor jahitan Pak Slamet', assignee: 'Budi Produksi', category: 'Produksi', priority: 'Tinggi', done: false });
  await post('tasks', { date: d, title: 'Rekap pesanan Shopee & TikTok', assignee: 'Siti Kasir', category: 'Marketplace', priority: 'Sedang', done: true });

  console.log('Data contoh berhasil dimasukkan (4 brand, 6 produk, berbagai channel).');
})();
