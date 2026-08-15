'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const CSV_PATH = path.join(DATA_DIR, 'orders.csv');

const CSV_HEADER = [
  'order_id',
  'created_at',
  'name',
  'email',
  'phone',
  'product',
  'shape',
  'wood',
  'wood_legs',
  'width_cm',
  'length_cm',
  'depth_cm',
  'diameter_cm',
  'height_cm',
  'thickness_cm',
  'shelves',
  'volume_m3',
  'price_pln',
  'comment',
].join(',');

const WOOD = {
  sosna: { label: 'Sosna', pricePerM3: 3200, pricePerM2: 900 },
  orzech: { label: 'Orzech', pricePerM3: 9800, pricePerM2: 2600 },
};

const PRODUCTS = {
  regal: { label: 'Regał' },
  blat: { label: 'Blat kuchenny' },
  stol: { label: 'Stół' },
};

const SHAPES = { okragly: 'okrągły', prostokatny: 'prostokątny' };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.hdr': 'image/vnd.radiance',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CSV_PATH)) {
  fs.writeFileSync(CSV_PATH, CSV_HEADER + '\n', 'utf8');
}

// --- helpers ---------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

// RFC-4180-ish quoting so commas / quotes / newlines in a comment never break the CSV.
function csvCell(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildOrder(input) {
  const product = PRODUCTS[input.product] ? input.product : 'regal';
  const wood = WOOD[input.wood] ? input.wood : 'sosna';        // blat / główne / drewno blatu
  const woodLegs = WOOD[input.woodLegs] ? input.woodLegs : 'sosna';

  const base = {
    order_id: 'ZAM-' + Date.now().toString(36).toUpperCase(),
    created_at: new Date().toISOString(),
    name: String(input.name || '').slice(0, 120),
    email: String(input.email || '').slice(0, 160),
    phone: String(input.phone || '').slice(0, 60),
    product,
    comment: String(input.comment || '').slice(0, 1000),
    // every dimension column, blank by default
    shape: '', wood, wood_legs: '',
    width_cm: '', length_cm: '', depth_cm: '', diameter_cm: '',
    height_cm: '', thickness_cm: '', shelves: '',
  };

  if (product === 'blat') {
    const width = clampNumber(input.width, 60, 360, 240);     // długość
    const depth = clampNumber(input.depth, 40, 90, 60);
    const thickness = clampNumber(input.thickness, 2, 6, 4);
    const volumeM3 = +((width / 100) * (depth / 100) * (thickness / 100)).toFixed(4);
    const price = Math.round((width / 100) * (depth / 100) * WOOD[wood].pricePerM2 + 200);
    return { ...base, width_cm: width, depth_cm: depth, thickness_cm: thickness, volume_m3: volumeM3, price_pln: price };
  }

  if (product === 'stol') {
    const shape = SHAPES[input.shape] ? input.shape : 'okragly';
    const height = clampNumber(input.height, 70, 110, 75);
    const topT = 0.04;
    const legH = height / 100 - topT;
    const legsVol = 4 * (0.06 * 0.06 * legH);
    let topVol, fields;
    if (shape === 'okragly') {
      const diameter = clampNumber(input.diameter, 60, 160, 100);
      const r = diameter / 200;
      topVol = Math.PI * r * r * topT;
      fields = { diameter_cm: diameter };
    } else {
      const width = clampNumber(input.width, 70, 120, 90);
      const length = clampNumber(input.length, 120, 260, 180);
      topVol = (width / 100) * (length / 100) * topT;
      fields = { width_cm: width, length_cm: length };
    }
    const volumeM3 = +(topVol + legsVol).toFixed(4);
    const price = Math.round(topVol * WOOD[wood].pricePerM3 + legsVol * WOOD[woodLegs].pricePerM3 + 250);
    return { ...base, shape, wood_legs: woodLegs, height_cm: height, ...fields, volume_m3: volumeM3, price_pln: price };
  }

  // regał
  const width = clampNumber(input.width, 30, 240, 80);
  const height = clampNumber(input.height, 20, 200, 120);
  const depth = clampNumber(input.depth, 15, 50, 30);
  const shelves = clampNumber(input.shelves, 1, 8, Math.max(1, Math.round(height / 35)));
  const volumeM3 = +((width / 100) * (height / 100) * (depth / 100)).toFixed(4);
  const price = Math.round(volumeM3 * WOOD[wood].pricePerM3 + 120);
  return { ...base, width_cm: width, height_cm: height, depth_cm: depth, shelves, volume_m3: volumeM3, price_pln: price };
}

function appendCsv(order) {
  const row = [
    order.order_id, order.created_at, order.name, order.email, order.phone,
    order.product, order.shape, order.wood, order.wood_legs,
    order.width_cm, order.length_cm, order.depth_cm, order.diameter_cm,
    order.height_cm, order.thickness_cm, order.shelves,
    order.volume_m3, order.price_pln, order.comment,
  ].map(csvCell).join(',');
  fs.appendFileSync(CSV_PATH, row + '\n', 'utf8');
}

function writeTxt(order) {
  let spec;
  if (order.product === 'blat') {
    spec = [
      '  Drewno:           ' + WOOD[order.wood].label,
      '  Szerokość (dł.):  ' + order.width_cm + ' cm',
      '  Głębokość:        ' + order.depth_cm + ' cm',
      '  Grubość:          ' + order.thickness_cm + ' cm',
    ];
  } else if (order.product === 'stol') {
    const dims = order.shape === 'okragly'
      ? ['  Średnica:         ' + order.diameter_cm + ' cm']
      : ['  Szerokość:        ' + order.width_cm + ' cm', '  Długość:          ' + order.length_cm + ' cm'];
    spec = [
      '  Kształt:          ' + SHAPES[order.shape],
      '  Drewno blatu:     ' + WOOD[order.wood].label,
      '  Drewno nóg:       ' + WOOD[order.wood_legs].label,
      ...dims,
      '  Wysokość:         ' + order.height_cm + ' cm',
    ];
  } else {
    spec = [
      '  Drewno:           ' + WOOD[order.wood].label,
      '  Szerokość:        ' + order.width_cm + ' cm',
      '  Wysokość:         ' + order.height_cm + ' cm',
      '  Głębokość:        ' + order.depth_cm + ' cm',
      '  Półki:            ' + order.shelves,
    ];
  }

  const lines = [
    `Zamówienie ${order.order_id}`,
    `Data: ${order.created_at}`,
    '',
    `Klient: ${order.name || '—'}`,
    `E-mail: ${order.email || '—'}`,
    `Telefon: ${order.phone || '—'}`,
    '',
    `Produkt: ${PRODUCTS[order.product].label}`,
    ...spec,
    `  Objętość:         ${order.volume_m3} m³`,
    '',
    `Szacowana cena: ${order.price_pln} PLN`,
    '',
    'Komentarz klienta:',
    order.comment ? order.comment : '  (brak)',
    '',
  ];
  fs.writeFileSync(path.join(DATA_DIR, order.order_id + '.txt'), lines.join('\n'), 'utf8');
}

// --- request handling ------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function handleOrder(req, res) {
  let raw = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > 1e5) { // 100 KB guard
      tooBig = true;
      req.destroy();
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    let input;
    try {
      input = JSON.parse(raw || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'Nieprawidłowe dane.' });
    }
    try {
      const order = buildOrder(input);
      appendCsv(order);
      writeTxt(order);
      sendJson(res, 200, { ok: true, order });
    } catch (err) {
      console.error('Order error:', err);
      sendJson(res, 500, { ok: false, error: 'Nie udało się zapisać zamówienia.' });
    }
  });
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  // prevent path traversal outside /public
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Nie znaleziono.');
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    // Zapytania zakresowe — bez nich Safari nie odtworzy wideo, a przewijanie
    // wymagałoby pobrania całego pliku. Na produkcji robi to za nas Vercel.
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        let start = m[1] ? Number(m[1]) : stat.size - Number(m[2]);
        let end = m[1] && m[2] ? Number(m[2]) : stat.size - 1;
        start = Math.max(0, start);
        end = Math.min(end, stat.size - 1);

        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          return res.end();
        }

        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
        });
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/order') {
    return handleOrder(req, res);
  }
  if (req.method === 'GET') {
    return serveStatic(req, res);
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`\n  Kreator półek → http://localhost:${PORT}`);
  console.log(`  Zamówienia zapisywane w: ${CSV_PATH}\n`);
});
