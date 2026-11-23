# KonveksiPro API (Prioritas 1)

## Menjalankan
    npm install
    OWNER_USERNAME=owner OWNER_PASSWORD="ganti-password-kuat" npm start
    npm test

Butuh Node.js 22.13 atau lebih baru (memakai modul bawaan node:sqlite).
Di produksi: NODE_ENV=production (cookie otomatis bertanda Secure) dan pasang di belakang HTTPS.

## Fitur yang sudah diterapkan
- Password di-hash dengan bcrypt (cost 12), tidak pernah disimpan dalam teks biasa.
- Sesi memakai cookie HttpOnly + SameSite=Strict, token disimpan dalam bentuk hash SHA-256, kedaluwarsa 12 jam.
- Login dibatasi 5 kegagalan per 15 menit per IP dan username.
- RBAC ditegakkan di server: sub akun hanya bisa mengakses koleksi menu yang diizinkan.
- Semua ID berbasis UUID v4.
- Konfirmasi wajib untuk penghapusan (body: { "confirm": true }) dan soft delete (data ditandai deleted_at).
- Pemulihan data terhapus (khusus Owner).
- Edit parsial (PATCH) untuk semua koleksi, dengan kontrol versi optimistik (version) agar tidak menimpa perubahan orang lain.
- Audit log append-only (dijaga trigger database), tidak dibatasi 250 entri.
- Import dari backup JSON aplikasi lama (POST /api/import/legacy, hanya jika database kosong).

## Endpoint utama
| Metode | Path | Keterangan |
|---|---|---|
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/auth/me | Data sesi aktif |
| POST | /api/auth/password | Ganti password sendiri |
| GET | /api/users/directory | Daftar nama (untuk dropdown penanggung jawab) |
| GET/POST | /api/users | Lihat / buat sub akun (Owner) |
| PATCH | /api/users/:id | Ubah nama, jabatan, hak menu, status aktif (Owner) |
| POST | /api/users/:id/password | Reset password sub akun (Owner) |
| DELETE | /api/users/:id | Nonaktifkan akun, soft delete (Owner, confirm) |
| GET/PUT | /api/settings | Pengaturan aplikasi (PUT khusus Owner) |
| GET | /api/c/:koleksi | Daftar data (?deleted=1 untuk melihat yang terhapus, Owner) |
| GET | /api/c/:koleksi/:id | Satu data |
| POST | /api/c/:koleksi | Buat data: { "data": {...} } |
| PATCH | /api/c/:koleksi/:id | Edit: { "version": n, "data": {...} } |
| DELETE | /api/c/:koleksi/:id | Hapus lunak: { "confirm": true } |
| POST | /api/c/:koleksi/:id/restore | Pulihkan (Owner) |
| GET | /api/audit | Riwayat audit |
| POST | /api/import/legacy | Import backup JSON lama (Owner) |

Koleksi yang tersedia: inventory, fabrics, cutting, tailors, invoices, qc_rejects, supplies,
employees, payroll_history, kasbon, cashbook, marketplace_sales, wholesale_orders,
live_reports, content_reports, tasks.

## Catatan penting
- Setelah instalasi pertama, segera ganti password Owner.
- Hasil import: akun dengan password lama yang kurang dari 8 karakter ditampilkan di "weakPasswords"; segera reset.
- Data tidak pernah dihapus permanen lewat API. Penghapusan permanen hanya bisa dilakukan langsung di database.
- Antarmuka web baru ada di folder public/ (sudah tersambung ke API, tanpa CDN, bisa jalan offline di jaringan lokal).
- File HTML lama (localStorage) tidak dipakai lagi. Fitur khusus di versi lama seperti kalkulator HPP, cetak invoice/slip gaji, dan import CSV marketplace belum dipindahkan; itu tahap berikutnya.

## Menjalankan dan mencoba pratinjau
1. Nyalakan server: OWNER_PASSWORD=password-anda npm start
2. Buka http://localhost:3000 di browser, login dengan username owner dan password tadi.
3. (Opsional) Isi data contoh: OWNER_PASS=password-anda npm run demo

Untuk pemakaian sungguhan, jalankan server dengan NODE_ENV=production di belakang HTTPS.


## Prioritas 2 & 3 (sudah diterapkan)

**Multi-brand**
- Brand default: elbarr.id, Alhans, Almosleem, Annizham (dibuat otomatis saat pertama kali dijalankan). Bisa diubah lewat menu "Brand & Channel" (Owner).
- Setiap data stok, penjualan, kas, dan pesanan bisa dikaitkan ke satu brand. Pilihan "Umum" berarti berlaku untuk semua brand.
- Pilihan brand di sidebar menyaring semua tampilan dan dashboard. Dashboard menampilkan ringkasan per brand.
- Channel penjualan: Shopee, TikTok Shop, Tokopedia, Lazada, Instagram, WhatsApp, dan Lainnya.

