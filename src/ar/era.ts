import * as THREE from 'three';

const FILES = import.meta.glob<string>('../era/*.webp', { query: '?url', import: 'default', eager: true });

/** scripts/make-era.mjs의 FOG와 같은 색 */
export const FOG_COLOR = new THREE.Color().setRGB(169 / 255, 183 / 255, 154 / 255, THREE.SRGBColorSpace);

async function texture(name: string): Promise<THREE.Texture> {
  const url = FILES[`../era/${name}.webp`];
  if (!url) throw new Error(`배경 파일이 없습니다: ${name}`);
  const t = await new THREE.TextureLoader().loadAsync(url);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 늘 같은 배치가 나오는 난수 */
function random(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function sky(): THREE.Mesh {
  const g = new THREE.SphereGeometry(150, 32, 24);
  const pos = g.attributes.position!;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color('#4f93cf');
  const mid = new THREE.Color('#a9cfe4');
  const low = new THREE.Color('#e3e9dc');
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = pos.getY(i) / 150;
    if (h > 0.25) c.lerpColors(mid, top, Math.min(1, (h - 0.25) / 0.6));
    else c.lerpColors(low, mid, Math.max(0, h / 0.25));
    c.toArray(colors, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

function ground(map: THREE.Texture): THREE.Mesh {
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const g = new THREE.RingGeometry(0.01, 110, 64, 40).rotateX(-Math.PI / 2);
  const pos = g.attributes.position!;
  const uv = g.attributes.uv!;
  const colors = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const [x, z] = [pos.getX(i), pos.getZ(i)];
    uv.setXY(i, x / 7, z / 7);
    // 같은 무늬가 반복돼 보이지 않게 넓은 얼룩을 섞는다.
    const n = Math.sin(x * 0.21 + Math.sin(z * 0.13) * 2) * Math.cos(z * 0.17 + Math.sin(x * 0.11) * 2);
    colors.set([0.95 + 0.18 * n, 1.28 + 0.12 * n, 0.78 + 0.1 * n], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, vertexColors: true, fog: true }));
  m.renderOrder = -8;
  return m;
}

function trail(map: THREE.Texture, center: THREE.Vector3, radius: number, width: number): THREE.Mesh {
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  const g = new THREE.RingGeometry(Math.max(0.1, radius - width), radius + width, 72, 6).rotateX(-Math.PI / 2);
  const pos = g.attributes.position!;
  const uv = g.attributes.uv!;
  const colors = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    const [x, z] = [pos.getX(i), pos.getZ(i)];
    uv.setXY(i, x / 6, z / 6);
    const edge = 1 - Math.abs(Math.hypot(x, z) - radius) / width;
    colors.set([1, 1, 1, Math.max(0, Math.min(0.85, edge * 1.5))], i * 4);
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, depthWrite: false, fog: true }));
  m.position.set(center.x, 0.01, center.z);
  m.renderOrder = -7;
  return m;
}

const RING = 95;
const ARC = (RING * Math.PI) / 2;
const STRIP_H = (ARC * 900) / 2048; // 그림 한 조각은 2048×900, 90도
const BASE_ROW = 690; // 이 줄이 땅 높이에 온다

function horizon(maps: THREE.Texture[]): THREE.Group {
  const group = new THREE.Group();
  maps.forEach((map, i) => {
    const g = new THREE.CylinderGeometry(RING, RING, STRIP_H, 24, 1, true, (i * Math.PI) / 2, Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, transparent: true, depthWrite: false, fog: false }));
    m.position.y = (BASE_ROW / 900 - 0.5) * STRIP_H;
    m.renderOrder = -9;
    group.add(m);
  });
  // 안쪽에서 보면 좌우가 뒤집히므로 되돌린다.
  group.scale.x = -1;
  return group;
}

