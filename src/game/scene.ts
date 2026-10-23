import * as THREE from "three";
import type { Sim } from "./sim";
import { sampleHeight, type Heightfield, type Track } from "./track";

export type GhostPose = { x: number; y: number; z: number; yaw: number; s: number };

export type TruckView = {
  root: THREE.Group;
  body: THREE.Group;
  spinners: THREE.Object3D[];
  fronts: THREE.Object3D[];
  lamps: THREE.MeshStandardMaterial;
  bedJugs: THREE.Object3D[];
  spin: number;
};

export type World = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  player: TruckView;
  field: TruckView[];
  dust: Dust;
  jugs: JugNode[];
  look: THREE.Vector3;
  trauma: number;
  clock: number;
  sun: THREE.DirectionalLight;
  sky: THREE.Object3D;
  resize: () => void;
  dispose: () => void;
};

type Dust = {
  points: THREE.Points;
  pos: Float32Array;
  vel: Float32Array;
  life: Float32Array;
  cursor: number;
};

type JugNode = {
  root: THREE.Group;
  from: THREE.Vector3;
  fly: number;
  done: boolean;
};

const _x = new THREE.Vector3();
const _y = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _cam = new THREE.Vector3();
const _look = new THREE.Vector3();
const _bed = new THREE.Vector3();

function yawQuat(yaw: number, out: THREE.Quaternion) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  _z.set(fx, 0, fz);
  _x.set(fz, 0, -fx);
  if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
  else _x.normalize();
  _m.makeBasis(_x, _y, _z);
  out.setFromRotationMatrix(_m);
}