**Analisis & pengingat (Dashboard)**
- Margin per produk (harga jual dikurangi HPP) dan nilai stok (stok × HPP). Kolom HPP ada di menu Stok Barang Jadi.
- Stok mati: stok masih ada tetapi tidak terjual dalam 60 hari.
- Penjualan per channel dalam 30 hari terakhir.
- Pengingat otomatis: invoice belum disetor lebih dari 7 hari, kasbon belum lunas lebih dari 14 hari, pesanan grosir baru lebih dari 3 hari, dan tugas yang terlewat.

**Barcode**
- Kolom "Barcode / kode SKU" di stok barang jadi harus unik.
- Scanner USB/Bluetooth: ketik atau scan di kotak "Scan barcode" lalu Enter. Produk yang cocok langsung dibuka, atau form produk baru terisi barcode-nya.
- Kamera: tombol "Kamera" (hanya di browser yang mendukung BarcodeDetector, misalnya Chrome di Android).

**Ekspor & cetak**
- "Ekspor CSV (Excel)" menghasilkan file CSV dengan pemisah ";" dan encoding UTF-8 agar langsung terbaca di Excel. Ini bukan file .xlsx asli.
- "Cetak / PDF" membuka dialog cetak browser. Pilih "Simpan sebagai PDF" untuk membuat PDF.

**Mode offline (PWA)**
- Aplikasi bisa dipasang ke layar utama HP/komputer (ikon KonveksiPro) dan dibuka tanpa internet.
- Saat offline, data yang terakhir dimuat tampil dari cache dan diberi tanda. Perubahan data belum bisa disimpan saat offline.
- Service worker hanya aktif di localhost atau di alamat HTTPS. Di produksi, gunakan HTTPS.

**Catatan**
- Ekspor .xlsx asli dan integrasi API Shopee/TikTok belum ada. Ekspor .xlsx butuh pustaka tambahan; API marketplace butuh izin partner resmi.


## Versi ini: HPP, invoice, laba rugi, neraca, aset

**Perkiraan HPP (menu baru)**
- Daftar model produk (Kurta/Gamis per ukuran) yang bisa diedit. HPP = pemakaian kain × harga kain + biaya lain.
- Harga kain diambil dari Stok Kain, sehingga mengubah harga kain langsung mengubah HPP semua model.
- Biaya lain (jahit, iklan, packing, setrika, dll.) diatur di Pengaturan > Biaya standar. Mengubahnya langsung memperbarui semua model. Setiap model juga bisa punya biaya khusus.
- Harga tayang per model, margin Rp dan %, rincian HPP, ekspor CSV, dan cetak.
- Impor data awal dari file HPP Excel: `OWNER_PASS=password-anda npm run import-hpp` (aman dijalankan ulang).

**Invoice jahit & penjualan (gaya struk)**
- Setiap baris: model, warna, ukuran, jumlah pcs, dan harga satuan. Jumlah = pcs × harga satuan (dihitung server).
- Harga satuan jahit otomatis dari biaya standar jahit.
- Nomor otomatis: JHT-YYYYMM-001 (jahit) dan PNJ-YYYYMM-001 (penjualan).
- Pajak/PPN opsional, dibayar, sisa tagihan, dan status Lunas/Sebagian/Belum Lunas.
- Tampilan struk dengan nama usaha, alamat, NPWP, rincian, total, barcode nomor invoice, dan ucapan terima kasih. Bisa dicetak atau disimpan sebagai PDF.

**Keuangan**
- Buku Kas (seperti sebelumnya), Laba Rugi per periode, Neraca per tanggal, dan Daftar Aset.
- Laba rugi: penjualan marketplace dan grosir, HPP penjualan, beban operasional per kategori, gaji, dan penyusutan.
- Penyusutan aset garis lurus: (harga − nilai sisa) ÷ umur bulan.
- Neraca: kas per dompet, piutang kasbon, piutang grosir, persediaan, aset tetap (nilai buku), utang jahit, modal awal, dan laba ditahan. Ada indikator selisih jika belum seimbang.

**Catatan jujur tentang laporan**
- Neraca seimbang hanya jika semua transaksi tercatat: modal awal, saldo kas, penjualan masuk kas, pembelian, dan gaji. Jika ada selisih, sistem menampilkannya.
- Persediaan dihitung dengan nilai saat ini, bukan nilai pada tanggal laporan.
- HPP grosir belum dihitung karena item grosir belum dirinci.
- Laporan ini membantu pemantauan, tetapi bukan pengganti akuntan atau laporan pajak resmi.
