import { querySurface, sampleAt, sampleHeight, type Track } from "./track";

export type Truck = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  speed: number;
  slide: number;
  vy: number;
  onGround: boolean;
  steer: number;
  drift: boolean;
  charge: number;
  boost: number;
  boosts: number;
  air: number;
  airTotal: number;
  resets: number;
  nextGate: number;
  finished: boolean;
  finishTime: number;
  s: number;
  impact: number;
  justBoost: boolean;
  justGate: boolean;
  justJug: boolean;
  justReset: boolean;
  jugs: number;
  wrongWay: number;
  stuck: number;
  cooldown: number;
};

export type Input = {
  has: (code: string) => boolean;
  steerOverride: number | null;
};

export class KeyInput implements Input {
  keys = new Set<string>();
  steerOverride: number | null = null;
  mouseGas = false;
  mouseBrake = false;
  has(code: string) {
    if ((code === "KeyW" || code === "ArrowUp") && this.mouseGas) return true;
    if ((code === "KeyS" || code === "ArrowDown") && this.mouseBrake) return true;
    return this.keys.has(code);
  }
}

export type Sim = {
  track: Track;
  player: Truck;
  bot: Truck | null;
  time: number;
  dnf: boolean;
  taken: Set<number>;
};

const GRAV = 5.2;
const MAX = 32;

function makeTruck(track: Track, s: number): Truck {
  const sm = sampleAt(track, s);
  return {
    x: sm.x,
    y: sampleHeight(track.height, sm.x, sm.z),
    z: sm.z,
    yaw: sm.yaw,
    speed: 0,
    slide: 0,
    vy: 0,
    onGround: true,
    steer: 0,
    drift: false,
    charge: 0,
    boost: 0,
    boosts: 0,
    air: 0,
    airTotal: 0,
    resets: 0,
    nextGate: 0,
    finished: false,
    finishTime: 0,
    s,
    impact: 0,
    justBoost: false,
    justGate: false,
    justJug: false,
    justReset: false,
    jugs: 0,
    wrongWay: 0,
    stuck: 0,
    cooldown: 0.4,
  };
}

export function createSim(track: Track, withBot: boolean): Sim {
  return {
    track,
    player: makeTruck(track, 16),
    bot: withBot ? makeTruck(track, 16) : null,
    time: 0,
    dnf: false,
    taken: new Set(),
  };
}

function resetTruck(track: Track, t: Truck, clock: number) {
  const gate = t.nextGate > 0 ? track.gates[t.nextGate - 1] : null;
  const s = gate ? gate.s + 6 : 16;
  const sm = sampleAt(track, s);
  t.x = sm.x;
  t.z = sm.z;
  t.y = sampleHeight(track.height, sm.x, sm.z) + 0.2;
  t.yaw = sm.yaw;
  t.speed = 9;
  t.slide = 0;
  t.vy = 0;
  t.onGround = true;
  t.resets += 1;
  t.justReset = true;
  t.cooldown = 0.7;
  t.stuck = 0;
  t.wrongWay = 0;
  t.s = s;
  void clock;
}

function crossGates(track: Track, t: Truck, px: number, pz: number, clock: number) {
  const g = track.gates[t.nextGate];
  if (!g || t.finished) return;
  const d0 = (px - g.x) * g.tx + (pz - g.z) * g.tz;
  const d1 = (t.x - g.x) * g.tx + (t.z - g.z) * g.tz;
  if (!(d0 < 0.8 && d1 >= -0.15 && d1 > d0 - 0.01)) return;
  const denom = d0 - d1 || 0.0001;
  const u = Math.max(0, Math.min(1, d0 / denom));
  const cx = px + (t.x - px) * u;
  const cz = pz + (t.z - pz) * u;
  const lat = Math.abs((cx - g.x) * g.rx + (cz - g.z) * g.rz);
  if (lat > g.half + 4) return;
  t.nextGate += 1;
  t.justGate = true;
  if (t.nextGate >= track.gates.length) {
    t.finished = true;
    t.finishTime = clock;
    t.speed *= 0.92;
  }
}