function prism(profile: Array<[number, number]>, halfWidth: number) {
  const n = profile.length;
  const positions: number[] = [];
  const indices: number[] = [];
  for (const side of [-halfWidth, halfWidth]) {
    for (const [z, y] of profile) positions.push(side, y, z);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(i, n + i, j);
    indices.push(j, n + i, n + j);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function grit(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vW;\n")
      .replace(
        "#include <project_vertex>",
        "#include <project_vertex>\nvW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vW;
        float hsh(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
        float nz(vec2 p){
          vec2 i=floor(p); vec2 f=fract(p); f=f*f*(3.0-2.0*f);
          float a=hsh(i), b=hsh(i+vec2(1.0,0.0)), c=hsh(i+vec2(0.0,1.0)), d=hsh(i+vec2(1.0,1.0));
          return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
        }
        `,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float g = nz(vW.xz * 0.38);
        float f = nz(vW.xz * 1.85);
        float crater = smoothstep(0.76, 0.86, nz(vW.xz * 0.045));
        diffuseColor.rgb *= mix(0.78, 1.16, g);
        diffuseColor.rgb += (f - 0.5) * 0.07;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.42, crater * 0.7);
        `,
      );
  };
}

function addMesh(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, shadow: boolean) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

const jugPlastic = new THREE.MeshStandardMaterial({
  color: 0xd7e6f2,
  roughness: 0.32,
  metalness: 0.04,
  transparent: true,
  opacity: 0.62,
});
const jugWater = new THREE.MeshStandardMaterial({
  color: 0x2f8fd0,
  emissive: 0x0e4d72,
  emissiveIntensity: 0.55,
  roughness: 0.18,
  transparent: true,
  opacity: 0.92,
});
const jugCap = new THREE.MeshStandardMaterial({ color: 0xf4f0e8, roughness: 0.42 });
const jugBodyGeo = new THREE.CylinderGeometry(0.22, 0.26, 0.5, 10);
const jugFillGeo = new THREE.CylinderGeometry(0.16, 0.18, 0.34, 10);
const jugNeckGeo = new THREE.CylinderGeometry(0.08, 0.1, 0.12, 8);
const jugCapGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.06, 8);
const jugHandleGeo = new THREE.TorusGeometry(0.09, 0.022, 6, 8, Math.PI);

function makeJug() {
  const group = new THREE.Group();
  const body = new THREE.Mesh(jugBodyGeo, jugPlastic);
  const fill = new THREE.Mesh(jugFillGeo, jugWater);
  fill.position.y = -0.04;
  const neck = new THREE.Mesh(jugNeckGeo, jugPlastic);
  neck.position.y = 0.3;
  const cap = new THREE.Mesh(jugCapGeo, jugCap);
  cap.position.y = 0.38;
  const handle = new THREE.Mesh(jugHandleGeo, jugPlastic);
  handle.position.y = 0.22;
  handle.rotation.y = Math.PI / 2;
  group.add(body, fill, neck, cap, handle);
  return group;
}

function packBed(body: THREE.Group) {
  const slots: THREE.Object3D[] = [];
  const xs = [-0.55, -0.18, 0.18, 0.55];
  const zs = [-1.72, -1.12];
  for (const z of zs) {
    for (const x of xs) {
      const jug = makeJug();
      jug.position.set(x, 2.16, z);
      jug.scale.setScalar(0.72);
      jug.visible = false;
      body.add(jug);
      slots.push(jug);
    }
  }
  return slots;
}

const PAINT = [0xe7e2d8, 0x7eb6ff, 0xff8a1e, 0xe85d4c, 0x5dbe8a, 0xc39bd3, 0xf4d03f, 0x5dade2];

function createTruck(paint: number, lit: boolean): TruckView {
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = 0.42;
  const shell = new THREE.MeshStandardMaterial({
    color: PAINT[paint] ?? 0xe7e2d8,
    metalness: 0.9,
    roughness: 0.24,
    side: THREE.DoubleSide,
  });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x10141c,
    metalness: 0.55,
    roughness: 0.08,
    transparent: true,
    opacity: 0.82,
  });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.94, metalness: 0.04 });
  const lamps = new THREE.MeshStandardMaterial({
    color: 0xff8a1e,
    emissive: 0xff8a1e,
    emissiveIntensity: 1.6,
  });
  const tail = new THREE.MeshStandardMaterial({
    color: 0xff3b2f,
    emissive: 0xff2a22,
    emissiveIntensity: 1.4,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x23262c, metalness: 0.7, roughness: 0.38 });
  const shadow = lit;

  const hull = prism(
    [
      [-2.7, 1.12],
      [2.05, 1.08],
      [2.85, 1.34],
      [1.05, 2.05],
      [-0.2, 2.32],
      [-2.85, 1.78],
    ],
    1.05,
  );
  addMesh(body, hull, shell, shadow);
  const cabin = addMesh(body, new THREE.BoxGeometry(1.72, 0.5, 1.28), glass, false);
  cabin.position.set(0, 2.12, 0.42);
  cabin.rotation.x = -0.46;
  const bed = addMesh(body, new THREE.BoxGeometry(1.9, 0.1, 1.85), dark, shadow);
  bed.position.set(0, 1.82, -1.4);
  const railL = addMesh(body, new THREE.BoxGeometry(0.08, 0.28, 1.7), dark, shadow);
  railL.position.set(-0.9, 2.0, -1.35);
  const railR = railL.clone();
  railR.position.x = 0.9;
  body.add(railR);
  const bar = addMesh(body, new THREE.BoxGeometry(1.85, 0.08, 0.1), lamps, false);
  bar.position.set(0, 2.48, -0.05);
  for (const x of [-0.7, -0.25, 0.25, 0.7]) {
    const pod = addMesh(body, new THREE.BoxGeometry(0.16, 0.1, 0.1), lamps, false);
    pod.position.set(x, 2.58, -0.05);
  }
  const nose = addMesh(body, new THREE.BoxGeometry(1.7, 0.1, 0.08), lamps, false);
  nose.position.set(0, 1.28, 2.72);
  const bumper = addMesh(body, new THREE.BoxGeometry(2.05, 0.22, 0.28), dark, shadow);
  bumper.position.set(0, 1.05, 2.55);
  const tailBar = addMesh(body, new THREE.BoxGeometry(1.7, 0.08, 0.06), tail, false);
  tailBar.position.set(0, 1.25, -2.62);
  const belly = addMesh(body, new THREE.BoxGeometry(1.7, 0.16, 4.4), dark, shadow);
  belly.position.set(0, 0.95, -0.1);
  const bedJugs = packBed(body);

  const tireGeo = new THREE.CylinderGeometry(1.02, 1.02, 0.52, 16);
  tireGeo.rotateZ(Math.PI / 2);
  const sidewall = new THREE.CylinderGeometry(0.72, 0.72, 0.56, 12);
  sidewall.rotateZ(Math.PI / 2);
  const spinners: THREE.Object3D[] = [];
  const fronts: THREE.Object3D[] = [];
  const spots: Array<[number, number, boolean]> = [
    [-1.18, 1.48, true],
    [1.18, 1.48, true],
    [-1.18, -1.55, false],
    [1.18, -1.55, false],
  ];
  for (const [x, z, front] of spots) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 1.02, z);
    const spin = new THREE.Group();
    addMesh(spin, tireGeo, rubber, shadow);
    addMesh(spin, sidewall, dark, false);
    for (let k = 0; k < 6; k++) {
      const knob = addMesh(spin, new THREE.BoxGeometry(0.54, 0.14, 0.18), rubber, false);
      const a = (k / 6) * Math.PI * 2;
      knob.position.set(0, Math.sin(a) * 0.96, Math.cos(a) * 0.96);
      knob.rotation.x = a;
    }
    pivot.add(spin);
    const arch = addMesh(pivot, new THREE.BoxGeometry(0.7, 0.14, 1.25), shell, shadow);
    arch.position.y = 0.72;
    const shock = addMesh(pivot, new THREE.BoxGeometry(0.08, 0.7, 0.08), dark, false);
    shock.position.y = 0.35;
    root.add(pivot);
    spinners.push(spin);
    if (front) fronts.push(pivot);
  }
  root.add(body);
  if (lit) {
    const glow = new THREE.PointLight(0xff8a1e, 6, 14, 2);
    glow.position.set(0, 1.6, 2.6);
    root.add(glow);
    const spot = new THREE.SpotLight(0xfff4e0, 28, 52, 0.48, 0.55, 1.4);
    spot.position.set(0, 1.7, 2.3);
    spot.target.position.set(0, 0.2, 16);
    root.add(spot, spot.target);
  }
  return { root, body, spinners, fronts, lamps, bedJugs, spin: 0 };
}

