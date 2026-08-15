'use strict';

import { initScene, WOOD } from '/scene.js';

// ---- product configuration ------------------------------------------------
// fields: [min, max, default]. Products with `shapes` swap field sets per shape.
const PRODUCTS = {
  regal: {
    label: 'Regał',
    fields: { width: [30, 240, 80], height: [20, 200, 120], depth: [15, 50, 30], shelves: [1, 8, 3] },
    labels: { width: 'Szerokość', height: 'Wysokość', depth: 'Głębokość', shelves: 'Liczba półek' },
  },
  blat: {
    label: 'Blat kuchenny',
    fields: { width: [60, 360, 240], depth: [40, 90, 60], thickness: [2, 6, 4] },
    labels: { width: 'Szerokość (długość)', depth: 'Głębokość', thickness: 'Grubość' },
  },
  stol: {
    label: 'Stół',
    legs: true,
    defaultShape: 'okragly',
    shapes: {
      okragly: {
        fields: { diameter: [60, 160, 100], height: [70, 110, 75] },
        labels: { diameter: 'Średnica', height: 'Wysokość' },
      },
      prostokatny: {
        fields: { width: [70, 120, 90], length: [120, 260, 180], height: [70, 110, 75] },
        labels: { width: 'Szerokość', length: 'Długość', height: 'Wysokość' },
      },
    },
  },
};
const ALL_FIELDS = ['width', 'length', 'diameter', 'height', 'depth', 'shelves', 'thickness'];

// ---- state ----------------------------------------------------------------
const state = {
  product: 'regal', shape: 'okragly',
  width: 80, length: 180, diameter: 100, height: 120, depth: 30, shelves: 3, thickness: 4,
  wood: 'sosna', woodLegs: 'sosna',
};

const $ = (id) => document.getElementById(id);
const scene3d = initScene($('scene'), { onHD: handleHD });

// Scena buduje się pod intro (dzięki temu jest gotowa, zanim film się skończy),
// ale nie ma sensu jej renderować, dopóki zasłania ją film.
if (document.documentElement.classList.contains('intro-active')) {
  scene3d.setPaused(true);
  document.addEventListener('intro:end', () => scene3d.setPaused(false), { once: true });
}

// ---- path-traced "Render HD" button ---------------------------------------
function handleHD(s) {
  const btn = $('hd-btn');
  if (!s.active) {
    btn.dataset.active = '0';
    btn.className = 'hd-btn';
    btn.textContent = '✨ Render HD';
    return;
  }
  btn.dataset.active = '1';
  if (s.done) {
    btn.className = 'hd-btn done';
    btn.textContent = `✓ HD gotowe (${s.samples})`;
  } else {
    btn.className = 'hd-btn rendering';
    btn.textContent = `■ Stop · ${Math.round((s.samples / s.max) * 100)}%`;
  }
}

$('hd-btn').addEventListener('click', () => {
  if ($('hd-btn').dataset.active === '1') scene3d.stopHD();
  else scene3d.startHD();
});

// ---- helpers --------------------------------------------------------------
const fmtPrice = (n) => new Intl.NumberFormat('pl-PL').format(n) + ' PLN';

function estimatePrice() {
  const top = WOOD[state.wood];
  if (state.product === 'blat') {
    const area = (state.width / 100) * (state.depth / 100);
    return Math.round(area * top.pricePerM2 + 200);
  }
  if (state.product === 'stol') {
    const legs = WOOD[state.woodLegs];
    const topT = 0.04;
    const legsVol = 4 * (0.06 * 0.06 * (state.height / 100 - topT));
    let topVol;
    if (state.shape === 'okragly') {
      const r = state.diameter / 200;
      topVol = Math.PI * r * r * topT;
    } else {
      topVol = (state.width / 100) * (state.length / 100) * topT;
    }
    return Math.round(topVol * top.pricePerM3 + legsVol * legs.pricePerM3 + 250);
  }
  const volume = (state.width / 100) * (state.height / 100) * (state.depth / 100);
  return Math.round(volume * top.pricePerM3 + 120);
}

function setSliderFill(input) {
  const pct = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty('--fill', pct + '%');
}

const fmtField = (f) => (f === 'shelves' ? String(state[f]) : state[f] + ' cm');

// resolve the active {fields, labels} for the current product (+ shape)
function activeConfig(productKey, shapeKey) {
  const p = PRODUCTS[productKey];
  return p.shapes ? p.shapes[shapeKey] : p;
}