function stepBot(track: Track, t: Truck, dt: number, clock: number) {
  t.justGate = false;
  t.impact = 0;
  t.justBoost = false;
  if (t.finished) return;
  const sm = sampleAt(track, t.s);
  const corner = Math.min(1, sm.curv * 24);
  const target = 16.8 * (1 - 0.55 * corner);
  t.speed += (target - t.speed) * Math.min(1, dt * 1.6);
  const prevS = t.s;
  t.s += t.speed * dt;
  if (t.s >= track.length - 10) {
    t.finished = true;
    t.finishTime = clock;
    t.s = track.length - 10;
    t.speed = 0;
  }
  const p = sampleAt(track, t.s);
  const wobble = Math.sin(t.s * 0.045) * 1.3;
  const px = t.x;
  const pz = t.z;
  t.x = p.x + p.rx * wobble;
  t.z = p.z + p.rz * wobble;
  t.y = sampleHeight(track.height, t.x, t.z);
  t.yaw = p.yaw;
  t.onGround = true;
  t.steer = Math.max(-1, Math.min(1, (p.yaw - sm.yaw) * -4));
  void prevS;
  crossGates(track, t, px, pz, clock);
  if (t.finished) t.nextGate = track.gates.length;
}

export function stepTruck(track: Track, t: Truck, input: Input | null, dt: number, clock: number) {
  t.impact = 0;
  t.justBoost = false;
  t.justGate = false;
  t.justReset = false;
  if (!input) return;

  let steer = 0;
  if (input.has("KeyA") || input.has("ArrowLeft")) steer += 1;
  if (input.has("KeyD") || input.has("ArrowRight")) steer -= 1;
  if (input.steerOverride != null) steer = input.steerOverride;
  steer = Math.max(-1, Math.min(1, steer));
  t.steer = steer;

  const throttle = !t.finished && (input.has("KeyW") || input.has("ArrowUp")) ? 1 : 0;
  const brake = input.has("KeyS") || input.has("ArrowDown") ? 1 : 0;
  const wantDrift = !t.finished && (input.has("Space") || input.has("ShiftLeft") || input.has("ShiftRight"));

  const surf = querySurface(track, t.x, t.z);
  const fx = -Math.sin(t.yaw);
  const fz = -Math.cos(t.yaw);

  if (t.onGround && !t.finished) {
    const look = Math.max(2.2, t.speed * 0.16);
    const ahead = sampleHeight(track.height, t.x + fx * look, t.z + fz * look);
    const slope = (ahead - surf.y) / look;
    if (slope < -0.36 && t.speed > 11) {
      t.onGround = false;
      t.vy = Math.min(12, t.speed * 0.18 + -slope * 3.4);
      t.y = surf.y + 0.25;
    }
  }

  if (!t.onGround) {
    t.vy -= GRAV * dt;
    t.y += t.vy * dt;
    t.air += dt;
    if (t.y <= surf.y) {
      const hit = Math.max(0, -t.vy);
      t.y = surf.y;
      t.vy = 0;
      t.onGround = true;
      t.impact = hit;
      t.airTotal += t.air;
      t.air = 0;
      if (hit > 8) t.speed *= 0.8;
    }
  } else {
    t.y = surf.y;
    t.vy = 0;
  }

  const speedFactor = Math.min(1, Math.abs(t.speed) / 7);
  const reverse = t.speed >= 0 ? 1 : -1;
  const turnRate = 1.7 * Math.max(0.2, speedFactor) * (1 - 0.2 * Math.min(1, Math.abs(t.speed) / MAX));
  const airMul = t.onGround ? 1 : 0.45;
  const driftMul = wantDrift && t.onGround ? 1.16 : 1;
  if (!t.finished) t.yaw += steer * turnRate * driftMul * reverse * airMul * dt;

  const ffx = -Math.sin(t.yaw);
  const ffz = -Math.cos(t.yaw);
  const rrx = Math.cos(t.yaw);
  const rrz = -Math.sin(t.yaw);

  let accel = throttle * (t.boost > 0 ? 20 : 12.5);
  if (brake) accel -= throttle ? 16 : 22;
  t.speed += accel * dt;
  const drag = (t.finished ? 1.4 : surf.drag) + (throttle ? 0 : 0.7);
  t.speed *= Math.exp(-Math.max(0.08, drag) * dt);
  const cap = t.boost > 0 ? 40 : surf.onRoad ? MAX : 12;
  if (t.speed > cap) t.speed = cap;
  if (t.speed < -8) t.speed = -8;

  const grip = (wantDrift && t.onGround && Math.abs(t.speed) > 7 ? 1.45 : 8) * surf.grip;
  t.slide *= Math.exp(-grip * dt);
  if (!t.finished) t.slide += -steer * Math.abs(t.speed) * 1.2 * dt;
  if (Math.abs(surf.lat) > 12) {
    const push = Math.sign(surf.lat) * Math.min(22, (Math.abs(surf.lat) - 12) * 7);
    t.slide -= push * dt;
    t.speed *= Math.exp(-0.9 * dt);
  }

  const px = t.x;
  const pz = t.z;
  t.x += (ffx * t.speed + rrx * t.slide) * dt;
  t.z += (ffz * t.speed + rrz * t.slide) * dt;

  const after = querySurface(track, t.x, t.z);
  const along = (t.x - px) * after.tx + (t.z - pz) * after.tz;
  if (along < -0.08 && t.speed > 3 && after.dist < 18) t.wrongWay = Math.min(2, t.wrongWay + dt);
  else t.wrongWay = Math.max(0, t.wrongWay - dt * 2);
  t.s = after.s;

  if (t.finished) {
    t.drift = false;
    t.boost = 0;
    return;
  }

  if (wantDrift && t.onGround && Math.abs(t.speed) > 8 && Math.abs(steer) > 0.12) {
    t.drift = true;
    t.charge = Math.min(1, t.charge + dt * 0.62);
  } else if (!wantDrift && t.charge > 0.32) {
    t.boost = 0.42 + t.charge * 1.15;
    t.boosts += 1;
    t.justBoost = true;
    t.speed = Math.min(42, t.speed + 5 + t.charge * 4);
    t.charge = 0;
    t.drift = false;
  } else {
    t.drift = false;
    if (!wantDrift) t.charge = Math.max(0, t.charge - dt * 0.9);
  }
  if (t.boost > 0) t.boost = Math.max(0, t.boost - dt);

  crossGates(track, t, px, pz, clock);

  if (t.cooldown > 0) t.cooldown -= dt;
  else if (after.dist > 36 || t.y < -12) resetTruck(track, t, clock);

  if (throttle && t.onGround && Math.abs(t.speed) < 1.4 && !t.finished) t.stuck += dt;
  else t.stuck = 0;
  if (t.stuck > 2.4 && t.cooldown <= 0) resetTruck(track, t, clock);

  if (input.has("KeyR") && t.cooldown <= 0) resetTruck(track, t, clock);
}