function dustSprite() {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const g = canvas.getContext("2d");
  if (!g) return null;
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, "rgba(244, 236, 220, 0.95)");
  grd.addColorStop(0.35, "rgba(190, 160, 120, 0.4)");
  grd.addColorStop(1, "rgba(0, 0, 0, 0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeDust(): Dust {
  const n = 380;
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const life = new Float32Array(n);
  for (let i = 0; i < n; i++) pos[i * 3 + 1] = -30;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xe4d5c0,
    size: 1.15,
    map: dustSprite() ?? undefined,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    sizeAttenuation: true,
  });
  return { points: new THREE.Points(geo, mat), pos, vel, life, cursor: 0 };
}

function lateral(track: Track, x: number, z: number) {
  const samples = track.samples;
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < samples.length; i += 3) {
    const sm = samples[i]!;
    const d = (sm.x - x) ** 2 + (sm.z - z) ** 2;
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const lo = Math.max(0, bestI - 6);
  const hi = Math.min(samples.length - 2, bestI + 6);
  let lat = 40;
  let bd = Infinity;
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
      lat = (x - cx) * a.rx + (z - cz) * a.rz;
    }
  }
  return Math.abs(lat);
}

function buildTerrain(track: Track) {
  const height: Heightfield = track.height;
  const { cols, rows, res, originX, originZ } = height;
  const width = (cols - 1) * res;
  const depth = (rows - 1) * res;
  const geo = new THREE.PlaneGeometry(width, depth, cols - 1, rows - 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  if (!pos) return new THREE.Mesh();
  const colors = new Float32Array(pos.count * 3);
  const road = new THREE.Color(0x6a4630);
  const edge = new THREE.Color(0xff8a1e);
  const berm = new THREE.Color(0x8d8476);
  const dust = new THREE.Color(0x3e3b36);
  const rock = new THREE.Color(0x2a2826);
  const crater = new THREE.Color(0x161514);
  const half = 7;
  for (let i = 0; i < pos.count; i++) {
    const wx = originX + width / 2 + pos.getX(i);
    const wz = originZ + depth / 2 + pos.getZ(i);
    const h = sampleHeight(height, wx, wz);
    pos.setY(i, h);
    const abs = lateral(track, wx, wz);
    const slope = Math.abs(h - sampleHeight(height, wx + res, wz));
    const c = new THREE.Color();
    if (abs < half - 1.1) c.copy(road);
    else if (abs < half + 0.45) c.copy(edge);
    else if (abs < half + 3.2) c.copy(berm);
    else if (slope > 0.85) c.copy(rock);
    else c.copy(dust);
    if (h < sampleHeight(height, wx + res * 2, wz) - 1.1) c.lerp(crater, 0.72);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.96, metalness: 0.02 });
  grit(mat);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(originX + width / 2, 0, originZ + depth / 2);
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  return mesh;
}