/** 세워 둔 사진 두 장을 엇갈려 만든 식물 */
function crossed(aspect: number): THREE.BufferGeometry {
  const w = aspect / 2;
  const p = [-w, 0, 0, w, 0, 0, w, 1, 0, -w, 1, 0, 0, 0, -w, 0, 0, w, 0, 1, w, 0, 1, -w];
  const uv = [0, 0, 1, 0, 1, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
  return g;
}

interface PlantRule {
  name: string;
  count: number;
  height: [number, number];
  range: [number, number];
}

const PLANTS: PlantRule[] = [
  { name: 'araucaria', count: 16, height: [14, 22], range: [22, 78] },
  { name: 'conifer', count: 26, height: [7, 14], range: [20, 80] },
  { name: 'treefern', count: 26, height: [3.5, 6.5], range: [9, 55] },
  { name: 'fern', count: 420, height: [0.35, 0.95], range: [3, 46] },
];

export interface EraPath {
  center: THREE.Vector3;
  radius: number;
  /** 동물 몸이 휩쓰는 폭 */
  clear: number;
  flies: boolean;
}

/** 공룡 시대 배경. 보는 사람이 원점에 서 있고 -Z가 앞이다. */
export class Era {
  readonly group = new THREE.Group();
  private skyMesh = sky();

  private constructor() {
    this.group.add(this.skyMesh);
  }

  static async load(path: EraPath): Promise<Era> {
    const era = new Era();
    const [fern, dirt, ...rest] = await Promise.all([
      texture('ground-fern'),
      texture('ground-dirt'),
      ...[0, 1, 2, 3].map((i) => texture(`horizon-${i}`)),
      ...PLANTS.map((p) => texture(`plant-${p.name}`)),
    ]);
    era.group.add(horizon(rest.slice(0, 4)), ground(fern!));
    if (!path.flies) era.group.add(trail(dirt!, path.center, path.radius, Math.max(1.5, path.clear * 0.35)));
    else dirt!.dispose();

    const rnd = random(20261125);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    PLANTS.forEach((rule, k) => {
      const map = rest[4 + k]!;
      const img = map.image as { width: number; height: number };
      const mesh = new THREE.InstancedMesh(
        crossed(img.width / img.height),
        new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, fog: true }),
        rule.count,
      );
      let n = 0;
      for (let tries = 0; n < rule.count && tries < rule.count * 60; tries++) {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rule.range[0] ** 2 + rnd() * (rule.range[1] ** 2 - rule.range[0] ** 2));
        const [x, z] = [r * Math.cos(a), r * Math.sin(a)];
        const h = rule.height[0] + rnd() * (rule.height[1] - rule.height[0]);
        const d = Math.hypot(x - path.center.x, z - path.center.z);
        const reach = path.radius + path.clear;
        // 동물이 다니는 길과, 보는 사람과 길 사이의 시야를 비운다.
        if (rule.name === 'fern' ? Math.abs(d - path.radius) < path.clear * 0.45 : d < reach) continue;
        if (rule.name === 'fern' && z < 0 && r < -path.center.z - path.radius && Math.abs(x) < -z * 0.4) continue;
        if (rule.name !== 'fern' && z < 0 && Math.abs(x) < reach * Math.min(1, -z / -path.center.z) && z > path.center.z) continue;
        q.setFromAxisAngle(up, rnd() * Math.PI);
        m.compose(new THREE.Vector3(x, -0.02 * h, z), q, new THREE.Vector3(h, h, h));
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, new THREE.Color().setScalar(0.82 + rnd() * 0.25));
        n += 1;
      }
      mesh.count = n;
      mesh.computeBoundingSphere();
      era.group.add(mesh);
    });
    return era;
  }

  /** 하늘은 보는 사람을 따라다녀 끝이 보이지 않게 한다. */
  update(cameraWorld: THREE.Vector3) {
    this.skyMesh.position.copy(cameraWorld);
    this.group.worldToLocal(this.skyMesh.position);
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.map?.dispose();
      mat.dispose();
      if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
    });
  }
}
