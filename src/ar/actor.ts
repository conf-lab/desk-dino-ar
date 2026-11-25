import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MODEL_LENGTH, modelUrl, type Dino, type Motion } from '../dinos';

/** 한 동작에서 다른 동작으로 넘어가는 시간(초) */
const BLEND = 0.35;

function shadowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.5)');
  grad.addColorStop(0.5, 'rgba(0,0,0,0.25)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

/** 원을 그리며 움직이는 동물 하나. 길이 단위는 화면 속 미터다. */
export class Actor {
  readonly group = new THREE.Group();
  motion: Motion = 'idle';
  onRoarEnd: () => void = () => {};
  /** 울음이 끝나면 돌아갈 동작 */
  private base: Exclude<Motion, 'roar'> = 'idle';
  private body = new THREE.Group();
  private shadow: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private actions = new Map<Motion, THREE.AnimationAction>();
  private weights = new Map<Motion, number>();
  private mixer: THREE.AnimationMixer;
  private center = new THREE.Vector3();
  private angle = 0;
  private speed = 0;
  private length = MODEL_LENGTH;
  private radius = 1;
  private altitude = 0;

  private constructor(
    readonly dino: Dino,
    scene: THREE.Group,
    clips: THREE.AnimationClip[],
  ) {
    this.body.add(scene);
    scene.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      // 움직이면 처음 계산한 경계 밖으로 나가 사라질 수 있다.
      mesh.frustumCulled = false;
      for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
        m.metalness = 0; // 피부가 쇠처럼 번들거리지 않게
        m.fog = true;
      }
    });
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, fog: false }),
    );
    this.shadow.renderOrder = -1;
    this.group.add(this.body, this.shadow);
    this.mixer = new THREE.AnimationMixer(scene);
    for (const name of ['idle', 'walk', 'run', 'roar'] as const) {
      const clip = THREE.AnimationClip.findByName(clips, name);
      if (!clip) throw new Error(`동작이 없습니다: ${dino.id}/${name}`);
      const action = this.mixer.clipAction(clip);
      if (name === 'roar') action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      this.actions.set(name, action);
      this.weights.set(name, name === 'idle' ? 1 : 0);
    }
    this.actions.get('idle')!.play();
  }

  static async load(dino: Dino): Promise<Actor> {
    const gltf = await new GLTFLoader().loadAsync(modelUrl(dino.id));
    return new Actor(dino, gltf.scene, gltf.animations);
  }

  /** center를 중심으로 도는 길에 놓는다. start는 중심에서 시작점을 향하는 방향(라디안). */
  place(center: THREE.Vector3, length: number, radius: number, start: number, altitude = 0) {
    this.angle = start;
    this.resize(center, length, radius, altitude);
  }

  /** 길을 가던 자리를 지키며 크기만 바꾼다. */
  resize(center: THREE.Vector3, length: number, radius: number, altitude = 0) {
    this.center.copy(center);
    this.speed *= length / this.length;
    this.length = length;
    this.radius = radius;
    this.altitude = altitude;
    this.body.scale.setScalar(length / MODEL_LENGTH);
    this.update(0);
  }

  play(next: Motion) {
    if (next === this.motion && next !== 'roar') return;
    if (next !== 'roar') this.base = next;
    const action = this.actions.get(next)!;
    this.motion = next;
    // 아직 섞이는 중인 동작은 지금 비중에서 이어 가고, 멈춘 동작과 울음만 처음부터 튼다.
    if (next === 'roar' || !action.isRunning()) action.reset();
    action.paused = false;
    action.play();
  }

  /** 울고 있었다면 곧바로 이전 동작으로 돌아간다. */
  cancelRoar() {
    if (this.motion === 'roar') this.play(this.base);
  }

  private blend(dt: number) {
    let total = 0;
    for (const [m, w] of this.weights) {
      const next = m === this.motion ? Math.min(1, w + dt / BLEND) : Math.max(0, w - dt / BLEND);
      this.weights.set(m, next);
      total += next;
    }
    for (const [m, w] of this.weights) {
      const action = this.actions.get(m)!;
      action.setEffectiveWeight(total > 0 ? w / total : m === this.motion ? 1 : 0);
      if (w === 0 && m !== this.motion && action.isRunning()) action.stop();
    }
  }

  update(dt: number) {
    this.blend(dt);
    this.mixer.update(dt);
    if (this.motion === 'roar') {
      const roar = this.actions.get('roar')!;
      if (roar.time >= roar.getClip().duration - 0.02) {
        this.play(this.base);
        this.onRoarEnd();
      }
    }
    const k = this.length / this.dino.lengthM;
    const target = this.dino.speed[this.motion] * k;
    this.speed += (target - this.speed) * (1 - Math.exp(-dt * 5));
    if (this.dino.speed[this.motion] === 0 && this.speed < 0.02 * k) this.speed = 0;
    this.angle += (this.speed / this.radius) * dt;
    const [c, s] = [Math.cos(this.angle), Math.sin(this.angle)];
    this.group.position.set(this.center.x + this.radius * c, this.center.y, this.center.z + this.radius * s);
    this.group.rotation.y = Math.atan2(-s, c); // 앞(+Z)이 나아가는 쪽을 보게
    this.body.position.y = this.altitude;
    this.body.rotation.z = this.dino.flies ? 0.22 : 0;
    this.shadow.position.y = 0.002 * Math.max(1, this.length);
    this.shadow.scale.set(this.length * (this.dino.flies ? 0.7 : 0.42), 1, this.length * (this.dino.flies ? 0.35 : 0.8));
    this.shadow.material.opacity = this.dino.flies ? 0.45 : 1;
  }

  dispose() {
    this.mixer.stopAllAction();
    this.group.removeFromParent();
    const skeletons = new Set<THREE.Skeleton>();
    this.group.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      if (mesh.isSkinnedMesh) skeletons.add(mesh.skeleton);
      mesh.geometry.dispose();
      for (const m of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
        for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) t?.dispose();
        m.dispose();
      }
    });
    for (const s of skeletons) s.dispose();
  }
}