function buildRibbon(track: Track) {
  const samples = track.samples;
  const across = 7;
  const half = 7;
  const offsets = [-half - 1.5, -half, -half + 0.7, 0, half - 0.7, half, half + 1.5];
  const palette = [
    [0.42, 0.38, 0.32],
    [1, 0.54, 0.12],
    [0.38, 0.26, 0.16],
    [0.5, 0.36, 0.22],
    [0.38, 0.26, 0.16],
    [1, 0.54, 0.12],
    [0.42, 0.38, 0.32],
  ];
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    const sm = samples[i]!;
    const dash = Math.floor(sm.s / 8) % 2 === 0;
    for (let k = 0; k < across; k++) {
      const o = offsets[k]!;
      positions.push(sm.x + sm.rx * o, sm.y + 0.14, sm.z + sm.rz * o);
      const col = palette[k]!;
      if (k === 3 && dash) colors.push(0.96, 0.92, 0.82);
      else colors.push(col[0]!, col[1]!, col[2]!);
    }
    if (i < samples.length - 1) {
      const base = i * across;
      for (let k = 0; k < across - 1; k++) {
        indices.push(base + k, base + k + 1, base + across + k);
        indices.push(base + k + 1, base + across + k + 1, base + across + k);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.88,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

function gateMesh(finish: boolean) {
  const color = finish ? 0x7eb6ff : 0xff8a1e;
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.7,
    roughness: 0.28,
    metalness: 0.15,
  });
  const steel = new THREE.MeshStandardMaterial({ color: 0x1c1e24, metalness: 0.6, roughness: 0.4 });
  const group = new THREE.Group();
  const post = new THREE.BoxGeometry(0.28, 4.4, 0.28);
  const left = new THREE.Mesh(post, steel);
  left.position.set(-7.4, 2.2, 0);
  const right = new THREE.Mesh(post, steel);
  right.position.set(7.4, 2.2, 0);
  const stripL = new THREE.Mesh(new THREE.BoxGeometry(0.08, 3.6, 0.08), mat);
  stripL.position.set(-7.4, 2.1, 0.16);
  const stripR = stripL.clone();
  stripR.position.x = 7.4;
  const bar = new THREE.Mesh(new THREE.BoxGeometry(15.1, 0.22, 0.22), mat);
  bar.position.y = 4.35;
  const ring = new THREE.Mesh(new THREE.RingGeometry(6.4, 7.6, 32), mat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.16;
  group.add(left, right, stripL, stripR, bar, ring);
  for (const side of [-1, 1]) {
    const chev = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.16, 0.16), mat);
    chev.position.set(side * 2.2, 3.55, 0);
    chev.rotation.z = side * 0.55;
    group.add(chev);
  }
  return group;
}

function makeSky() {
  const sky = new THREE.Group();
  const geo = new THREE.SphereGeometry(420, 24, 16);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {},
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vDir;
      float hsh(vec2 p){return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);}
      void main() {
        float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 zenith = vec3(0.02, 0.025, 0.05);
        vec3 mid = vec3(0.08, 0.06, 0.09);
        vec3 horizon = vec3(0.28, 0.13, 0.06);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.22, h));
        col = mix(col, zenith, smoothstep(0.18, 0.7, h));
        vec2 cell = floor(vDir.xy * 220.0);
        float star = step(0.992, hsh(cell));
        col += star * smoothstep(0.25, 0.55, h) * vec3(0.85, 0.9, 1.0);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  sky.add(new THREE.Mesh(geo, mat));
  return sky;
}

