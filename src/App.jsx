import React, { useEffect, useReducer, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";

// Put ferrari.glb in your project's public/models folder. If it cannot be
// loaded, the scene falls back to the procedural cars.
const CAR_MODEL_URL = "/models/ferrari.glb";
let carPromise = null;

// Loads the car once, scales it to about 4.4 m, centres it on x/z, puts its
// base on the road (y = 0) and points its nose along +z (forward in the scene).
function loadCarModel() {
  if (!carPromise) {
    carPromise = new Promise((resolve, reject) => {
      const draco = new DRACOLoader();
      draco.setDecoderPath("https://www.gstatic.com/draco/versioned/decoders/1.5.7/");
      const loader = new GLTFLoader();
      loader.setDRACOLoader(draco);
      loader.load(
        CAR_MODEL_URL,
        (gltf) => {
          const car = gltf.scene;
          // The model's nose points to -z (headlights and windscreen are at -z), but the
          // scene drives along +z, so turn it around to face forward.
          car.rotation.y = Math.PI;
          const wrap = new THREE.Group();
          wrap.add(car);
          const s1 = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
          wrap.scale.setScalar(4.4 / Math.max(s1.x, s1.z));
          const b = new THREE.Box3().setFromObject(wrap);
          const c = b.getCenter(new THREE.Vector3());
          wrap.position.set(-c.x, -b.min.y, -c.z);
          wrap.traverse((o) => {
            if (o.isMesh) {
              o.castShadow = true;
              o.receiveShadow = true;
            }
          });
          resolve(wrap);
        },
        undefined,
        reject
      );
    });
  }
  return carPromise;
}

// ---------------------------------------------------------------------------
// Constants. World units are metres: x east, z south, y up. Left-hand traffic.
// ---------------------------------------------------------------------------
const NAMES = ["North", "East", "South", "West"];
const YELLOW = 3;
const ALLRED = 2;
const MIN_GREEN = 10;
const MAX_GREEN = 60;
const FIXED_GREEN = 30;
const DISCHARGE = 0.5; // vehicles per second leaving on green
const COLORS = { green: "#35d07a", yellow: "#ffc531", red: "#ff5c52", blue: "#3b9cff" };
const APPROACHES = [
  { lane: [3, 0], back: [0, -1], head: [8.5, -8.5] },
  { lane: [0, 3], back: [1, 0], head: [8.5, 8.5] },
  { lane: [-3, 0], back: [0, 1], head: [-8.5, 8.5] },
  { lane: [0, -3], back: [-1, 0], head: [-8.5, -8.5] },
];
const VIEWS = {
  aerial: { t: 0.75, p: 1.0, r: 80 },
  top: { t: 0, p: 0.12, r: 105 },
  street: { t: 2.4, p: 1.3, r: 42 },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const greenFor = (q, adaptive) =>
  adaptive ? Math.max(MIN_GREEN, Math.min(MAX_GREEN, Math.ceil(q / DISCHARGE) + 6)) : FIXED_GREEN;
const clock = (sec) => {
  const s = Math.floor(sec);
  return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
};
const fmtCount = (sec) => {
  const s = Math.max(0, Math.ceil(sec));
  return s >= 60 ? Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0") : String(s);
};
const level = (v) => (v <= 3 ? "Light" : v <= 6 ? "Moderate" : "Heavy");
const entry = (t, msg, kind = "info") => ({ id: Math.random(), t, msg, kind });

// ---------------------------------------------------------------------------
// Signal simulation
// ---------------------------------------------------------------------------
function initial() {
  const queues = [5, 3, 4, 2];
  const g = greenFor(queues[0], true);
  return {
    cur: 0,
    stage: "green", // green | yellow | allred
    left: g,
    total: g,
    queues,
    rates: [4, 6, 3, 5],
    passed: [0, 0, 0, 0],
    hist: [],
    cycles: 0,
    adaptive: true,
    paused: false,
    hold: false,
    speed: 1,
    clock: 0,
    log: [entry(0, `North green for ${g} s`)],
  };
}

function reduce(s, a) {
  switch (a.type) {
    case "tick": {
      if (s.paused) return s;
      const dt = a.dt;
      const queues = s.queues.map((q, i) => Math.min(60, q + (s.rates[i] * dt) / 60));
      const clk = s.clock + dt;
      if (s.hold) return { ...s, queues, clock: clk };

      const passed = s.passed.slice();
      if (s.stage === "green") {
        const out = Math.min(queues[s.cur], DISCHARGE * dt);
        queues[s.cur] -= out;
        passed[s.cur] += out;
      }
      const n = { ...s, queues, passed, clock: clk, left: s.left - dt };
      let gap = false;
      if (n.stage === "green" && n.adaptive && queues[n.cur] < 0.4 && n.total - n.left >= MIN_GREEN) {
        n.left = 0;
        gap = true;
      }
      if (Math.floor(clk / 2) !== Math.floor(s.clock / 2)) {
        n.hist = [...s.hist, { t: clk, q: queues.map((v) => Math.round(v)) }].slice(-60);
      }
      if (n.left <= 0) {
        let msg;
        let kind = "info";
        if (n.stage === "green") {
          n.stage = "yellow";
          n.left = n.total = YELLOW;
          msg = `${NAMES[n.cur]} yellow${gap ? " (queue cleared early)" : ""}`;
        } else if (n.stage === "yellow") {
          n.stage = "allred";
          n.left = n.total = ALLRED;
          msg = "All approaches red for clearance";
        } else {
          n.cur = (n.cur + 1) % 4;
          if (n.cur === 0) n.cycles += 1;
          n.stage = "green";
          const g = greenFor(queues[n.cur], n.adaptive);
          n.left = n.total = g;
          msg = `${NAMES[n.cur]} green for ${g} s`;
          if (queues[n.cur] > 40) kind = "warn";
        }
        n.log = [entry(clk, msg, kind), ...s.log].slice(0, 8);
      }
      return n;
    }
    case "pause":
      return { ...s, paused: !s.paused };
    case "speed":
      return { ...s, speed: a.v };
    case "adaptive":
      return { ...s, adaptive: a.v };
    case "rate": {
      const rates = s.rates.slice();
      rates[a.i] = a.v;
      return { ...s, rates };
    }
    case "hold":
      if (!s.hold) {
        return {
          ...s,
          hold: true,
          stage: "allred",
          left: ALLRED,
          total: ALLRED,
          log: [entry(s.clock, "Emergency hold: all signals red", "crit"), ...s.log].slice(0, 8),
        };
      }
      return {
        ...s,
        hold: false,
        log: [entry(s.clock, "Hold released, cycle restarting", "info"), ...s.log].slice(0, 8),
      };
    case "reset":
      return initial();
    default:
      return s;
  }
}

function sigState(s, i) {
  if (s.hold || i !== s.cur) return "red";
  return s.stage === "green" ? "green" : s.stage === "yellow" ? "yellow" : "red";
}

function waitFor(s, i) {
  if (s.hold) return null;
  if (i === s.cur && s.stage === "green") return 0;
  let rem = s.stage === "green" ? s.left + YELLOW + ALLRED : s.stage === "yellow" ? s.left + ALLRED : s.left;
  let k = (s.cur + 1) % 4;
  while (k !== i) {
    rem += greenFor(s.queues[k], s.adaptive) + YELLOW + ALLRED;
    k = (k + 1) % 4;
  }
  return rem;
}

function cycleTime(s) {
  return Math.round(s.queues.reduce((sum, q) => sum + greenFor(q, s.adaptive) + YELLOW + ALLRED, 0));
}

// ---------------------------------------------------------------------------
// 3D scene
// ---------------------------------------------------------------------------
function windowTexture(base, lit) {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 256;
  const x = c.getContext("2d");
  x.fillStyle = base;
  x.fillRect(0, 0, 128, 256);
  for (let r = 0; r < 16; r++) {
    for (let k = 0; k < 4; k++) {
      x.fillStyle = Math.random() < 0.18 ? lit : "#1c2630";
      x.fillRect(8 + k * 29, 8 + r * 15, 18, 9);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  return t;
}

function JunctionScene({ stateRef, view, auto, onView, onAuto }) {
  const hostRef = useRef(null);
  const ctl = useRef({ auto: false, setView: null, zoom: null });
  const [failed, setFailed] = useState(false);
  const [carTpl, setCarTpl] = useState(null);
  const viewRef = useRef(view.name);
  viewRef.current = view.name;

  useEffect(() => {
    let alive = true;
    loadCarModel()
      .then((t) => alive && setCarTpl(t))
      .catch(() => alive && setCarTpl(false));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    ctl.current.auto = auto;
  }, [auto]);
  useEffect(() => {
    if (ctl.current.setView) ctl.current.setView(view.name);
  }, [view]);

  useEffect(() => {
    const host = hostRef.current;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (e) {
      setFailed(true);
      return undefined;
    }
    renderer.setPixelRatio(Math.min(Math.max(window.devicePixelRatio || 1, 2), 3));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const el = renderer.domElement;
    host.appendChild(el);

    let W = host.clientWidth || 800;
    let H = host.clientHeight || 500;
    renderer.setSize(W, H, false);

    const scene = new THREE.Scene();
    const sky = 0x7f93a6;
    scene.background = new THREE.Color(0x1a2430);
    scene.fog = new THREE.Fog(0x1f2a36, 140, 330);

    const camera = new THREE.PerspectiveCamera(42, W / H, 0.5, 700);

    const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x2a2f2a, 0.9);
    const sun = new THREE.DirectionalLight(0xfff1dc, 1.7);
    sun.position.set(-45, 80, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    Object.assign(sun.shadow.camera, { left: -75, right: 75, top: 75, bottom: -75, near: 10, far: 240 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0005;
    scene.add(hemi, sun);

    const M = {
      asphalt: new THREE.MeshStandardMaterial({ color: 0x3b4046, roughness: 0.95, metalness: 0 }),
      sidewalk: new THREE.MeshStandardMaterial({ color: 0x9aa1a6, roughness: 0.9 }),
      grass: new THREE.MeshStandardMaterial({ color: 0x4f6b3e, roughness: 1 }),
      paint: new THREE.MeshBasicMaterial({ color: 0xf1f3f4 }),
      yellow: new THREE.MeshBasicMaterial({ color: 0xf2c94c }),
      pole: new THREE.MeshStandardMaterial({ color: 0x2c3238, metalness: 0.6, roughness: 0.4 }),
      headBox: new THREE.MeshStandardMaterial({ color: 0x0d1013, roughness: 0.6 }),
      glass: new THREE.MeshStandardMaterial({ color: 0x1d2a35, roughness: 0.2, metalness: 0.4 }),
      tyre: new THREE.MeshStandardMaterial({ color: 0x111417, roughness: 0.9 }),
      rim: new THREE.MeshStandardMaterial({ color: 0xb8bec4, metalness: 0.9, roughness: 0.3 }),
      trunk: new THREE.MeshStandardMaterial({ color: 0x4a3a2a, roughness: 1 }),
      canopy: new THREE.MeshStandardMaterial({ color: 0x3f6b35, roughness: 1 }),
    };

    const add = (geo, mat, x, y, z, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = shadow;
      scene.add(m);
      return m;
    };

    // Ground, sidewalks, roads
    const ground = add(new THREE.PlaneGeometry(600, 600), M.grass, 0, 0, 0, false);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    add(new THREE.BoxGeometry(12, 0.1, 220), M.asphalt, 0, 0.05, 0);
    add(new THREE.BoxGeometry(220, 0.1, 12), M.asphalt, 0, 0.055, 0);
    [[9.5, 9.5], [-9.5, 9.5], [9.5, -9.5], [-9.5, -9.5]].forEach(([x, z]) =>
      add(new THREE.BoxGeometry(7, 0.22, 7), M.sidewalk, x, 0.11, z)
    );
    // Curb edges along the roads
    for (const sg of [-1, 1]) {
      add(new THREE.BoxGeometry(0.4, 0.3, 220), M.sidewalk, sg * 6.2, 0.15, 0, false);
      add(new THREE.BoxGeometry(220, 0.3, 0.4), M.sidewalk, 0, 0.15, sg * 6.2, false);
    }

    // Lane markings: dashed centre lines and yellow edge lines
    const dash = new THREE.BoxGeometry(0.3, 0.02, 3);
    for (let k = 0; k < 12; k++) {
      const o = 16 + k * 6;
      [o, -o].forEach((v) => {
        add(dash, M.yellow, 0, 0.12, v, false);
        add(dash, M.yellow, v, 0.12, 0, false).rotation.y = Math.PI / 2;
      });
    }
    for (const sg of [-1, 1]) {
      add(new THREE.BoxGeometry(0.2, 0.02, 60), M.paint, sg * 5.6, 0.12, 0, false);
    }

    // Zebra crossings
    const stripe = new THREE.BoxGeometry(0.8, 0.02, 2.4);
    APPROACHES.forEach(({ back }) => {
      for (let m = 0; m < 8; m++) {
        const across = -5.6 + m * 1.6;
        if (back[0] === 0) add(stripe, M.paint, across, 0.13, back[1] * 10.2, false);
        else add(stripe, M.paint, back[0] * 10.2, 0.13, across, false).rotation.y = Math.PI / 2;
      }
    });

    // Buildings around the four blocks, each with its own window texture
    const plan = [[22, 22, 12, 18], [38, 22, 10, 30], [22, 38, 14, 14], [40, 40, 12, 38]];
    const palettes = [["#8a939b", "#ffd98a"], ["#a7a095", "#ffe6a8"], ["#5f6b76", "#9ed6ff"]];
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach((sg, qi) =>
      plan.forEach((bp, bi) => {
        const [base, lit] = palettes[(qi + bi) % palettes.length];
        const h = bp[3] + ((qi + bi) % 3) * 6;
        const tex = windowTexture(base, lit);
        tex.repeat.set(Math.max(1, Math.round(bp[2] / 6)), Math.max(1, Math.round(h / 12)));
        const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.05 });
        add(new THREE.BoxGeometry(bp[2], h, bp[2]), mat, sg[0] * bp[0], h / 2, sg[1] * bp[1]);
      })
    );

    // Trees at the corners of each block
    [[1, 1], [-1, 1], [1, -1], [-1, -1]].forEach(([sx, sz]) => {
      const x = sx * 14.5;
      const z = sz * 14.5;
      add(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 8), M.trunk, x, 1.1, z);
      add(new THREE.SphereGeometry(2.3, 12, 10), M.canopy, x, 3.6, z);
    });

    // Stop lines
    const stopMats = APPROACHES.map(() => new THREE.MeshBasicMaterial({ color: 0xf4f6f7 }));
    APPROACHES.forEach((ap, i) => {
      const vertical = ap.back[0] === 0;
      add(
        new THREE.BoxGeometry(vertical ? 6 : 0.6, 0.02, vertical ? 0.6 : 6),
        stopMats[i],
        ap.lane[0] + ap.back[0] * 7,
        0.14,
        ap.lane[1] + ap.back[1] * 7,
        false
      );
    });

    // Signal poles and lamps with glow
    const lamps = [];
    const glows = [];
    APPROACHES.forEach((q) => {
      const [bx, bz] = q.back;
      const [hx, hz] = q.head;
      const along = bx === 0;
      add(new THREE.CylinderGeometry(0.2, 0.26, 7, 10), M.pole, hx, 3.5, hz);
      add(new THREE.BoxGeometry(along ? 1.5 : 1.2, 3.8, along ? 1.2 : 1.5), M.headBox, hx, 7.9, hz);
      const ls = {};
      const gs = {};
      [["red", 1.15], ["yellow", 0], ["green", -1.15]].forEach(([state, dy]) => {
        const lx = hx + bx * 0.72;
        const ly = 7.9 + dy;
        const lz = hz + bz * 0.72;
        ls[state] = new THREE.MeshBasicMaterial({ color: 0x2b3238 });
        add(new THREE.SphereGeometry(0.42, 14, 10), ls[state], lx, ly, lz, false);
        const g = add(
          new THREE.SphereGeometry(0.95, 14, 10),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(COLORS[state]), transparent: true, opacity: 0.25, depthWrite: false }),
          lx,
          ly,
          lz,
          false
        );
        g.visible = false;
        gs[state] = g;
      });
      lamps.push(ls);
      glows.push(gs);
    });

    // Vehicles: body, cab, wheels, plus colour variety
    const CAR_COLORS = [0xb8323a, 0x2f6fbd, 0xe8e6e1, 0x272d34, 0xd9a526, 0x4f9a63, 0x7d55b0, 0x9aa3ab];
    const cBody = new THREE.BoxGeometry(2, 1, 4.2);
    const cCab = new THREE.BoxGeometry(1.7, 0.8, 2.2);
    const cWheel = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 18);
    cWheel.rotateZ(Math.PI / 2);
    const cRim = new THREE.CylinderGeometry(0.24, 0.24, 0.32, 10);
    cRim.rotateZ(Math.PI / 2);
    let carCount = 0;
    const makeCar = () => {
      if (carTpl) {
        const real = carTpl.clone();
        real.userData = { wheels: [], brake: [] };
        scene.add(real);
        return real;
      }
      const g = new THREE.Group();
      const color = CAR_COLORS[carCount % CAR_COLORS.length];
      const suv = carCount % 3 === 2;
      carCount++;
      const paint = new THREE.MeshPhysicalMaterial({ color, roughness: 0.28, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 });
      const bodyH = suv ? 1.0 : 0.85;
      const lower = new THREE.Mesh(new THREE.BoxGeometry(2.0, bodyH, 4.3), paint);
      lower.position.y = 0.3 + bodyH / 2;
      lower.castShadow = true;
      g.add(lower);

      // Tapered cabin with glass, plus a roof panel
      const cabH = suv ? 0.95 : 0.75;
      const cabZ = suv ? -0.2 : -0.1;
      const cab = new THREE.Mesh(new THREE.BoxGeometry(1.7, cabH, suv ? 2.5 : 2.2), M.glass);
      cab.position.set(0, 0.3 + bodyH + cabH / 2, cabZ);
      cab.castShadow = true;
      g.add(cab);
      const roof = new THREE.Mesh(new THREE.BoxGeometry(1.76, 0.07, suv ? 2.4 : 2.1), paint);
      roof.position.set(0, cab.position.y + cabH / 2 + 0.03, cabZ);
      g.add(roof);

      // Headlights (white) and taillights (red, brighter while braking)
      const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.8 });
      [-0.65, 0.65].forEach((x) => {
        const h = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.14, 0.05), headMat);
        h.position.set(x, 0.3 + bodyH * 0.7, 2.17);
        g.add(h);
      });
      const brake = [];
      [-0.7, 0.7].forEach((x) => {
        const mat = new THREE.MeshStandardMaterial({ color: 0x551010, emissive: 0xff1a1a, emissiveIntensity: 0.35 });
        brake.push(mat);
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.16, 0.05), mat);
        t.position.set(x, 0.3 + bodyH * 0.7, -2.17);
        g.add(t);
      });
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 0.02), new THREE.MeshBasicMaterial({ color: 0xf2f2f0 }));
      plate.position.set(0, 0.45, -2.18);
      g.add(plate);

      // Wheels: tyre and rim in a group that spins while the car moves
      const wheels = [];
      [[-1, -1.35], [1, -1.35], [-1, 1.35], [1, 1.35]].forEach(([wx, wz]) => {
        const w = new THREE.Group();
        const tyre = new THREE.Mesh(cWheel, M.tyre);
        tyre.castShadow = true;
        w.add(tyre);
        w.add(new THREE.Mesh(cRim, M.rim));
        w.position.set(wx, 0.42, wz);
        g.add(w);
        wheels.push(w);
      });

      g.userData = { wheels, brake };
      scene.add(g);
      return g;
    };
    const queueCars = APPROACHES.map((ap) => {
      const row = [];
      for (let kk = 0; kk < 8; kk++) {
        const car = makeCar();
        const dd = 9.4 + kk * 6;
        car.position.set(ap.lane[0] + ap.back[0] * dd, 0.1, ap.lane[1] + ap.back[1] * dd);
        car.rotation.y = Math.atan2(-ap.back[0], -ap.back[1]);
        car.visible = false;
        row.push(car);
      }
      return row;
    });
    const movers = [];
    const prevPassed = stateRef.current.passed.map((v) => Math.floor(v));

    // Camera orbit
    const start = VIEWS[viewRef.current] || VIEWS.aerial;
    const cur = { ...start };
    const tgt = { ...start };
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const onDown = (e) => {
      dragging = true;
      lx = e.clientX;
      ly = e.clientY;
      try {
        el.setPointerCapture(e.pointerId);
      } catch (x) {
        /* ignore */
      }
    };
    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      tgt.t -= dx * 0.006;
      tgt.p = Math.max(0.08, Math.min(1.5, tgt.p - dy * 0.005));
      cur.t = tgt.t;
      cur.p = tgt.p;
    };
    const onUp = () => {
      dragging = false;
    };
    const onWheel = (e) => {
      e.preventDefault();
      tgt.r = Math.max(25, Math.min(170, tgt.r * (1 + e.deltaY * 0.001)));
    };
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
    el.addEventListener("wheel", onWheel, { passive: false });

    ctl.current.setView = (name) => {
      const v = VIEWS[name];
      if (v) Object.assign(tgt, v);
    };
    ctl.current.zoom = (f) => {
      tgt.r = Math.max(25, Math.min(170, tgt.r * f));
    };

    const ro = new ResizeObserver(() => {
      W = host.clientWidth;
      H = host.clientHeight;
      if (!W || !H) return;
      renderer.setSize(W, H, false);
      camera.aspect = W / H;
      camera.updateProjectionMatrix();
    });
    ro.observe(host);

    let raf = 0;
    let last = performance.now();
    function frame(now) {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const s = stateRef.current;
      const sim = s.paused ? 0 : dt * s.speed;
      const flashOff = s.hold && Math.floor(now / 500) % 2 === 1;

      for (let i = 0; i < 4; i++) {
        const st = sigState(s, i);
        ["red", "yellow", "green"].forEach((state) => {
          const lit = state === st && !(state === "red" && flashOff);
          lamps[i][state].color.setHex(lit ? new THREE.Color(COLORS[state]).getHex() : 0x2b3238);
          glows[i][state].visible = lit;
        });
        stopMats[i].color.setHex(st === "green" ? 0x35d07a : st === "yellow" ? 0xffc531 : 0xf4f6f7);

        const shown = Math.min(Math.round(s.queues[i]), 8);
        for (let c = 0; c < 8; c++) {
          const car = queueCars[i][c];
          car.visible = c < shown;
          car.userData.brake.forEach((m) => (m.emissiveIntensity = 1.4));
        }

        const np = Math.floor(s.passed[i]);
        if (np < prevPassed[i]) prevPassed[i] = np;
        while (prevPassed[i] < np) {
          prevPassed[i]++;
          if (movers.length < 40) movers.push({ i, u: 9.4, age: 0, mesh: makeCar() });
        }
      }

      for (let mi = movers.length - 1; mi >= 0; mi--) {
        const mv = movers[mi];
        mv.age += sim;
        mv.u -= (9 + Math.min(mv.age * 4, 5)) * sim;
        const ap = APPROACHES[mv.i];
        mv.mesh.position.set(ap.lane[0] + ap.back[0] * mv.u, 0.1, ap.lane[1] + ap.back[1] * mv.u);
        mv.mesh.rotation.y = Math.atan2(-ap.back[0], -ap.back[1]);
        const v = 9 + Math.min(mv.age * 4, 5);
        mv.mesh.userData.wheels.forEach((w) => (w.rotation.x -= (v * sim) / 0.42));
        mv.mesh.userData.brake.forEach((m) => (m.emissiveIntensity = 0.35));
        if (mv.u < -80) {
          scene.remove(mv.mesh);
          movers.splice(mi, 1);
        }
      }

      if (ctl.current.auto && !dragging) {
        tgt.t += dt * 0.12;
        cur.t = tgt.t;
      }
      cur.t += (tgt.t - cur.t) * 0.12;
      cur.p += (tgt.p - cur.p) * 0.12;
      cur.r += (tgt.r - cur.r) * 0.12;
      camera.position.set(
        cur.r * Math.sin(cur.p) * Math.sin(cur.t),
        2 + cur.r * Math.cos(cur.p),
        cur.r * Math.sin(cur.p) * Math.cos(cur.t)
      );
      camera.lookAt(0, 2, 0);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      el.removeEventListener("wheel", onWheel);
      renderer.dispose();
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  }, [stateRef, carTpl]);

  return (
    <div className="scene" ref={hostRef} role="img" aria-label="3D view of Oak Street and 5th Avenue junction">
      {failed && <div className="nogl">This view needs WebGL, which is turned off in this browser.</div>}
      {carTpl === null && !failed && <div className="loading">Loading car model…</div>}
      <div className="scene-tools">
        <div className="seg" role="group" aria-label="Camera view">
          {[["aerial", "Aerial"], ["top", "Top down"], ["street", "Street"]].map(([name, label]) => (
            <button key={name} type="button" aria-pressed={view.name === name} onClick={() => onView(name)}>
              {label}
            </button>
          ))}
        </div>
        <div className="seg">
          <button type="button" aria-label="Zoom in" onClick={() => ctl.current.zoom && ctl.current.zoom(0.8)}>+</button>
          <button type="button" aria-label="Zoom out" onClick={() => ctl.current.zoom && ctl.current.zoom(1.25)}>−</button>
          <button type="button" aria-pressed={auto} onClick={onAuto}>Auto-rotate</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Signal heads: one card per approach
// ---------------------------------------------------------------------------
function SignalCard({ s, i }) {
  const st = sigState(s, i);
  const color = st === "green" ? COLORS.green : st === "yellow" ? COLORS.yellow : COLORS.red;
  const label = s.hold ? "ALL RED" : st === "green" ? "GO" : st === "yellow" ? "CHANGE" : "STOP";
  const secs = s.hold ? null : st === "red" ? waitFor(s, i) : s.left;
  return (
    <article className="sig-card" style={{ borderTopColor: color }}>
      <div className="sig-name">{NAMES[i]}</div>
      <div className="sig-light" style={{ background: color, boxShadow: `0 0 18px ${color}` }} />
      <div className="sig-label" style={{ color }}>{label}</div>
      <div className="sig-time">
        {secs == null ? "--" : fmtCount(secs)}
        {secs != null && <small>s</small>}
      </div>
      <div className="sig-meta">{Math.round(s.queues[i])} waiting · {s.rates[i]}/min in</div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const CSS = `
:root { --bg:#0b1117; --panel:#121b24; --panel2:#17232e; --border:#243241; --fg:#e6edf3; --muted:#8793a0; --accent:#3b9cff; --ok:#35d07a; --warn:#ffc531; --crit:#ff5c52; }
* { box-sizing: border-box; }
body { margin: 0; }
.dash-root { background: var(--bg); color: var(--fg); font-family: 'Overpass', system-ui, sans-serif; font-size: 13px; min-height: 100vh; display: flex; flex-direction: column; }
.topbar { height: 46px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px; background: var(--panel); border-bottom: 1px solid var(--border); }
.topbar h1 { font-size: 16px; font-weight: 700; margin: 0; }
.topbar .brand { color: var(--muted); font-size: 13px; }
.topbar .tb-right { display: flex; gap: 12px; align-items: center; color: var(--muted); }
.body { display: flex; flex: 1; min-height: 0; }
.rail { width: 44px; background: var(--panel); border-right: 1px solid var(--border); display: flex; flex-direction: column; gap: 14px; align-items: center; padding-top: 14px; color: var(--muted); }
.rail span { width: 22px; height: 22px; border-radius: 5px; border: 1px solid var(--border); display: grid; place-items: center; font-size: 11px; }
.rail span.on { border-color: var(--accent); color: var(--accent); }
.main { flex: 1; min-width: 0; padding: 10px; display: grid; gap: 10px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; min-width: 0; }
.card-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.ok { color: var(--ok); }
.scene-wrap { position: relative; height: clamp(440px, 60vw, 600px); border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
.scene { position: absolute; inset: 0; background: #0f1620; }
.scene canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.scene canvas:active { cursor: grabbing; }
.nogl { position: absolute; inset: 0; display: grid; place-items: center; color: var(--muted); }
.scene-tools { position: absolute; left: 0; right: 0; bottom: 10px; display: flex; justify-content: center; gap: 8px; flex-wrap: wrap; pointer-events: none; }
.scene-tools > * { pointer-events: auto; }
.overlay { position: absolute; z-index: 2; }
.ov-v2i { left: 10px; top: 10px; width: min(330px, 40%); }
.ov-status { left: 50%; transform: translateX(-50%); top: 10px; }
.ov-dash { right: 10px; top: 10px; width: min(330px, 40%); }
.ov-digital { left: 50%; transform: translateX(-50%); bottom: 50px; }
.v2i-head { display: flex; justify-content: space-between; color: var(--muted); margin-bottom: 4px; }
.v2i-svg { width: 100%; height: auto; }
.v2i-foot { display: flex; justify-content: space-between; gap: 8px; color: var(--muted); margin-top: 4px; }
.v2i-foot b { font-weight: 600; }
.approach-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.ap-name { font-weight: 700; min-width: 110px; }
.ap-name span { display: block; font-weight: 400; color: var(--muted); font-size: 11px; }
.ap-cell { display: flex; flex-direction: column; align-items: center; min-width: 60px; font-size: 12px; }
.ap-cell b { font-size: 18px; font-family: 'Overpass Mono', monospace; }
.ap-cell small { color: var(--muted); }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 8px; }
.kpis.two { grid-template-columns: repeat(2, 1fr); }
.kpis > div { background: var(--panel2); border-radius: 6px; padding: 6px 8px; display: flex; flex-direction: column; }
.kpis span { color: var(--muted); font-size: 11px; }
.kpis b { font-size: 15px; font-family: 'Overpass Mono', monospace; }
.chart-head { display: flex; justify-content: space-between; color: var(--muted); font-size: 11px; margin-bottom: 4px; }
.chart { width: 100%; height: 110px; background: var(--panel2); border-radius: 6px; }
.legend-mini { display: flex; gap: 10px; color: var(--muted); font-size: 11px; margin: 6px 0; flex-wrap: wrap; }
.legend-mini span { display: inline-flex; align-items: center; gap: 4px; }
.legend-mini i { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.bottom { display: grid; gap: 10px; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr); }
.loading { position: absolute; left: 10px; bottom: 10px; z-index: 3; font-size: 11px; color: var(--muted); background: rgba(18,27,36,0.9); padding: 4px 8px; border-radius: 6px; }
@media (max-width: 1100px) { .ov-v2i, .ov-dash { width: 42%; } .ov-status { display: none; } }
@media (max-width: 900px) {
  .scene-wrap { height: auto; display: flex; flex-direction: column; border: 0; overflow: visible; }
  .scene { position: relative; inset: auto; height: 380px; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); }
  .overlay { position: static; width: 100% !important; transform: none !important; margin-top: 10px; }
  .ov-status { display: block; }
  .bottom { grid-template-columns: 1fr; }
  .iot-body { grid-template-columns: 1fr; }
}
@media (max-width: 640px) {
  .rail { display: none; }
  .main { padding: 8px; gap: 8px; }
  .topbar { height: auto; min-height: 46px; padding: 8px 12px; flex-wrap: wrap; gap: 6px; }
  .topbar h1 { font-size: 15px; }
  .topbar .brand { display: none; }
  .scene { height: 300px; }
  .scene-tools { bottom: 6px; }
  .scene-tools button { padding: 4px 8px; font-size: 11px; }
  .approach-row { gap: 6px; }
  .ap-name { min-width: 0; }
  .ap-cell { min-width: 48px; }
  .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .kpis b { font-size: 13px; }
  .controls { grid-template-columns: 1fr; }
  .rate { grid-template-columns: 44px 1fr 96px; }
  .card { padding: 10px; }
}
.iot-body { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: center; }
.iot-legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.iot-legend li { display: flex; gap: 8px; align-items: flex-start; }
.iot-legend i { width: 12px; height: 12px; border-radius: 50%; margin-top: 3px; flex: none; }
.iot-legend b { display: block; }
.iot-legend span { color: var(--muted); font-size: 11px; }
.iot-map { width: 100%; height: auto; border-radius: 6px; }
.sub-title { display: flex; justify-content: space-between; color: var(--muted); font-size: 12px; margin: 6px 0; }
.sub-title em { font-style: normal; color: var(--fg); }
.bars { width: 100%; height: auto; }
.hbar { display: grid; grid-template-columns: 56px 1fr 48px; gap: 8px; align-items: center; font-size: 12px; margin: 4px 0; }
.hbar div { background: var(--panel2); border-radius: 3px; height: 8px; overflow: hidden; }
.hbar i { display: block; height: 100%; background: var(--accent); }
.hbar b { text-align: right; font-family: 'Overpass Mono', monospace; }
.gauge { text-align: center; }
.gauge-svg { width: 100%; max-width: 260px; height: auto; }
.gauge-val { margin-top: -6px; }
.gauge-val b { font-size: 34px; font-family: 'Overpass Mono', monospace; }
.gauge-val span { color: var(--muted); font-size: 16px; }
.alerts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.alerts li { display: flex; gap: 8px; background: var(--panel2); border-left: 3px solid; border-radius: 4px; padding: 6px 8px; }
.alerts b { display: block; font-size: 12px; }
.alerts small { color: var(--muted); font-size: 11px; }
.seg { display: flex; gap: 4px; flex-wrap: wrap; }
button { font: inherit; color: var(--fg); background: rgba(18,27,36,0.9); border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; cursor: pointer; font-size: 12px; }
button:hover { border-color: var(--accent); }
button[aria-pressed="true"] { background: var(--accent); color: #06121f; border-color: var(--accent); }
.controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.controls label { font-size: 12px; color: var(--muted); display: block; margin-bottom: 4px; }
.rate { display: grid; grid-template-columns: 56px 1fr 96px; gap: 8px; align-items: center; margin-bottom: 4px; font-size: 12px; }
.rate output { font-family: 'Overpass Mono', monospace; color: var(--muted); text-align: right; font-size: 11px; }
.log { list-style: none; margin: 0; padding: 0; font-size: 12px; }
.log li { display: grid; grid-template-columns: 52px 1fr; gap: 8px; padding: 4px 0; border-top: 1px solid var(--border); }
.log li:first-child { border-top: 0; }
.log time { font-family: 'Overpass Mono', monospace; color: var(--muted); }
.log .warn span { color: var(--warn); }
.log .crit span { color: var(--crit); }

.app { min-height: 100vh; padding: 12px; display: flex; flex-direction: column; gap: 12px; background: var(--bg); color: var(--fg); font-family: 'Overpass', system-ui, sans-serif; font-size: 13px; }
.pill-top { left: 10px; top: 10px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; background: rgba(18,27,36,0.92); border: 1px solid var(--border); padding: 6px 10px; border-radius: 8px; max-width: calc(100% - 20px); }
.pill-top b { font-size: 14px; }
.pill-top .ok { color: var(--ok); }
.pill-top .bad { color: var(--crit); }
.pill-top .clk { font-family: 'Overpass Mono', monospace; color: var(--muted); }
.signals { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
.sig-card { background: var(--panel); border: 1px solid var(--border); border-top: 3px solid; border-radius: 8px; padding: 14px 10px; display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; }
.sig-name { font-weight: 700; font-size: 13px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.sig-light { width: 34px; height: 34px; border-radius: 50%; }
.sig-label { font-weight: 800; font-size: 15px; letter-spacing: 0.08em; }
.sig-time { font-family: 'Overpass Mono', monospace; font-size: 30px; font-weight: 700; line-height: 1; }
.sig-time small { font-size: 13px; margin-left: 3px; color: var(--muted); }
.sig-meta { color: var(--muted); font-size: 11px; }
@media (max-width: 900px) { .signals { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 480px) { .app { padding: 8px; } .signals { gap: 8px; } .sig-time { font-size: 24px; } }
`;

export default function TrafficControlDashboard() {
  const [s, dispatch] = useReducer(reduce, undefined, initial);
  const stateRef = useRef(s);
  stateRef.current = s;
  const [view, setView] = useState({ name: "aerial", n: 0 });
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    const id = setInterval(() => dispatch({ type: "tick", dt: 0.1 * s.speed }), 100);
    return () => clearInterval(id);
  }, [s.speed]);

  let open = 0;
  for (let i = 0; i < 4; i++) if (sigState(s, i) !== "red") open++;
  const safe = open <= 1;

  return (
    <div className="app">
      <style>{CSS}</style>

      <div className="scene-wrap">
        <JunctionScene
          stateRef={stateRef}
          view={view}
          auto={auto}
          onView={(name) => setView((v) => ({ name, n: v.n + 1 }))}
          onAuto={() => setAuto((a) => !a)}
        />
        <div className="overlay pill-top">
          <b>Oak Street &amp; 5th Avenue</b>
          <span className={safe ? "ok" : "bad"}>{safe ? "● No conflicting greens" : "● Conflict detected"}</span>
          <span className="clk">{clock(s.clock)}</span>
        </div>
      </div>

      <section className="signals" aria-label="Signal heads">
        {[0, 1, 2, 3].map((i) => (
          <SignalCard key={i} s={s} i={i} />
        ))}
      </section>

      <section className="card">
        <div className="card-title">Controls</div>
        <div className="controls">
          <div>
            <label>Simulation</label>
            <div className="seg">
              <button type="button" aria-pressed={s.paused} onClick={() => dispatch({ type: "pause" })}>{s.paused ? "Paused" : "Pause"}</button>
              <button type="button" onClick={() => dispatch({ type: "reset" })}>Reset</button>
              <button type="button" aria-pressed={s.hold} onClick={() => dispatch({ type: "hold" })}>{s.hold ? "Release all-red" : "Emergency all-red"}</button>
            </div>
          </div>
          <div>
            <label>Speed</label>
            <div className="seg">
              {[1, 5, 10].map((v) => (
                <button key={v} type="button" aria-pressed={s.speed === v} onClick={() => dispatch({ type: "speed", v })}>{v}×</button>
              ))}
            </div>
          </div>
          <div>
            <label>Green time</label>
            <div className="seg">
              <button type="button" aria-pressed={s.adaptive} onClick={() => dispatch({ type: "adaptive", v: true })}>Adaptive</button>
              <button type="button" aria-pressed={!s.adaptive} onClick={() => dispatch({ type: "adaptive", v: false })}>Fixed 30 s</button>
            </div>
          </div>
          <div>
            <label>Traffic frequency (veh/min)</label>
            {[0, 1, 2, 3].map((i) => (
              <div className="rate" key={i}>
                <span>{NAMES[i]}</span>
                <input
                  type="range"
                  min={1}
                  max={8}
                  step={1}
                  value={s.rates[i]}
                  aria-label={`${NAMES[i]} traffic frequency`}
                  onChange={(e) => dispatch({ type: "rate", i, v: +e.target.value })}
                />
                <output>{s.rates[i]}/min · {level(s.rates[i])}</output>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-title">Signal log</div>
        <ul className="log">
          {s.log.map((e) => (
            <li key={e.id} className={e.kind}>
              <time>{clock(e.t)}</time>
              <span>{e.msg}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