export function stepSim(sim: Sim, input: Input, dt: number, racing: boolean) {
  if (!racing) return;
  if (!sim.player.finished && !sim.dnf) sim.time += dt;
  const clock = sim.time;
  stepTruck(sim.track, sim.player, input, dt, clock);
  collectJugs(sim);
  if (sim.bot) stepBot(sim.track, sim.bot, dt, clock);
  if (!sim.player.finished && sim.time >= 150) {
    sim.dnf = true;
    sim.player.finished = true;
    sim.player.finishTime = 150;
  }
}

function collectJugs(sim: Sim) {
  const t = sim.player;
  t.justJug = false;
  if (t.finished) return;
  for (const jug of sim.track.jugs) {
    if (sim.taken.has(jug.id)) continue;
    const dx = t.x - jug.x;
    const dz = t.z - jug.z;
    if (dx * dx + dz * dz > 8) continue;
    if (Math.abs(t.y - jug.y) > 3.4) continue;
    sim.taken.add(jug.id);
    t.jugs += 1;
    t.justJug = true;
    t.charge = Math.min(1, t.charge + 0.45);
    if (t.onGround && t.speed > 1) t.speed = Math.min(36, t.speed + 3.2);
  }
}

export function scoreOf(sim: Sim) {
  const t = sim.player;
  if (!sim.dnf && t.finished && t.finishTime > 0 && t.nextGate >= sim.track.gates.length) {
    return Math.round(t.finishTime * 1000);
  }
  const progress = Math.max(0, Math.min(1, t.s / sim.track.length));
  return Math.round(160000 + (1 - progress) * 80000);
}

export function formatTime(ms: number) {
  const clamped = Math.max(0, ms);
  const m = Math.floor(clamped / 60000);
  const s = Math.floor((clamped % 60000) / 1000);
  const hs = Math.floor((clamped % 1000) / 10);
  return `${m}:${s.toString().padStart(2, "0")}.${hs.toString().padStart(2, "0")}`;
}