function makeEarth() {
  const geo = new THREE.SphereGeometry(18, 40, 28);
  const mat = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      varying vec3 vN;
      varying vec3 vP;
      void main() {
        vN = normalize(normalMatrix * normal);
        vP = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec3 vN;
      varying vec3 vP;
      float hsh(vec2 p){return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);}
      float nz(vec2 p){
        vec2 i = floor(p); vec2 f = fract(p); f = f*f*(3.0-2.0*f);
        float a=hsh(i), b=hsh(i+vec2(1.0,0.0)), c=hsh(i+vec2(0.0,1.0)), d=hsh(i+vec2(1.0,1.0));
        return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
      }
      void main() {
        vec2 uv = vec2(atan(vP.z, vP.x), vP.y);
        float n = nz(uv * 1.6 + vec2(2.0, 0.4));
        float n2 = nz(uv * 4.0);
        vec3 ocean = vec3(0.12, 0.32, 0.62);
        vec3 land = vec3(0.22, 0.42, 0.2);
        vec3 ice = vec3(0.75, 0.82, 0.86);
        vec3 col = mix(ocean, land, smoothstep(0.46, 0.58, n));
        col = mix(col, ice, smoothstep(0.55, 0.9, abs(vP.y) / 18.0) * 0.85);
        col += (n2 - 0.5) * 0.05;
        float fres = pow(1.0 - abs(vN.z), 2.2);
        col += vec3(0.35, 0.6, 1.0) * fres * 0.55;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const earth = new THREE.Mesh(geo, mat);
  earth.position.set(-80, 92, -210);
  return earth;
}

export function createWorld(track: Track, canvasHost: HTMLElement): World {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.setSize(canvasHost.clientWidth || window.innerWidth, canvasHost.clientHeight || window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.14;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  canvasHost.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x07080d);
  scene.fog = new THREE.Fog(0x16110e, 70, 280);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 700);
  const sky = makeSky();
  scene.add(sky);
  scene.add(makeEarth());

  scene.add(new THREE.HemisphereLight(0xc5d4ea, 0x3a2a22, 0.72));
  const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
  sun.position.set(36, 54, 18);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.camera.near = 8;
  sun.shadow.camera.far = 120;
  sun.shadow.camera.left = -32;
  sun.shadow.camera.right = 32;
  sun.shadow.camera.top = 32;
  sun.shadow.camera.bottom = -32;
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);
  const earthFill = new THREE.DirectionalLight(0x7eb6ff, 0.38);
  earthFill.position.set(-40, 30, -20);
  scene.add(earthFill);

  scene.add(buildTerrain(track));
  scene.add(buildRibbon(track));

  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  const shardGeo = new THREE.OctahedronGeometry(1, 0);
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6e6860, roughness: 0.94, metalness: 0.05 });
  grit(rockMat);
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, 90);
  const shards = new THREE.InstancedMesh(shardGeo, rockMat, 40);
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  const dummy = new THREE.Object3D();
  for (let i = 0; i < 90; i++) {
    const sm = track.samples[(i * 3) % track.samples.length]!;
    const side = i % 2 === 0 ? 1 : -1;
    const push = 12 + (i % 7) * 1.6;
    dummy.position.set(sm.x + sm.rx * side * push, sm.y + 0.35, sm.z + sm.rz * side * push);
    dummy.scale.set(0.45 + (i % 5) * 0.22, 0.28 + (i % 3) * 0.16, 0.5 + (i % 4) * 0.2);
    dummy.rotation.set(i * 0.4, i * 0.7, i * 0.2);
    dummy.updateMatrix();
    rocks.setMatrixAt(i, dummy.matrix);
  }
  for (let i = 0; i < 40; i++) {
    const sm = track.samples[(i * 5 + 2) % track.samples.length]!;
    const side = i % 2 === 0 ? -1 : 1;
    dummy.position.set(sm.x + sm.rx * side * (16 + (i % 4)), sm.y + 0.5, sm.z + sm.rz * side * (16 + (i % 3)));
    dummy.scale.setScalar(0.35 + (i % 4) * 0.2);
    dummy.rotation.set(0.4, i, 0.8);
    dummy.updateMatrix();
    shards.setMatrixAt(i, dummy.matrix);
  }
  scene.add(rocks, shards);

  const bowlGeo = new THREE.SphereGeometry(1, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.45);
  bowlGeo.rotateX(Math.PI);
  const bowlMat = new THREE.MeshStandardMaterial({ color: 0x2a241e, roughness: 1, side: THREE.DoubleSide });
  const bowls = new THREE.InstancedMesh(bowlGeo, bowlMat, 16);
  bowls.receiveShadow = true;
  for (let i = 0; i < 16; i++) {
    const sm = track.samples[(i * 11 + 4) % track.samples.length]!;
    const side = i % 2 === 0 ? 1 : -1;
    const s = 3.5 + (i % 4);
    dummy.position.set(sm.x + sm.rx * side * (20 + (i % 5)), sm.y + 0.15, sm.z + sm.rz * side * (20 + (i % 3)));
    dummy.scale.set(s, 0.7 + (i % 3) * 0.25, s);
    dummy.rotation.set(0, i, 0);
    dummy.updateMatrix();
    bowls.setMatrixAt(i, dummy.matrix);
  }
  scene.add(bowls);

  for (const g of track.gates) {
    const mesh = gateMesh(g.finish);
    yawQuat(Math.atan2(-g.tx, -g.tz), mesh.quaternion);
    mesh.position.set(g.x, g.y, g.z);
    scene.add(mesh);
  }

  const player = createTruck(0, true);
  const field = [1, 2, 3, 4, 5, 6, 7].map((paint) => {
    const truck = createTruck(paint, false);
    truck.root.visible = false;
    return truck;
  });
  scene.add(player.root, ...field.map((truck) => truck.root));
  const dust = makeDust();
  scene.add(dust.points);
  const jugs: JugNode[] = track.jugs.map((jug) => {
    const root = makeJug();
    const from = new THREE.Vector3(jug.x, jug.y + 0.46, jug.z);
    root.position.copy(from);
    scene.add(root);
    return { root, from, fly: 0, done: false };
  });

  const world: World = {
    renderer,
    scene,
    camera,
    player,
    field,
    dust,
    jugs,
    look: new THREE.Vector3(),
    trauma: 0,
    clock: 0,
    sun,
    sky,
    resize() {
      const w = canvasHost.clientWidth || window.innerWidth;
      const h = canvasHost.clientHeight || window.innerHeight;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    },
    dispose() {
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
  world.resize();
  return world;
}

function placeTruck(view: TruckView, x: number, y: number, z: number, yaw: number, steer: number, speed: number, dt: number, squash: number) {
  view.root.position.set(x, y, z);
  yawQuat(yaw, view.root.quaternion);
  view.spin += speed * dt * 0.85;
  for (const s of view.spinners) s.rotation.x = view.spin;
  for (const f of view.fronts) f.rotation.y = steer * 0.38;
  const lean = -steer * Math.min(0.14, Math.abs(speed) * 0.005);
  view.body.rotation.z = lean;
  view.body.position.y = 0.42 + squash;
}

function puff(dust: Dust, x: number, y: number, z: number, speed: number) {
  const i = dust.cursor % dust.life.length;
  dust.cursor++;
  dust.life[i] = 0.85;
  dust.pos[i * 3] = x;
  dust.pos[i * 3 + 1] = y + 0.5;
  dust.pos[i * 3 + 2] = z;
  dust.vel[i * 3] = (Math.random() - 0.5) * 3;
  dust.vel[i * 3 + 1] = 0.8 + Math.random() * 1.4;
  dust.vel[i * 3 + 2] = (Math.random() - 0.5) * 3 - Math.sign(speed) * 0.3;
}

export type FieldPose = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  steer: number;
  speed: number;
};