function applyFields(cfg) {
  ALL_FIELDS.forEach((f) => {
    const wrap = $('field-' + f);
    const c = cfg.fields[f];
    if (c) {
      const [min, max, def] = c;
      const el = $(f);
      el.min = min; el.max = max; el.value = def;
      state[f] = def;
      $('l-' + f).textContent = cfg.labels[f];
      setSliderFill(el);
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  });
}

function applyProduct(productKey) {
  state.product = productKey;
  const p = PRODUCTS[productKey];

  // shape selector + legs wood picker only for products that need them
  $('field-shape').hidden = !p.shapes;
  $('field-woodlegs').hidden = !p.legs;
  $('l-wood').textContent = p.legs ? 'Drewno blatu' : 'Rodzaj drewna';

  if (p.shapes) {
    state.shape = p.defaultShape;
    document.querySelector(`input[name="shape"][value="${state.shape}"]`).checked = true;
  }

  applyFields(activeConfig(productKey, state.shape));
  $('panel-title').textContent = 'Zaprojektuj swój ' + p.label.toLowerCase();
}

function applyShape(shapeKey) {
  state.shape = shapeKey;
  applyFields(activeConfig(state.product, shapeKey));
}

// ---- readouts -------------------------------------------------------------
function syncReadouts() {
  ALL_FIELDS.forEach((f) => {
    if (!$('field-' + f).hidden) $('o-' + f).textContent = fmtField(f);
  });

  let parts;
  if (state.product === 'blat') {
    parts = [`${state.width} cm dł.`, `${state.depth} cm głęb.`, `${state.thickness} cm grub.`];
  } else if (state.product === 'stol') {
    parts = state.shape === 'okragly'
      ? [`Ø ${state.diameter} cm`, `${state.height} cm wys.`]
      : [`${state.width} cm szer.`, `${state.length} cm dł.`, `${state.height} cm wys.`];
  } else {
    parts = [`${state.width} cm szer.`, `${state.height} cm wys.`, `${state.depth} cm głęb.`];
  }
  $('dims-readout').innerHTML = parts.map((s) => `<span>${s}</span>`).join('');

  $('r-wood').textContent = state.product === 'stol'
    ? `Blat: ${WOOD[state.wood].label} · Nogi: ${WOOD[state.woodLegs].label}`
    : WOOD[state.wood].label;

  $('price').textContent = fmtPrice(estimatePrice());
}

function update() {
  syncReadouts();
  scene3d.update(state);
}

// ---- events ---------------------------------------------------------------
ALL_FIELDS.forEach((id) => {
  $(id).addEventListener('input', (e) => {
    state[id] = Number(e.target.value);
    setSliderFill(e.target);
    update();
  });
});

document.querySelectorAll('input[name="wood"]').forEach((el) =>
  el.addEventListener('change', () => { if (el.checked) { state.wood = el.value; update(); } }));

document.querySelectorAll('input[name="woodLegs"]').forEach((el) =>
  el.addEventListener('change', () => { if (el.checked) { state.woodLegs = el.value; update(); } }));

document.querySelectorAll('input[name="product"]').forEach((el) =>
  el.addEventListener('change', () => { if (el.checked) { applyProduct(el.value); update(); } }));

document.querySelectorAll('input[name="shape"]').forEach((el) =>
  el.addEventListener('change', () => { if (el.checked) { applyShape(el.value); update(); } }));

// ---- submit ---------------------------------------------------------------
$('config').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('submit');
  const status = $('status');
  btn.disabled = true;
  status.className = 'form-status';
  status.textContent = 'Wysyłanie…';

  const payload = {
    ...state,
    name: $('name').value.trim(),
    email: $('email').value.trim(),
    comment: $('comment').value.trim(),
  };

  try {
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || 'Błąd serwera');

    status.className = 'form-status ok';
    status.textContent = `Zamówienie ${data.order.order_id} przyjęte! Skontaktujemy się wkrótce.`;
    btn.textContent = '✓ Zamówienie złożone';
    btn.classList.add('done');
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = 'Złóż zamówienie';
      btn.classList.remove('done');
    }, 4000);
  } catch (err) {
    status.className = 'form-status err';
    status.textContent = 'Nie udało się złożyć zamówienia: ' + err.message;
    btn.disabled = false;
  }
});

// ---- init -----------------------------------------------------------------
applyProduct('regal');
update();
