import type { Random } from "vibecade-sdk";

export type Sample = {
  s: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  tx: number;
  tz: number;
  rx: number;
  rz: number;
  width: number;
  curv: number;
};

export type Gate = {
  s: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  rx: number;
  rz: number;
  half: number;
  finish: boolean;
};

export type Heightfield = {
  originX: number;
  originZ: number;
  res: number;
  cols: number;
  rows: number;
  data: Float32Array;
};

export type Jug = {
  id: number;
  s: number;
  x: number;
  y: number;
  z: number;
};

export type Track = {
  name: string;
  seed: string;
  samples: Sample[];
  gates: Gate[];
  jugs: Jug[];
  length: number;
  height: Heightfield;
};

export type Surface = {
  y: number;
  lat: number;
  s: number;
  dist: number;
  onRoad: boolean;
  grip: number;
  drag: number;
  tx: number;
  tz: number;
  yaw: number;
};

const NAMES_A = ["Tycho", "Kepler", "Mare", "Crisium", "Copernicus", "Imbrium"];
const NAMES_B = ["Cut", "Rim", "Wash", "Spur", "Basin", "Switchbacks"];

function cr(p0: number, p1: number, p2: number, p3: number, t: number) {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

function seedNum(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hash2(ix: number, iz: number, seed: number) {
  let n = Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(seed, 1442695041);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x: number, z: number, seed: number) {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const tx = x - x0;
  const tz = z - z0;
  const sx = tx * tx * (3 - 2 * tx);
  const sz = tz * tz * (3 - 2 * tz);
  const a = hash2(x0, z0, seed);
  const b = hash2(x0 + 1, z0, seed);
  const c = hash2(x0, z0 + 1, seed);
  const d = hash2(x0 + 1, z0 + 1, seed);
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz;
}

export function sampleHeight(h: Heightfield, x: number, z: number) {
  const fx = (x - h.originX) / h.res;
  const fz = (z - h.originZ) / h.res;
  const x0 = Math.floor(fx);
  const z0 = Math.floor(fz);
  if (x0 < 0 || z0 < 0 || x0 >= h.cols - 1 || z0 >= h.rows - 1) return 0;
  const tx = fx - x0;
  const tz = fz - z0;
  const at = (zz: number, xx: number) => h.data[zz * h.cols + xx] ?? 0;
  const a = at(z0, x0);
  const b = at(z0, x0 + 1);
  const c = at(z0 + 1, x0);
  const d = at(z0 + 1, x0 + 1);
  return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
}

function nearestIndex(samples: Sample[], x: number, z: number) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i += 4) {
    const sm = samples[i]!;
    const d = (sm.x - x) ** 2 + (sm.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function querySurface(track: Track, x: number, z: number): Surface {
  const samples = track.samples;
  const guess = nearestIndex(samples, x, z);
  const lo = Math.max(0, guess - 8);
  const hi = Math.min(samples.length - 2, guess + 8);
  let lat = 0;
  let s = samples[0]?.s ?? 0;
  let bd = Infinity;
  let bi = lo;
  for (let i = lo; i <= hi; i++) {
    const a = samples[i]!;
    const b = samples[i + 1] ?? a;
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const ab2 = abx * abx + abz * abz || 1;
    let t = ((x - a.x) * abx + (z - a.z) * abz) / ab2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + abx * t;
    const cz = a.z + abz * t;
    const d = (cx - x) ** 2 + (cz - z) ** 2;
    if (d < bd) {
      bd = d;
      bi = i;
      lat = (x - cx) * a.rx + (z - cz) * a.rz;
      s = a.s + (b.s - a.s) * t;
    }
  }
  const sm = samples[bi] ?? samples[0]!;
  const half = sm.width * 0.5;
  const abs = Math.abs(lat);
  const y = sampleHeight(track.height, x, z);
  let grip = 1;
  let drag = 0.38;
  let onRoad = true;
  if (abs > half + 8) {
    grip = 0.2;
    drag = 2.4;
    onRoad = false;
  } else if (abs > half) {
    grip = 0.45;
    drag = 1.15;
    onRoad = false;
  }
  return { y, lat, s, dist: Math.sqrt(bd), onRoad, grip, drag, tx: sm.tx, tz: sm.tz, yaw: sm.yaw };
}

export function sampleAt(track: Track, s: number): Sample {
  const samples = track.samples;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]!.s < s) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(0, lo - 1);
  const a = samples[i]!;
  const b = samples[Math.min(samples.length - 1, i + 1)]!;
  const span = b.s - a.s || 1;
  const t = Math.max(0, Math.min(1, (s - a.s) / span));
  return {
    ...a,
    s,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

function gateAt(samples: Sample[], s: number, finish: boolean): Gate {
  let i = 0;
  while (i < samples.length - 1 && samples[i]!.s < s) i++;
  const sm = samples[Math.max(0, i)]!;
  return {
    s: sm.s,
    x: sm.x,
    y: sm.y,
    z: sm.z,
    tx: sm.tx,
    tz: sm.tz,
    rx: sm.rx,
    rz: sm.rz,
    half: sm.width * 0.62,
    finish,
  };
}

function buildHeight(samples: Sample[], seed: string): Heightfield {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const sm of samples) {
    minX = Math.min(minX, sm.x - 26);
    maxX = Math.max(maxX, sm.x + 26);
    minZ = Math.min(minZ, sm.z - 26);
    maxZ = Math.max(maxZ, sm.z + 26);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 40);
  const res = Math.max(3.2, span / 140);
  const cols = Math.max(8, Math.ceil((maxX - minX) / res) + 1);
  const rows = Math.max(8, Math.ceil((maxZ - minZ) / res) + 1);
  const data = new Float32Array(cols * rows);
  const nseed = seedNum(seed);
  for (let iz = 0; iz < rows; iz++) {
    for (let ix = 0; ix < cols; ix++) {
      const wx = minX + ix * res;
      const wz = minZ + iz * res;
      const guess = nearestIndex(samples, wx, wz);
      const lo = Math.max(0, guess - 6);
      const hi = Math.min(samples.length - 2, guess + 6);
      let bd = Infinity;
      let lat = 0;
      let sy = 2;
      let ss = 0;
      let half = 6.5;
      for (let i = lo; i <= hi; i++) {
        const a = samples[i]!;
        const b = samples[i + 1] ?? a;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const ab2 = abx * abx + abz * abz || 1;
        let t = ((wx - a.x) * abx + (wz - a.z) * abz) / ab2;
        t = Math.max(0, Math.min(1, t));
        const cx = a.x + abx * t;
        const cz = a.z + abz * t;
        const d = (cx - wx) ** 2 + (cz - wz) ** 2;
        if (d < bd) {
          bd = d;
          lat = (wx - cx) * a.rx + (wz - cz) * a.rz;
          sy = a.y + (b.y - a.y) * t;
          ss = a.s;
          half = a.width * 0.5;
        }
      }
      const abs = Math.abs(lat);
      const n = vnoise(wx * 0.07, wz * 0.07, nseed);
      let h = sy;
      if (abs < half) {
        h += (n - 0.5) * 0.4 + Math.sin(ss * 0.31) * 0.18;
      } else {
        const fall = abs - half;
        h += (n - 0.5) * (1.4 + Math.min(fall, 16) * 0.12) - fall * 0.04;
        const crater = vnoise(wx * 0.018 + 9, wz * 0.018, nseed ^ 0x9e3779b9);
        if (crater > 0.84 && fall > 4) h -= (crater - 0.84) * 22;
      }
      data[iz * cols + ix] = h;
    }
  }
  return { originX: minX, originZ: minZ, res, cols, rows, data };
}

export function buildTrack(seed: string, rng: Random): Track {
  const namer = rng.fork("name");
  const roll = rng.fork("track");
  const name = `${namer.pick(NAMES_A)} ${namer.pick(NAMES_B)}`;
  const controls: { x: number; y: number; z: number }[] = [
    { x: 0, y: 3, z: 46 },
    { x: 0, y: 3, z: 22 },
    { x: 0, y: 3, z: 0 },
  ];
  let x = 0;
  let z = 0;
  let yaw = 0;
  let y = 3;
  for (let i = 0; i < 56; i++) {
    const hairpin = roll.chance(0.16);
    yaw += roll.float(-0.4, 0.4) * (hairpin ? 2.2 : 1);
    const step = roll.float(24, 40);
    x += -Math.sin(yaw) * step;
    z += -Math.cos(yaw) * step;
    y += roll.float(-1.4, 2);
    if (roll.chance(0.15)) y += roll.float(3.4, 6.2);
    y = Math.max(0.8, Math.min(18, y));
    controls.push({ x, y, z });
  }
  const end = controls[controls.length - 1]!;
  const prev = controls[controls.length - 2]!;
  const dx = end.x - prev.x;
  const dz = end.z - prev.z;
  const len = Math.hypot(dx, dz) || 1;
  controls.push({ x: end.x + (dx / len) * 28, y: end.y, z: end.z + (dz / len) * 28 });

  const raw: { x: number; y: number; z: number }[] = [];
  const steps = 8;
  for (let i = 1; i < controls.length - 2; i++) {
    const p0 = controls[i - 1]!;
    const p1 = controls[i]!;
    const p2 = controls[i + 1]!;
    const p3 = controls[i + 2]!;
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      raw.push({
        x: cr(p0.x, p1.x, p2.x, p3.x, t),
        y: cr(p0.y, p1.y, p2.y, p3.y, t),
        z: cr(p0.z, p1.z, p2.z, p3.z, t),
      });
    }
  }
  const last = controls[controls.length - 2]!;
  raw.push({ x: last.x, y: last.y, z: last.z });

  const samples: Sample[] = [];
  let sAcc = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    const b = raw[Math.min(raw.length - 1, i + 1)]!;
    const ddx = b.x - a.x;
    const ddz = b.z - a.z;
    const seg = Math.hypot(ddx, ddz) || 0.001;
    const tx = ddx / seg;
    const tz = ddz / seg;
    const yawS = Math.atan2(-tx, -tz);
    samples.push({
      s: sAcc,
      x: a.x,
      y: a.y,
      z: a.z,
      yaw: yawS,
      tx,
      tz,
      rx: Math.cos(yawS),
      rz: -Math.sin(yawS),
      width: 14,
      curv: 0,
    });
    sAcc += i === raw.length - 1 ? 0 : seg;
  }
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[Math.max(0, i - 1)]!;
    const next = samples[Math.min(samples.length - 1, i + 1)]!;
    const dot = Math.max(-1, Math.min(1, prev.tx * next.tx + prev.tz * next.tz));
    const ang = Math.acos(dot);
    samples[i]!.curv = ang / Math.max(0.5, next.s - prev.s);
  }

  const height = buildHeight(samples, seed);
  for (const sm of samples) sm.y = sampleHeight(height, sm.x, sm.z);

  const length = samples[samples.length - 1]?.s ?? 1;
  const gates: Gate[] = [];
  for (let g = 140; g < length - 50; g += 150) gates.push(gateAt(samples, g, false));
  gates.push(gateAt(samples, Math.max(20, length - 12), true));
  for (const g of gates) g.y = sampleHeight(height, g.x, g.z);

  const jugs: Jug[] = [];
  const salt = seedNum(seed);
  for (let s = 78, id = 0; s < length - 36; s += 72, id++) {
    const sm = sampleAt({ name, seed, samples, gates, jugs, length, height }, s);
    const side = ((salt + id * 3) % 2 === 0 ? 1 : -1) * (2.1 + (id % 3) * 0.7);
    jugs.push({
      id,
      s,
      x: sm.x + sm.rx * side,
      y: sampleHeight(height, sm.x + sm.rx * side, sm.z + sm.rz * side),
      z: sm.z + sm.rz * side,
    });
  }

  return { name, seed, samples, gates, jugs, length, height };
}