export function updateWorld(
  world: World,
  sim: Sim,
  dt: number,
  mode: "orbit" | "chase",
  field: Array<FieldPose | null>,
  reduce: boolean,
) {
  world.clock += dt;
  const p = sim.player;
  const squash = p.impact > 4 ? -0.12 : Math.sin(world.clock * Math.min(22, 6 + Math.abs(p.speed))) * 0.035;
  placeTruck(world.player, p.x, p.y, p.z, p.yaw, p.steer, p.speed, dt, squash);
  world.player.lamps.emissiveIntensity = 1.5 + Math.sin(world.clock * 10) * 0.25 + (p.boost > 0 ? 1.2 : 0);
  let loaded = 0;
  for (let i = 0; i < world.jugs.length; i++) {
    const node = world.jugs[i]!;
    const got = sim.taken.has(i);
    if (!got) {
      node.root.position.y = node.from.y + Math.sin(world.clock * 2.4 + i) * 0.1;
      node.root.rotation.y = world.clock * 0.7 + i;
      continue;
    }
    if (!node.done) {
      if (node.fly <= 0) {
        node.from.copy(node.root.position);
        node.fly = 0.001;
      }
      node.fly = Math.min(1, node.fly + dt * 2.4);
      _bed.set(p.x, p.y + 1.9, p.z);
      node.root.position.lerpVectors(node.from, _bed, node.fly);
      const s = 1 - node.fly * 0.4;
      node.root.scale.setScalar(s);
      if (node.fly >= 1) {
        node.done = true;
        node.root.visible = false;
      }
    }
    if (node.done) loaded += 1;
  }
  for (let i = 0; i < world.player.bedJugs.length; i++) {
    world.player.bedJugs[i]!.visible = i < loaded;
  }

  for (let i = 0; i < world.field.length; i++) {
    const view = world.field[i]!;
    const pose = field[i];
    if (!pose) {
      view.root.visible = false;
      continue;
    }
    view.root.visible = true;
    placeTruck(view, pose.x, pose.y, pose.z, pose.yaw, pose.steer, pose.speed, dt, 0);
  }

  if (p.onGround && Math.abs(p.speed) > 6) {
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    puff(world.dust, p.x - fx * 2.2 + p.steer * 0.4, p.y, p.z - fz * 2.2, p.speed);
    if (p.drift) {
      puff(world.dust, p.x + fx * 0.2, p.y, p.z + fz * 0.2, p.speed);
      puff(world.dust, p.x - fx * 1.2, p.y, p.z - fz * 1.2, p.speed);
    }
  }
  const attr = world.dust.points.geometry.attributes.position;
  if (attr) {
    for (let i = 0; i < world.dust.life.length; i++) {
      if (world.dust.life[i]! <= 0) {
        world.dust.pos[i * 3 + 1] = -40;
        continue;
      }
      world.dust.life[i]! -= dt;
      world.dust.pos[i * 3]! += world.dust.vel[i * 3]! * dt;
      world.dust.pos[i * 3 + 1]! += world.dust.vel[i * 3 + 1]! * dt;
      world.dust.pos[i * 3 + 2]! += world.dust.vel[i * 3 + 2]! * dt;
      world.dust.vel[i * 3 + 1]! -= dt * 0.8;
    }
    attr.needsUpdate = true;
  }

  if (p.impact > 5 && !reduce) world.trauma = Math.min(1, world.trauma + p.impact * 0.04);
  world.trauma = Math.max(0, world.trauma - dt * 1.6);

  world.sun.position.set(p.x + 34, p.y + 52, p.z + 16);
  world.sun.target.position.set(p.x, p.y, p.z);
  world.sun.target.updateMatrixWorld();

  const fx = -Math.sin(p.yaw);
  const fz = -Math.cos(p.yaw);
  if (mode === "orbit") {
    const ang = world.clock * (reduce ? 0.05 : 0.28);
    _cam.set(p.x + Math.sin(ang) * 11, p.y + 4.2, p.z + Math.cos(ang) * 11);
    _look.set(p.x, p.y + 1.6, p.z);
  } else {
    _cam.set(p.x - fx * 9.6, p.y + 4.2, p.z - fz * 9.6);
    _look.set(p.x + fx * 8, p.y + 1.6, p.z + fz * 8);
  }
  const k = 1 - Math.exp(-4.2 * dt);
  world.camera.position.lerp(_cam, mode === "orbit" ? 1 : k);
  world.look.lerp(_look, mode === "orbit" ? 1 : k);
  const shake = reduce ? 0 : world.trauma * world.trauma;
  world.camera.position.x += Math.sin(world.clock * 40) * shake * 0.25;
  world.camera.position.y += Math.cos(world.clock * 33) * shake * 0.18;
  world.camera.lookAt(world.look);
  world.sky.position.copy(world.camera.position);
  const fov = 60 + Math.min(16, Math.abs(p.speed) * 0.38) + (p.boost > 0 ? 5 : 0);
  if (Math.abs(world.camera.fov - fov) > 0.2) {
    world.camera.fov = fov;
    world.camera.updateProjectionMatrix();
  }
  world.renderer.render(world.scene, world.camera);
}
