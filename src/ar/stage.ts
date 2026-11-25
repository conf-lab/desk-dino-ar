import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Dino, Motion } from '../dinos';
import { Actor } from './actor';
import { Era, FOG_COLOR, type EraPath } from './era';

export type Place = 'real' | 'era';

/** 현실 모드에서 고를 수 있는 크기. null은 실제 크기 */
export const SIZES: { label: string; length: number | null }[] = [
  { label: '30cm', length: 0.3 },
  { label: '1m', length: 1 },
  { label: '실제 크기', length: null },
  { label: '15cm', length: 0.15 },
];

/** 공룡 시대에서 동물이 도는 길. 보는 사람이 원점, -Z가 앞. */
export function eraPath(dino: Dino): EraPath & { altitude: number } {
  const clear = dino.lengthM * 0.6;
  const radius = dino.flies ? 10 : dino.lengthM * 0.55 + 3;
  const gap = 3 + dino.lengthM * 0.35;
  return { center: new THREE.Vector3(0, 0, -(radius + clear + gap)), radius, clear, flies: !!dino.flies, altitude: dino.flies ? 5 : 0 };
}

/**
 * 현실 모드에서 동물이 도는 길. 고른 자리(anchor)에서 옆모습으로 출발해 보는 사람에게서 먼 쪽으로 돈다.
 * 큰 동물이 보는 사람과 겹치지 않도록 필요하면 자리를 앞으로 민다.
 */
export function realPath(dino: Dino, anchor: THREE.Vector3, camera: THREE.Vector3, length: number, floorY: number | null) {
  const away = new THREE.Vector3(anchor.x - camera.x, 0, anchor.z - camera.z);
  const distance = away.length();
  if (distance < 0.05) away.set(0, 0, -1);
  else away.divideScalar(distance);
  const nearest = length < 0.5 ? 0.3 : length * 0.9 + 1;
  const d = Math.max(distance, nearest);
  const radius = length * (dino.flies ? 1.3 : 0.7);
  // 책상보다 큰 동물은 책상 높이가 아니라 바닥에 세운다.
  const y = length >= 1 && floorY !== null ? Math.min(anchor.y, floorY) : anchor.y;
  const center = new THREE.Vector3(camera.x, y, camera.z).addScaledVector(away, d + radius);
  return { center, radius, start: Math.atan2(-away.z, -away.x), altitude: dino.flies ? length * 0.8 : 0 };
}

/** AR 세션과 상관없는 3D 장면. 시험용 화면에서도 같은 것을 쓴다. */
export class Stage {
  readonly scene = new THREE.Scene();
  place: Place = 'real';
  actor: Actor | null = null;
  placed = false;
  private era: Era | null = null;
  private eraLoading: Promise<void> | null = null;
  private eraGroup = new THREE.Group();
  private realGroup = new THREE.Group();
  private anchor = new THREE.Vector3();
  private viewer = new THREE.Vector3();
  private floorY: number | null = null;
  private sizeIndex = 0;
  private disposed = false;
  private environment: THREE.WebGLRenderTarget;

  constructor(
    readonly dino: Dino,
    renderer: THREE.WebGLRenderer,
  ) {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.45;
    const sun = new THREE.DirectionalLight('#fff3dc', 1.9);
    sun.position.set(-3, 6, 2);
    this.scene.add(new THREE.HemisphereLight('#e9f3ff', '#8d8a6a', 1.1), sun, this.eraGroup, this.realGroup);
    this.eraGroup.visible = false;
  }

  async load() {
    const actor = await Actor.load(this.dino);
    if (this.disposed) return actor.dispose();
    this.actor = actor;
    actor.group.visible = false;
    this.apply();
  }

  get sizeLabel() {
    return SIZES[this.sizeIndex]!.label;
  }

  get realLength() {
    return SIZES[this.sizeIndex]!.length ?? this.dino.lengthM;
  }

  nextSize() {
    this.sizeIndex = (this.sizeIndex + 1) % SIZES.length;
    if (this.place === 'real' && this.placed) {
      const L = this.realLength;
      const p = realPath(this.dino, this.anchor, this.viewer, L, this.floorY);
      this.actor?.resize(p.center, L, p.radius, p.altitude);
    }
  }

  /** 현실 모드: 바닥이나 책상의 한 점에 놓는다. */
  putAt(point: THREE.Vector3, camera: THREE.Vector3, floorY: number | null = null) {
    this.anchor.copy(point);
    this.viewer.copy(camera);
    this.floorY = floorY;
    this.placed = true;
    this.apply();
  }

  unplace() {
    this.placed = false;
    this.actor?.cancelRoar();
    this.apply();
  }

  async loadEra(): Promise<void> {
    if (this.era) return;
    this.eraLoading ??= Era.load(eraPath(this.dino)).then(
      (era) => {
        if (this.disposed) return era.dispose();
        this.era = era;
        this.eraGroup.add(era.group);
      },
      (e) => {
        this.eraLoading = null; // 다음에 다시 시도할 수 있게
        throw e;
      },
    );
    await this.eraLoading;
  }

  /** 공룡 시대: 지금 보는 쪽을 앞으로 삼아 바닥 높이에 배경을 깐다. loadEra가 끝난 뒤에 부른다. */
  enterEra(camera: THREE.Vector3, yaw: number, floorY: number) {
    this.place = 'era';
    this.eraGroup.position.set(camera.x, floorY, camera.z);
    this.eraGroup.rotation.y = yaw;
    this.apply();
    this.play('walk');
  }

  leaveEra() {
    this.place = 'real';
    this.apply();
    this.play('idle');
  }

  private apply() {
    const inEra = this.place === 'era';
    this.eraGroup.visible = inEra;
    this.scene.fog = inEra ? new THREE.Fog(FOG_COLOR, 22, 100) : null;
    const actor = this.actor;
    if (!actor) return;
    if (inEra) {
      const p = eraPath(this.dino);
      this.eraGroup.add(actor.group);
      actor.group.visible = true;
      // 오른쪽 앞에서 왼쪽으로 지나가며 시작한다.
      actor.place(p.center, this.dino.lengthM, p.radius, Math.PI / 2 - 0.45, p.altitude);
    } else {
      const L = this.realLength;
      const p = realPath(this.dino, this.anchor, this.viewer, L, this.floorY);
      this.realGroup.add(actor.group);
      actor.group.visible = this.placed;
      actor.place(p.center, L, p.radius, p.start, p.altitude);
    }
  }

  play(motion: Motion) {
    this.actor?.play(motion);
  }

  update(dt: number, camera: THREE.Vector3) {
    if (this.place === 'era') this.era?.update(camera);
    if (this.place === 'era' || this.placed) this.actor?.update(dt);
  }

  dispose() {
    this.disposed = true;
    this.actor?.dispose();
    this.era?.dispose();
    this.environment.dispose();
  }
}
