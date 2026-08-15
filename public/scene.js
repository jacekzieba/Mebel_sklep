'use strict';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { WebGLPathTracer, GradientEquirectTexture } from 'three-gpu-pathtracer';

// three-gpu-pathtracer 0.0.23 reads Scene.background/environmentRotation (Euler,
// added to three in r163). We pin three 0.160, so shim them lazily per-instance.
for (const prop of ['backgroundRotation', 'environmentRotation']) {
  if (!(prop in THREE.Scene.prototype)) {
    const key = '_' + prop;
    Object.defineProperty(THREE.Scene.prototype, prop, {
      get() { return this[key] || (this[key] = new THREE.Euler()); },
      set(v) { this[key] = v; },
      configurable: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Wood species: pricing (used by app.js) + colour palette for procedural grain
// ---------------------------------------------------------------------------
export const WOOD = {
  sosna: {
    label: 'Sosna',
    pricePerM3: 3200, pricePerM2: 900,
    base: [216, 170, 116], grain: [150, 105, 58], streak: [120, 78, 40],
    roughness: 0.62,
  },
  orzech: {
    label: 'Orzech',
    pricePerM3: 9800, pricePerM2: 2600,
    base: [92, 58, 35], grain: [60, 36, 20], streak: [38, 22, 12],
    roughness: 0.5,
  },
};

const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`;
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const COUNTER_H = 0.9;      // worktop height (m)
const WALL_Z = -0.35;       // back wall plane
const TABLE_Z = 0.6;        // table sits forward, in the middle of the room

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
export function initScene(container, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';

  RectAreaLightUniformsLib.init();

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  // RoomEnvironment is the instant, offline fallback; the HDRI below upgrades
  // reflections/lighting once it streams in (and degrades gracefully if absent)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.background = new THREE.Color('#d9cdbb');

  // raster uses the prefiltered PMREM env; the path tracer needs the raw
  // equirectangular HDR for its environment importance sampling, so keep both
  let hdrEquirect = null;
  new RGBELoader().setDataType(THREE.FloatType).load('/assets/env.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    hdrEquirect = hdr;
    scene.environment = pmrem.fromEquirectangular(hdr).texture;
  });

  const camera = new THREE.PerspectiveCamera(42, 1, 0.05, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 7;
  controls.maxPolarAngle = Math.PI * 0.495;

  // two environments, toggled by product
  const livingRoom = buildLivingRoom(); scene.add(livingRoom);
  const kitchen = buildKitchen(); scene.add(kitchen); kitchen.visible = false;
  const dining = buildDiningRoom(); scene.add(dining); dining.visible = false;
  const lights = addLights(scene);

  // dynamic product groups
  const shelfGroup = new THREE.Group(); scene.add(shelfGroup);
  const counterGroup = new THREE.Group(); scene.add(counterGroup); counterGroup.visible = false;
  const tableGroup = new THREE.Group(); tableGroup.position.z = TABLE_Z; scene.add(tableGroup); tableGroup.visible = false;

  const contact = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({ map: makeContactShadow(), transparent: true, depthWrite: false })
  );
  contact.rotation.x = -Math.PI / 2; contact.position.y = 0.005; contact.renderOrder = 1;
  scene.add(contact);

  // PBR wood: photo albedo + normal + roughness maps, cached per species
  const texLoader = new THREE.TextureLoader();
  const WOOD_TILE = 0.4;   // grain density (tiles per board-unit)
  const woodMatCache = {};
  function getWoodMat(wood) {
    if (!woodMatCache[wood]) {
      const base = '/assets/wood/' + wood;
      const map = texLoader.load(base + '_diff.jpg');
      const normalMap = texLoader.load(base + '_nor.jpg');
      const roughnessMap = texLoader.load(base + '_rough.jpg');
      map.colorSpace = THREE.SRGBColorSpace;
      for (const t of [map, normalMap, roughnessMap]) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; }
      woodMatCache[wood] = new THREE.MeshStandardMaterial({
        map, normalMap, roughnessMap, roughness: 1, metalness: 0, envMapIntensity: 0.85,
      });
    }
    return woodMatCache[wood];
  }

  // clone a wood material with its own per-mesh texture repeat (natural grain)
  function woodInstance(mat, repU, repV) {
    const m = mat.clone();
    const u = Math.max(0.5, repU * WOOD_TILE), v = Math.max(0.5, repV * WOOD_TILE);
    for (const key of ['map', 'normalMap', 'roughnessMap']) {
      if (!mat[key]) continue;
      m[key] = mat[key].clone();
      m[key].needsUpdate = true;
      m[key].wrapS = m[key].wrapT = THREE.RepeatWrapping;
      m[key].repeat.set(u, v);
    }
    if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    return m;
  }

  function board(mat, sx, sy, sz, px, py, pz, repU = 1, repV = 1) {
    const mesh = new THREE.Mesh(roundedBox(sx, sy, sz), woodInstance(mat, repU, repV));
    mesh.position.set(px, py, pz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }

  // a wood cylinder (round tabletop) with the same material treatment
  function disc(mat, radius, h, px, py, pz, rep = 4) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 64), woodInstance(mat, rep, rep));
    mesh.position.set(px, py, pz);
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }

  // ---- shelf (regał) -----------------------------------------------------
  function buildShelf(state) {
    shelfGroup.clear();
    const mat = getWoodMat(state.wood);
    const w = state.width / 100, h = state.height / 100, d = state.depth / 100;
    const t = 0.02, back = 0.01;
    const x0 = -w / 2 + t / 2, x1 = w / 2 - t / 2;
    const vRep = Math.max(2, Math.round(h * 4)), hRep = Math.max(2, Math.round(w * 4));

    shelfGroup.add(board(mat, t, h, d, x0, h / 2, 0, 1, vRep));
    shelfGroup.add(board(mat, t, h, d, x1, h / 2, 0, 1, vRep));
    shelfGroup.add(board(mat, w - 2 * t, t, d, 0, h - t / 2, 0, hRep, 1));
    shelfGroup.add(board(mat, w - 2 * t, t, d, 0, t / 2, 0, hRep, 1));
    shelfGroup.add(board(mat, w - 2 * t, h - 2 * t, back, 0, h / 2, -d / 2 + back / 2, hRep, vRep));

    const n = state.shelves;
    const innerH = h - 2 * t, gap = innerH / (n + 1);
    for (let i = 1; i <= n; i++) {
      shelfGroup.add(board(mat, w - 2 * t, t, d - back, 0, t + gap * i, back / 2, hRep, 1));
    }

    contact.scale.set(w * 1.9, d * 2.6, 1);
    contact.position.z = 0;
    lights.frame(h, w, d);
    controls.target.set(0, h / 2, 0);
  }

  // ---- countertop (blat kuchenny) ----------------------------------------
  function buildCounter(state) {
    counterGroup.clear();
    const L = state.width / 100, D = state.depth / 100, T = state.thickness / 100;
    const zBack = WALL_Z + 0.01;
    const zCenter = zBack + D / 2;

    // base cabinets (cream shaker) under the worktop
    const cabH = COUNTER_H - 0.09;            // leave a toe kick
    const cabD = D - 0.04;                    // worktop overhangs the front
    const cabZ = zBack + cabD / 2;
    const carcassMat = new THREE.MeshStandardMaterial({ color: '#d9cfbd', roughness: 0.7 });
    const frontMat = new THREE.MeshStandardMaterial({ color: '#e9e1d1', roughness: 0.55 });
    const insetMat = new THREE.MeshStandardMaterial({ color: '#ded4c2', roughness: 0.6 });
    const brass = new THREE.MeshStandardMaterial({ color: '#b89357', roughness: 0.3, metalness: 0.9 });

    const carcass = new THREE.Mesh(roundedBox(L, cabH, cabD), carcassMat);
    carcass.position.set(0, 0.09 + cabH / 2, cabZ);
    carcass.castShadow = carcass.receiveShadow = true;
    counterGroup.add(carcass);

    // toe kick (recessed dark base)
    const kick = new THREE.Mesh(
      new THREE.BoxGeometry(L - 0.02, 0.09, cabD - 0.08),
      new THREE.MeshStandardMaterial({ color: '#4a4036', roughness: 0.9 })
    );
    kick.position.set(0, 0.045, cabZ + 0.02);
    counterGroup.add(kick);

    // doors with inset panels + handles
    const front = zBack + cabD;
    const nDoors = Math.max(1, Math.round(L / 0.6));
    const doorW = L / nDoors;
    for (let i = 0; i < nDoors; i++) {
      const dx = -L / 2 + doorW * (i + 0.5);
      const door = new THREE.Mesh(roundedBox(doorW - 0.02, cabH - 0.03, 0.02), frontMat);
      door.position.set(dx, 0.09 + cabH / 2, front - 0.01);
      door.castShadow = true; counterGroup.add(door);
      const panel = new THREE.Mesh(roundedBox(doorW - 0.14, cabH - 0.15, 0.012), insetMat);
      panel.position.set(dx, 0.09 + cabH / 2, front);
      counterGroup.add(panel);
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.09, 0.018), brass);
      handle.position.set(dx + doorW / 2 - 0.06, 0.09 + cabH - 0.18, front + 0.005);
      counterGroup.add(handle);
    }

    // the worktop slab — the hero, in the chosen wood
    const slab = board(getWoodMat(state.wood), L, T, D, 0, COUNTER_H + T / 2, zCenter,
                       Math.max(3, Math.round(L * 3.5)), Math.max(2, Math.round(D * 3.5)));
    counterGroup.add(slab);

    // faucet (chrome) + a ceramic fruit bowl for life
    counterGroup.add(makeFaucet(-L * 0.28, COUNTER_H + T, zBack + 0.12));
    counterGroup.add(makeBowl(L * 0.26, COUNTER_H + T, zBack + D * 0.45));

    lights.frame(COUNTER_H + 0.2, L, D);
    controls.target.set(0, COUNTER_H, 0);
  }

  // ---- table (stół) ------------------------------------------------------
  function buildTable(state) {
    tableGroup.clear();
    const topMat = getWoodMat(state.wood);       // blat
    const legMat = getWoodMat(state.woodLegs);   // nogi
    const H = state.height / 100;
    const topT = 0.04;
    const legH = H - topT;
    const legS = 0.06;                            // square leg cross-section
    const apronH = 0.07, apronT = 0.025;
    const round = state.shape === 'okragly';

    // footprint half-extents used for legs, aprons, contact shadow
    let hx, hz, r = 0;
    if (round) {
      r = state.diameter / 200;
      // legs sit on a circle of radius legR; their (x,z) is legR/√2 so the
      // diagonal distance from the centre stays legR (well inside the top)
      const legR = r * 0.74;
      hx = hz = legR * Math.SQRT1_2;
      tableGroup.add(disc(topMat, r, topT, 0, H - topT / 2, 0, Math.max(3, Math.round(r * 6))));
      // apron ring just under the top, just outside the legs
      const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(legR + 0.03, legR + 0.03, apronH, 48, 1, true),
        legMat.clone()
      );
      ring.position.y = H - topT - apronH / 2; ring.castShadow = true; tableGroup.add(ring);
    } else {
      const w = state.width / 100, l = state.length / 100;   // w = depth(z), l = length(x)
      hx = l / 2 - legS / 2 - 0.04;
      hz = w / 2 - legS / 2 - 0.04;
      tableGroup.add(board(topMat, l, topT, w, 0, H - topT / 2, 0,
                           Math.max(3, Math.round(l * 3.5)), Math.max(2, Math.round(w * 3.5))));
      // four aprons just under the top
      const ay = H - topT - apronH / 2;
      tableGroup.add(board(legMat, l - legS * 2, apronH, apronT, 0, ay, hz, 4, 1));
      tableGroup.add(board(legMat, l - legS * 2, apronH, apronT, 0, ay, -hz, 4, 1));
      tableGroup.add(board(legMat, apronT, apronH, w - legS * 2, hx, ay, 0, 1, 2));
      tableGroup.add(board(legMat, apronT, apronH, w - legS * 2, -hx, ay, 0, 1, 2));
    }

    // four legs
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      tableGroup.add(board(legMat, legS, legH, legS, sx * hx, legH / 2, sz * hz, 1, Math.max(2, Math.round(legH * 5))));
    }

    contact.scale.set((round ? r * 2 : (hx + legS)) * 1.9, (round ? r * 2 : (hz + legS)) * 1.9, 1);
    contact.position.set(0, 0.005, TABLE_Z);
    lights.frame(H + 0.1, hx * 2 + 0.4, hz * 2 + 0.4);
    controls.target.set(0, H * 0.6, TABLE_Z);
  }

  // ---- camera framing per product ----------------------------------------
  function applyCameraPreset(product) {
    if (product === 'blat') {
      camera.position.set(2.1, 1.55, 2.9);
      controls.target.set(0, COUNTER_H, 0);
    } else if (product === 'stol') {
      camera.position.set(2.5, 1.6, 3.6);
      controls.target.set(0, 0.5, TABLE_Z);
    } else {
      camera.position.set(2.0, 1.5, 3.0);
      controls.target.set(0, 0.9, 0);
    }
    controls.update();
  }

  // ---- dispatch ----------------------------------------------------------
  let currentProduct = null;
  function update(state) {
    const switched = currentProduct !== state.product;
    currentProduct = state.product;

    livingRoom.visible = kitchen.visible = dining.visible = false;
    shelfGroup.visible = counterGroup.visible = tableGroup.visible = false;
    contact.visible = false;

    if (state.product === 'blat') {
      kitchen.visible = true; counterGroup.visible = true;
      buildCounter(state);
    } else if (state.product === 'stol') {
      dining.visible = true; tableGroup.visible = true; contact.visible = true;
      buildTable(state);
    } else {
      livingRoom.visible = true; shelfGroup.visible = true; contact.visible = true;
      buildShelf(state);
    }
    if (switched) applyCameraPreset(state.product);
  }

  // ---- resize + render loop ----------------------------------------------
  // ---- post-processing: AO + soft bloom + anti-aliasing ------------------
  // (all offline, no external assets — pushes the look closer to a render)
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  const ssao = new SSAOPass(scene, camera, 1, 1);
  ssao.kernelRadius = 0.12;        // metre-scale scene → small radius
  ssao.minDistance = 0.0008;
  ssao.maxDistance = 0.06;
  composer.addPass(ssao);

  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.18, 0.7, 0.95);
  composer.addPass(bloom);

  composer.addPass(new SMAAPass(1, 1));
  composer.addPass(new OutputPass());

  // ---- path tracing (offline, on demand) ---------------------------------
  // The real-time raster view is for configuring; "Render HD" path-traces the
  // *current* configuration, accumulating samples into a photoreal still.
  // Any change (slider, product, camera move, resize) drops back to raster.
  const PT_MAX = 256;       // PBR materials converge clean well before this
  let pathTracer = null;
  let ptActive = false;
  let ptPrevEnv = null;

  // a smooth procedural sky/dome for the tracer to importance-sample — soft
  // ambient fill that converges far faster (less noise) than emissive-only light
  let ptEnv = null;
  function getPtEnv() {
    if (!ptEnv) {
      ptEnv = new GradientEquirectTexture(1024);
      ptEnv.topColor.set('#eaf1fb');
      ptEnv.bottomColor.set('#c7b08c');
      ptEnv.exponent = 1.2;
      ptEnv.update();
    }
    return ptEnv;
  }

  let lastW = 0, lastH = 0;
  function resize() {
    if (ptActive) return;   // never disturb an in-progress path trace
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    if (w === lastW && h === lastH) return;   // ignore spurious observer fires
    lastW = w; lastH = h;
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  function startHD() {
    try {
      if (!pathTracer) {
        pathTracer = new WebGLPathTracer(renderer);
        pathTracer.tiles.set(3, 3);          // split work → UI stays responsive
        pathTracer.filterGlossyFactor = 1.0; // strongly tame glossy fireflies
        pathTracer.bounces = 4;
        pathTracer.renderScale = 0.6;        // fewer pixels → more samples/sec
      }
      // light the trace with a smooth procedural environment (importance-sampled
      // → low noise, fast convergence). A full HDRI here is far slower to sample
      // for little gain in an enclosed room; the HDRI still drives raster env.
      ptPrevEnv = scene.environment;
      scene.environment = getPtEnv();
      pathTracer.setScene(scene, camera);
      ptActive = true;
      opts.onHD?.({ active: true, samples: 0, max: PT_MAX });
    } catch (err) {
      console.error('[pathtracer] startHD failed:', err);
      scene.environment = ptPrevEnv || scene.environment;
      ptActive = false;
      opts.onHD?.({ active: false, error: String(err && err.message || err) });
    }
  }

  function stopHD() {
    if (!ptActive) return;
    ptActive = false;
    if (ptPrevEnv) { scene.environment = ptPrevEnv; ptPrevEnv = null; }
    opts.onHD?.({ active: false });
  }

  controls.addEventListener('start', stopHD);   // any orbit/zoom cancels HD

  // Wstrzymane, gdy scenę i tak zasłania coś na pełnym ekranie (intro promocyjne):
  // dekoder wideo dostaje wtedy GPU dla siebie.
  let paused = false;

  renderer.setAnimationLoop(() => {
    if (paused) return;
    if (ptActive) {
      try {
        if (pathTracer.samples < PT_MAX) {
          pathTracer.renderSample();
          const done = pathTracer.samples >= PT_MAX;
          opts.onHD?.({ active: true, done, samples: Math.floor(pathTracer.samples), max: PT_MAX });
        }
      } catch (err) {
        console.error('[pathtracer] renderSample failed:', err);
        stopHD();
      }
      return;
    }
    controls.update();
    composer.render();
  });

  return {
    update(state) { stopHD(); update(state); },
    startHD,
    stopHD,
    setPaused(v) { paused = v; if (!paused) resize(); },
  };
}

// ---------------------------------------------------------------------------
// Living room environment
// ---------------------------------------------------------------------------
function buildLivingRoom() {
  const g = new THREE.Group();

  const floorTex = makeFloorTexture();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshPhysicalMaterial({
    map: floorTex.map, bumpMap: floorTex.bumpMap, bumpScale: 0.5,
    roughnessMap: floorTex.roughnessMap, roughness: 0.72, metalness: 0,
    clearcoat: 0.35, clearcoatRoughness: 0.55, envMapIntensity: 0.55,
  }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);

  addWalls(g);

  const win = makeWindow(); win.position.set(1.7, 1.6, WALL_Z + 0.01); g.add(win);

  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.5),
    new THREE.MeshStandardMaterial({ map: makeRugTexture(), roughness: 0.98 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.004, 0.95); rug.receiveShadow = true; g.add(rug);

  addFramedArt(g, -1.65, 1.72, 0.5, 0.62, '#7e8d6f', '#cabf99');
  addFramedArt(g, -2.22, 1.45, 0.42, 0.5, '#9a7363', '#d9c6a4');
  g.add(makePlant(1.5, 0.55));
  return g;
}

// ---------------------------------------------------------------------------
// Kitchen environment (static parts; cabinets + slab are rebuilt dynamically)
// ---------------------------------------------------------------------------
function buildKitchen() {
  const g = new THREE.Group();

  const floorTex = makeFloorTexture();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshPhysicalMaterial({
    map: floorTex.map, bumpMap: floorTex.bumpMap, bumpScale: 0.5,
    roughnessMap: floorTex.roughnessMap, roughness: 0.72, metalness: 0,
    clearcoat: 0.3, clearcoatRoughness: 0.55, envMapIntensity: 0.5,
  }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);

  addWalls(g);

  // tiled backsplash between worktop and upper cabinets
  const tileTex = makeTileTexture();
  tileTex.repeat.set(16, 4);
  const splash = new THREE.Mesh(new THREE.PlaneGeometry(4, 0.5),
    new THREE.MeshStandardMaterial({ map: tileTex, roughness: 0.35, metalness: 0 }));
  splash.position.set(0, COUNTER_H + 0.3, WALL_Z + 0.005); splash.receiveShadow = true; g.add(splash);

  // upper cabinets (a centred pair)
  const upMat = new THREE.MeshStandardMaterial({ color: '#e9e1d1', roughness: 0.55 });
  const upBody = new THREE.MeshStandardMaterial({ color: '#d9cfbd', roughness: 0.7 });
  const brass = new THREE.MeshStandardMaterial({ color: '#b89357', roughness: 0.3, metalness: 0.9 });
  for (const dx of [-0.45, 0.45]) {
    const body = new THREE.Mesh(roundedBox(0.85, 0.55, 0.34), upBody);
    body.position.set(dx, 1.72, WALL_Z + 0.18); body.castShadow = body.receiveShadow = true; g.add(body);
    const door = new THREE.Mesh(roundedBox(0.8, 0.5, 0.02), upMat);
    door.position.set(dx, 1.72, WALL_Z + 0.36); door.castShadow = true; g.add(door);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.08, 0.018), brass);
    handle.position.set(dx - 0.34, 1.55, WALL_Z + 0.37); g.add(handle);
  }

  const win = makeWindow(); win.position.set(1.75, 1.55, WALL_Z + 0.01); win.scale.set(0.85, 0.85, 1); g.add(win);

  g.add(makePlant(-1.7, 0.5));
  return g;
}

// ---------------------------------------------------------------------------
// Dining room environment (static; the table is rebuilt dynamically)
// ---------------------------------------------------------------------------
function buildDiningRoom() {
  const g = new THREE.Group();

  const floorTex = makeFloorTexture();
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.MeshPhysicalMaterial({
    map: floorTex.map, bumpMap: floorTex.bumpMap, bumpScale: 0.5,
    roughnessMap: floorTex.roughnessMap, roughness: 0.72, metalness: 0,
    clearcoat: 0.32, clearcoatRoughness: 0.55, envMapIntensity: 0.55,
  }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);

  addWalls(g);

  const win = makeWindow(); win.position.set(1.8, 1.6, WALL_Z + 0.01); g.add(win);

  // large rug centred under the table
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4),
    new THREE.MeshStandardMaterial({ map: makeRugTexture(), roughness: 0.98 }));
  rug.rotation.x = -Math.PI / 2; rug.position.set(0, 0.004, TABLE_Z); rug.receiveShadow = true; g.add(rug);

  addFramedArt(g, -1.7, 1.7, 0.55, 0.68, '#6f8390', '#bcc9c3');
  addFramedArt(g, -2.3, 1.5, 0.4, 0.5, '#9a8463', '#ddcaa1');

  // pendant lamp above the table
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.9, 8),
    new THREE.MeshStandardMaterial({ color: '#2b2b2b', roughness: 0.6 }));
  cord.position.set(0, 2.45, TABLE_Z); g.add(cord);
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.2, 32, 1, true),
    new THREE.MeshStandardMaterial({ color: '#3a3531', roughness: 0.5, metalness: 0.4, side: THREE.DoubleSide }));
  shade.position.set(0, 1.9, TABLE_Z); g.add(shade);
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12),
    new THREE.MeshStandardMaterial({ color: '#fff3d6', emissive: '#ffd28a', emissiveIntensity: 1.4 }));
  bulb.position.set(0, 1.86, TABLE_Z); g.add(bulb);
  const pool = new THREE.PointLight('#ffe2b0', 3.5, 4, 2);
  pool.position.set(0, 1.85, TABLE_Z); g.add(pool);

  g.add(makePlant(1.9, TABLE_Z + 0.2));
  return g;
}

// ---------------------------------------------------------------------------
// Shared building blocks
// ---------------------------------------------------------------------------
function addWalls(g) {
  const wallMat = new THREE.MeshStandardMaterial({ color: '#e7ddcd', roughness: 0.95 });
  const back = new THREE.Mesh(new THREE.PlaneGeometry(12, 4), wallMat);
  back.position.set(0, 2, WALL_Z); back.receiveShadow = true; g.add(back);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(12, 4), wallMat);
  side.rotation.y = Math.PI / 2; side.position.set(-3, 2, 0); side.receiveShadow = true; g.add(side);
  const baseboard = new THREE.Mesh(new THREE.BoxGeometry(12, 0.12, 0.03),
    new THREE.MeshStandardMaterial({ color: '#f3ecdf', roughness: 0.8 }));
  baseboard.position.set(0, 0.06, WALL_Z + 0.015); g.add(baseboard);
}

function makeWindow() {
  const win = new THREE.Group();
  const paneMat = new THREE.MeshStandardMaterial({
    color: '#cfe6f2', emissive: '#bfe0f0', emissiveIntensity: 0.6, roughness: 0.15,
  });
  const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.5), paneMat);
  pane.position.z = 0.01; win.add(pane);
  const frameMat = new THREE.MeshStandardMaterial({ color: '#f5f0e6', roughness: 0.6 });
  const ft = 0.06;
  const addFrame = (sx, sy, px, py) => {
    const f = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.06), frameMat);
    f.position.set(px, py, 0.02); f.castShadow = true; win.add(f);
  };
  addFrame(1.3, ft, 0, 0.78); addFrame(1.3, ft, 0, -0.78);
  addFrame(ft, 1.6, -0.63, 0); addFrame(ft, 1.6, 0.63, 0);
  addFrame(ft, 1.6, 0, 0); addFrame(1.3, ft, 0, 0);
  return win;
}

function addLights(scene) {
  const hemi = new THREE.HemisphereLight('#fff3df', '#574733', 0.4);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight('#ffe1a8', 2.7);
  sun.position.set(2.6, 3.5, 1.2);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.025;
  sun.shadow.radius = 5;
  const cam = sun.shadow.camera;
  cam.near = 0.3; cam.far = 16;
  scene.add(sun); scene.add(sun.target);

  const fill = new THREE.DirectionalLight('#d9e4ff', 0.32);
  fill.position.set(-2.6, 1.8, 2.8); scene.add(fill);

  const glow = new THREE.PointLight('#ffcf8f', 4, 6, 2);
  glow.position.set(1.6, 1.5, 0.15); scene.add(glow);

  // soft daylight pouring in from the window (no shadows, but lovely soft fill
  // + highlights on glossy surfaces — the windows in all three rooms align)
  const area = new THREE.RectAreaLight('#fff1d6', 5, 1.2, 1.5);
  area.position.set(1.72, 1.55, WALL_Z + 0.05);
  area.lookAt(-0.3, 0.8, 1.4);
  scene.add(area);

  return {
    frame(h, w, d) {
      sun.target.position.set(0, h * 0.45, 0);
      sun.target.updateMatrixWorld();
      const ext = Math.max(w, h, d) * 0.7 + 0.6;
      cam.left = -ext; cam.right = ext; cam.top = ext + h * 0.25; cam.bottom = -ext;
      cam.updateProjectionMatrix();
    },
  };
}

// box with softly chamfered edges — catches light like a real machined panel
function roundedBox(w, h, d, maxR = 0.012) {
  const r = Math.max(0.0012, Math.min(maxR, Math.min(w, h, d) * 0.45));
  return new RoundedBoxGeometry(w, h, d, 3, r);
}

function makeFaucet(px, py, pz) {
  const g = new THREE.Group();
  const metal = new THREE.MeshStandardMaterial({ color: '#cfd3d6', roughness: 0.22, metalness: 0.95 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.04, 16), metal);
  base.position.y = 0.02; g.add(base);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.013, 0.2, 16), metal);
  stem.position.y = 0.14; g.add(stem);
  const neck = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.013, 12, 24, Math.PI), metal);
  neck.position.set(0, 0.24, 0); neck.rotation.set(Math.PI / 2, 0, 0); g.add(neck);
  const spout = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.011, 0.06, 16), metal);
  spout.position.set(0.06, 0.21, 0); g.add(spout);
  g.traverse((m) => { if (m.isMesh) m.castShadow = true; });
  g.position.set(px, py, pz);
  return g;
}

function makeBowl(px, py, pz) {
  const g = new THREE.Group();
  const bowl = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.07, 0.06, 28, 1, false),
    new THREE.MeshStandardMaterial({ color: '#f3efe8', roughness: 0.35 })
  );
  bowl.position.y = 0.03; bowl.castShadow = bowl.receiveShadow = true; g.add(bowl);
  const fruit = ['#d98b3a', '#c34a3a', '#7fa356', '#d9a93a'];
  const spots = [[-0.03, 0.02], [0.035, -0.01], [0, 0.04], [0.01, -0.04]];
  spots.forEach(([fx, fz], i) => {
    const f = new THREE.Mesh(new THREE.SphereGeometry(0.028, 16, 12),
      new THREE.MeshStandardMaterial({ color: fruit[i % fruit.length], roughness: 0.6 }));
    f.position.set(fx, 0.07, fz); f.castShadow = true; g.add(f);
  });
  g.position.set(px, py, pz);
  return g;
}

// ---------------------------------------------------------------------------
// Procedural textures
// ---------------------------------------------------------------------------
function makeFloorTexture() {
  const W = 1024, H = 1024;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; return [c, c.getContext('2d')]; };
  const [c, x] = mk(), [b, bx] = mk(), [r, rx] = mk();

  x.fillStyle = '#3a2616'; x.fillRect(0, 0, W, H);
  bx.fillStyle = '#000000'; bx.fillRect(0, 0, W, H);
  rx.fillStyle = '#bfbfbf'; rx.fillRect(0, 0, W, H);

  let s = 12345;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  const rows = 8, ph = H / rows, gap = 3;

  for (let row = 0; row < rows; row++) {
    const y0 = row * ph, tone = 120 + Math.floor(rnd() * 70);
    let xpos = -rnd() * 0.6 * W;
    while (xpos < W) {
      const segEnd = Math.min(W, xpos + W * (0.5 + rnd() * 0.35));
      const x0 = Math.max(0, xpos), t2 = tone + (rnd() * 24 - 12);
      x.fillStyle = `rgb(${Math.floor(t2 * 1.28)},${Math.floor(t2 * 0.92)},${Math.floor(t2 * 0.6)})`;
      x.fillRect(x0, y0 + gap / 2, segEnd - x0, ph - gap);
      const rl = 150 + Math.floor(rnd() * 40);
      rx.fillStyle = `rgb(${rl},${rl},${rl})`; rx.fillRect(x0, y0 + gap / 2, segEnd - x0, ph - gap);
      for (let i = 0; i < 46; i++) {
        const yy = y0 + gap + rnd() * (ph - gap * 2), a = rnd() * 0.17, lw = 0.6 + rnd() * 1.3;
        x.strokeStyle = `rgba(${Math.floor(t2 * 0.66)},${Math.floor(t2 * 0.46)},28,${a})`;
        x.lineWidth = lw;
        x.beginPath(); x.moveTo(x0, yy);
        x.bezierCurveTo(x0 + (segEnd - x0) * 0.33, yy + (rnd() - 0.5) * 6, x0 + (segEnd - x0) * 0.66, yy + (rnd() - 0.5) * 6, segEnd, yy);
        x.stroke();
        bx.strokeStyle = `rgba(255,255,255,${a * 0.5})`; bx.lineWidth = lw; bx.stroke();
        rx.strokeStyle = `rgba(90,90,90,${a})`; rx.lineWidth = lw; rx.stroke();
      }
      if (rnd() < 0.3) {
        const kx = x0 + 20 + rnd() * Math.max(1, segEnd - x0 - 40), ky = y0 + gap + rnd() * (ph - gap * 2);
        for (let rr = 9; rr > 0; rr -= 1.3) {
          x.beginPath(); x.ellipse(kx, ky, rr * 1.7, rr, 0, 0, Math.PI * 2);
          x.strokeStyle = `rgba(${Math.floor(t2 * 0.5)},${Math.floor(t2 * 0.34)},22,0.22)`; x.lineWidth = 1; x.stroke();
        }
      }
      if (segEnd < W) {
        x.fillStyle = 'rgba(28,16,9,0.9)'; x.fillRect(segEnd - 1, y0 + gap / 2, 2, ph - gap);
        bx.fillStyle = '#000'; bx.fillRect(segEnd - 1, y0 + gap / 2, 2, ph - gap);
      }
      xpos = segEnd;
    }
    x.fillStyle = 'rgba(255,244,222,0.10)'; x.fillRect(0, y0 + gap, W, 2);
    x.fillStyle = 'rgba(18,10,5,0.20)'; x.fillRect(0, y0 + ph - gap - 2, W, 2);
    bx.fillStyle = '#000'; bx.fillRect(0, y0, W, gap);
  }

  const map = new THREE.CanvasTexture(c), bumpMap = new THREE.CanvasTexture(b), roughnessMap = new THREE.CanvasTexture(r);
  for (const t of [map, bumpMap, roughnessMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 6); t.anisotropy = 8;
  }
  map.colorSpace = THREE.SRGBColorSpace;
  return { map, bumpMap, roughnessMap };
}

function makeTileTexture() {
  const W = 256, H = 256;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#cdc4b4'; x.fillRect(0, 0, W, H);     // grout
  const tw = 64, th = 32, gap = 3;
  let s = 5;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let row = 0; row * th < H; row++) {
    const off = (row % 2) * (tw / 2);
    for (let col = -1; col * tw < W; col++) {
      const tx = col * tw + off, ty = row * th;
      const shade = 238 + Math.floor(rnd() * 14);
      x.fillStyle = `rgb(${shade},${shade - 4},${shade - 12})`;
      x.fillRect(tx + gap / 2, ty + gap / 2, tw - gap, th - gap);
      x.fillStyle = 'rgba(255,255,255,0.25)';      // top bevel
      x.fillRect(tx + gap / 2, ty + gap / 2, tw - gap, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function makeRugTexture() {
  const W = 512, H = 384;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#9c8466'; x.fillRect(0, 0, W, H);
  let s = 99;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 16000; i++) {
    const light = rnd() < 0.5;
    x.fillStyle = `rgba(${light ? 255 : 60},${light ? 240 : 50},${light ? 210 : 40},${rnd() * 0.05})`;
    x.fillRect(rnd() * W, rnd() * H, 1, 1);
  }
  x.strokeStyle = '#6f5b42'; x.lineWidth = 26; x.strokeRect(13, 13, W - 26, H - 26);
  x.strokeStyle = '#c8b48f'; x.lineWidth = 4; x.strokeRect(36, 36, W - 72, H - 72);
  x.strokeStyle = 'rgba(200,180,143,0.7)'; x.lineWidth = 3;
  for (let i = -5; i <= 5; i++) {
    const cxp = W / 2 + i * 46;
    x.beginPath();
    x.moveTo(cxp, H / 2 - 42); x.lineTo(cxp + 42, H / 2); x.lineTo(cxp, H / 2 + 42); x.lineTo(cxp - 42, H / 2);
    x.closePath(); x.stroke();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

function makeContactShadow() {
  const S = 256;
  const c = document.createElement('canvas'); c.width = c.height = S;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(18,11,5,0.55)');
  g.addColorStop(0.45, 'rgba(18,11,5,0.30)');
  g.addColorStop(1, 'rgba(18,11,5,0)');
  x.fillStyle = g; x.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// Decor
// ---------------------------------------------------------------------------
function addFramedArt(g, px, py, w, h, c1, c2) {
  const z = WALL_Z + 0.03;
  const frame = new THREE.Mesh(roundedBox(w + 0.06, h + 0.06, 0.03, 0.006),
    new THREE.MeshStandardMaterial({ color: '#3c2a1a', roughness: 0.5, metalness: 0.1 }));
  frame.position.set(px, py, z); frame.castShadow = true; g.add(frame);

  const cnv = document.createElement('canvas'); cnv.width = cnv.height = 256;
  const cx = cnv.getContext('2d');
  const grad = cx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, c1); grad.addColorStop(1, c2);
  cx.fillStyle = grad; cx.fillRect(0, 0, 256, 256);
  cx.fillStyle = 'rgba(255,255,255,0.18)'; cx.beginPath(); cx.arc(168, 92, 58, 0, Math.PI * 2); cx.fill();
  cx.fillStyle = 'rgba(0,0,0,0.12)'; cx.fillRect(22, 160, 212, 44);
  const tex = new THREE.CanvasTexture(cnv); tex.colorSpace = THREE.SRGBColorSpace;

  const art = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75 }));
  art.position.set(px, py, z + 0.018); g.add(art);
}

function makePlant(px, pz) {
  const g = new THREE.Group();
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.24, 24),
    new THREE.MeshStandardMaterial({ color: '#b06a44', roughness: 0.85 }));
  pot.position.y = 0.12; pot.castShadow = pot.receiveShadow = true; g.add(pot);
  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.115, 0.02, 24),
    new THREE.MeshStandardMaterial({ color: '#3a2a1c', roughness: 1 }));
  soil.position.y = 0.235; g.add(soil);
  const greens = ['#5e7d4a', '#6f9156', '#54703f'];
  const blobs = [[0, 0.46, 0, 0.22], [0.13, 0.6, 0.05, 0.16], [-0.11, 0.58, -0.05, 0.15], [0.05, 0.74, 0.02, 0.13]];
  blobs.forEach(([bx, by, bz, r], i) => {
    const m = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1),
      new THREE.MeshStandardMaterial({ color: greens[i % greens.length], roughness: 0.85, flatShading: true }));
    m.position.set(bx, by, bz); m.castShadow = true; g.add(m);
  });
  g.position.set(px, 0, pz);
  return g;
}
