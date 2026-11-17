# GForm Bot v3

Aplikasi lokal Next.js untuk scan dan mengisi Google Forms yang lu punya atau punya izin untuk diuji. Perlu Windows, Node.js 24, dan Microsoft Edge. Edge dibuka dengan profil sementara, jadi browser test terpisah dari sesi harian.

```powershell
npm ci
npm run dev
```

Buka [http://127.0.0.1:3000](http://127.0.0.1:3000). Kalau Edge terpasang di lokasi lain, set `$env:GFORM_EDGE_PATH` ke path lengkap `msedge.exe` sebelum menjalankan server.

1. Paste link responden lalu klik **Scan**. Edge muncul selama scan. Bot isi placeholder di semua pertanyaan yang didukung, termasuk halaman terakhir, lalu menutup jendela scan sebelum submit.
2. Pilih **Independen** untuk mengatur setiap pertanyaan, atau **Paket** untuk menjaga satu set jawaban tetap bersama. Masukkan jawaban teks satu per baris. Jika daftar sama panjang dengan target, masing-masing dipakai sekali. Jika daftar lebih pendek, pilihan acak boleh berulang. Jika daftar lebih panjang, bot mengambil subset acak tanpa pengulangan.
3. Isi persentase pilihan radio/dropdown atau persentase per kombinasi checkbox. Total harus 100%. **Preview** memperlihatkan beberapa contoh dan kuota setelah pembulatan. Urutan dan sampel acak bisa berubah saat run.
4. Klik **Test 1 respons** untuk melihat bot mengisi satu respons di jendela Edge tanpa submit. Klik **Akhiri test** atau tutup jendela setelah diperiksa.
5. Set jumlah, rentang jeda antar mulai respons, dan batas paralel, lalu klik **Run batch** untuk benar-benar mengirim. **Stop** menghentikan antrean dan pengisian yang belum mulai submit. Pengiriman tanpa konfirmasi dicatat terpisah dan tidak dikirim ulang otomatis.

Log disimpan di `.gform-local/logs/`. Buka **Riwayat & log** untuk melihat tahap, nomor respons, halaman, dan nomor pertanyaan saat tersedia.

Versi ini mengasumsikan form linear yang bisa dibuka tanpa login, dengan tombol navigasi berbahasa Indonesia atau Inggris. Grid, upload, dan opsi teks bebas **Other** belum didukung. Validasi khusus atau minimum checkbox dapat menahan scan karena placeholder belum tentu memenuhi aturannya. Pertanyaan atau pilihan yang diacak oleh form bisa memicu pemeriksaan perubahan struktur.

## Riwayat scan dan setting JSON

Semua data lokal ada di `.gform-local/`. Folder ini dibuat saat dibutuhkan dan diabaikan Git, jadi hasil clone mulai dengan riwayat dan setting kosong.

Setiap scan yang berhasil disimpan sebagai JSON di `.gform-local/scans/`. Di **Riwayat scan**, klik **Buka** untuk memakai hasil lama, atau **Download JSON** untuk mengirimkannya. File unduhan dapat dibuka di instalasi lain lewat **Import scan JSON**.

**Save setting** menimpa satu file `.gform-local/latest-settings.json`. Setting terakhir dibuka otomatis saat aplikasi dimuat ulang. **Clear setting** menghapus file setting dan mengembalikan editor ke nilai awal untuk form yang sedang terbuka. **Import setting JSON** langsung menyimpan hasil impor sebagai setting terbaru.

Pakai **Download setting JSON** untuk mendapat contoh lengkap. File ini menyertakan metadata pertanyaan dan dapat membuka form yang sama tanpa scan ulang. Untuk membuat setting dari hasil scan yang sudah terbuka, lu juga bisa impor objek config saja. Contoh di bawah ini pakai ID pertanyaan hasil scan sebagai key. Q1 isian teks, Q2 radio, dan Q3 checkbox.

```json
{
  "count": 50,
  "mode": "independent",
  "min": 2,
  "max": 5,
  "workers": 1,
  "rules": {
    "1": [{"answer": "Contoh jawaban", "weight": 1}],
    "2": [{"answer": "Setuju", "weight": 70}, {"answer": "Tidak setuju", "weight": 30}],
    "3": [{"answer": ["A", "B"], "weight": 100}]
  },
  "packages": []
}
```

Untuk mode paket, gunakan `"mode": "packages"` dan isi `packages` dengan objek seperti `{"weight": 100, "row": {"1": "Contoh jawaban", "2": "Setuju", "3": ["A", "B"]}}`. Gunakan nama opsi persis seperti yang ada di hasil scan. Untuk menggabungkan paket dengan aturan independen, isi `packageQuestions` dengan daftar ID yang ikut paket, lalu isi `rules` untuk pertanyaan di luar paket.
