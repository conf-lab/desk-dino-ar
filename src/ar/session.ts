import * as THREE from 'three';
import type { Dino, Motion } from '../dinos';
import { cancelPendingSound, playSound, preloadSound, stopSound } from '../sound';
import { Stage } from './stage';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const MOTIONS: Motion[] = ['idle', 'walk', 'run', 'roar'];
/** 공룡 시대에서 시작 자리에서 이만큼 벗어나면 카메라 화면으로 돌려보낸다(m). */
const SAFE_DISTANCE = 1.2;
const LOST_SECONDS = 1.5;
/** 바닥 높이를 모르는 기기에서 가정하는 눈높이(m) */
const EYE_HEIGHT = 1.3;

export async function arSupported(): Promise<boolean> {
  try {
    return (await navigator.xr?.isSessionSupported('immersive-ar')) ?? false;
  } catch {
    return false;
  }
}

let active = false;

/**
 * 버튼을 누른 자리에서 바로 불러야 한다(브라우저가 사용자 동작을 요구).
 * 사용자가 끝내면 정상 종료하고, 시작하지 못하면 원래 오류를 던진다.
 */
export async function runAR(dino: Dino): Promise<void> {
  if (active) return;
  active = true;
  try {
    const ui = $('ar-ui');
    const session = await navigator.xr!.requestSession('immersive-ar', {
      requiredFeatures: ['dom-overlay'],
      optionalFeatures: ['hit-test', 'local-floor'],
      domOverlay: { root: ui },
    });
    let run: Run;
    try {
      run = new Run(dino, session, ui);
    } catch (e) {
      ui.hidden = true;
      await session.end().catch(() => {});
      throw e;
    }
    await run.done;
  } finally {
    active = false;
  }
}

/** 세션이 끝난 뒤에는 취소가 오류를 던질 수 있다. */
function cancel(source: { cancel(): void }) {
  try {
    source.cancel();
  } catch {
    // 이미 정리된 소스
  }
}

class Run {
  readonly done: Promise<void>;
  private renderer: THREE.WebGLRenderer;
  private stage: Stage;
  private camera = new THREE.PerspectiveCamera(60, 1, 0.03, 200);
  private reticle: THREE.Mesh;
  private hitSources: XRHitTestSource[] = [];
  private tapSource: XRTransientInputHitTestSource | null = null;
  private floorSpace: XRReferenceSpace | null = null;
  /** 폰이 어림한 바닥 높이. 모르면 null */
  private floorY: number | null = null;
  private forward = new THREE.Vector3(0, 0, -1);
  /** 방금 누른 곳에서 찾은 평면 */
  private tapPoint = new THREE.Vector3();
  private tapAt = -Infinity;
  private searching = 0;
  private abort = new AbortController();
  private cameraPos = new THREE.Vector3();
  private eraOrigin = new THREE.Vector3();
  private lost = 0;
  private last = 0;
  private ending = false;
  private ended = false;
  private entering = false;
  private hasPose = false;
  /** 위치까지 제대로 추적하고 있는가. 안전 판단에 쓴다. */
  private tracking = false;
  private messageTimer = 0;
  private modelReady = false;
  private modelFailed = false;
  private failure: unknown = null;

  constructor(
    private dino: Dino,
    private session: XRSession,
    private ui: HTMLElement,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(1);
    this.renderer.xr.enabled = true;
    this.renderer.xr.setFramebufferScaleFactor(1);
    try {
      this.stage = new Stage(dino, this.renderer);
    } catch (e) {
      this.renderer.dispose();
      throw e;
    }
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.06, 0.08, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffd24a', depthTest: false, side: THREE.DoubleSide }),
    );
    this.reticle.renderOrder = 10;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 12, 8), this.reticle.material);
    dot.renderOrder = 10;
    this.reticle.add(dot);
    this.reticle.visible = false;
    this.stage.scene.add(this.reticle);
    this.done = new Promise((resolve, reject) =>
      session.addEventListener(
        'end',
        () => {
          try {
            this.finish();
          } catch (e) {
            console.warn(e); // 정리하다 난 오류 때문에 다시 못 여는 일이 없게
          }
          if (this.failure) reject(this.failure);
          else resolve();
        },
        { once: true },
      ),
    );
    this.setupUI();
    this.start().catch((e) => {
      // 시작하는 도중에 사용자가 나간 것은 오류가 아니다.
      if (!this.ending && !this.ended) this.failure = e;
      this.end();
    });
    this.stage.load().then(
      () => {
        if (this.ended) return;
        this.modelReady = true;
        if (this.stage.actor) this.stage.actor.onRoarEnd = cancelPendingSound;
        this.refresh();
      },
      () => {
        this.modelFailed = true;
        if (!this.ended) this.refresh();
      },
    );
  }

  private async start() {
    // 바닥 높이 어림값은 도중에 바뀔 수 있어, 놓은 공룡이 따라 움직이지 않도록 기준은 늘 local로 쓴다.
    try {
      this.floorSpace = await this.session.requestReferenceSpace('local-floor');
    } catch {
      // 바닥 높이를 모르면 눈높이에서 어림한다.
    }
    if (this.ended) return;
    this.renderer.xr.setReferenceSpaceType('local');
    // 세션을 넘기기 전에 걸어야 한다. 뒤에 걸면 일반 화면용 갱신까지 함께 돈다.
    this.renderer.setAnimationLoop(this.frame);
    await this.renderer.xr.setSession(this.session);
    this.renderer.xr.getReferenceSpace()?.addEventListener('reset', this.onReset, { signal: this.abort.signal });
    this.session.addEventListener('select', this.onSelect);
    // 앞서 누른 자리를 이번 누르기에 쓰지 않는다.
    this.session.addEventListener('selectstart', () => (this.tapAt = -Infinity), { signal: this.abort.signal });
    // 평면 찾기가 안 되는 기기에서도 "바로 앞에 놓기"로 쓸 수 있어야 하므로 실패해도 계속한다.
    const viewer = await this.session.requestReferenceSpace('viewer');
    const down = (angle: number) => {
      const y = -Math.tan((angle * Math.PI) / 180);
      return new XRRay(new DOMPointReadOnly(0, 0, 0, 1), { x: 0, y, z: -1, w: 0 });
    };
    const requests: (() => Promise<XRHitTestSource> | undefined)[] = [
      () => this.session.requestHitTestSource?.({ space: viewer }),
      () => this.session.requestHitTestSource?.({ space: viewer, offsetRay: down(20) }),
      () => this.session.requestHitTestSource?.({ space: viewer, entityTypes: ['plane', 'point'] }),
    ];
    for (const request of requests) {
      const source = await this.attempt(request);
      if (source) this.keep(source);
    }
    const tap = await this.attempt(() => this.session.requestHitTestSourceForTransientInput?.({ profile: 'generic-touchscreen' }));
    if (tap && this.ended) cancel(tap);
    else if (tap) this.tapSource = tap;
  }

  private async attempt<T>(request: () => Promise<T> | undefined): Promise<T | null> {
    try {
      return (await request()) ?? null;
    } catch (e) {
      console.warn('평면 찾기 기능 일부를 쓸 수 없습니다.', e);
      return null;
    }
  }

  private keep(source: XRHitTestSource) {
    if (this.ended) cancel(source);
    else this.hitSources.push(source);
  }

  private end() {
    this.ending = true;
    this.entering = false;
    stopSound();
    void this.session.end().catch(() => {});
  }

  private on(el: HTMLElement, fn: () => void) {
    el.addEventListener('click', () => !this.ending && fn(), { signal: this.abort.signal });
  }

  private setupUI() {
    this.ui.hidden = false;
    this.closeSafety();
    $('ar-name').textContent = this.dino.ko;
    // 버튼을 누른 것이 "그 자리에 놓기"로도 처리되지 않게 막는다.
    for (const bar of this.ui.querySelectorAll('.ar-bar')) {
      bar.addEventListener('beforexrselect', (e) => e.preventDefault(), { signal: this.abort.signal });
    }
    for (const m of MOTIONS) {
      const b = $<HTMLButtonElement>(`ar-${m}`);
      b.textContent = this.dino.labels[m];
      this.on(b, () => {
        if (!this.canMove) return;
        this.stage.play(m);
        if (m === 'roar') void playSound(this.dino.id);
        else stopSound();
      });
    }
    this.on($('ar-exit'), () => this.end());
    this.on($('ar-here'), () => this.placeAhead());
    // 일부 기기는 덮개 위를 눌러도 select를 보내지 않으므로 화면 누르기도 함께 받는다.
    this.ui.addEventListener(
      'click',
      (e) => {
        if (!(e.target as Element).closest('.ar-bar')) this.onSelect();
      },
      { signal: this.abort.signal },
    );
    this.on($('ar-size'), () => {
      this.stage.nextSize();
      this.refresh();
    });
    this.on($('ar-again'), () => {
      stopSound();
      this.stage.unplace();
      this.refresh();
    });
    this.on($('ar-place'), () => {
      if (this.stage.place === 'era') this.leaveEra();
      else this.openSafety();
    });
    this.on($('ar-safety-no'), () => this.closeSafety(true));
    this.on($('ar-safety-yes'), () => {
      this.closeSafety();
      // 가는 동안 전환 버튼은 꺼지므로 초점을 나가기에 두었다가 돌려준다.
      $('ar-exit').focus();
      void this.enterEra();
    });
    preloadSound(this.dino.id);
    this.refresh();
  }

  private get bars() {
    return this.ui.querySelectorAll<HTMLElement>('.ar-top, .ar-bottom');
  }

  private openSafety() {
    for (const b of this.bars) b.inert = true;
    $('ar-safety').hidden = false;
    $('ar-safety-no').focus();
  }

  private closeSafety(focus = false) {
    $('ar-safety').hidden = true;
    for (const b of this.bars) b.inert = false;
    if (focus) $('ar-place').focus();
  }

  private get canMove() {
    return this.modelReady && (this.stage.place === 'era' || this.stage.placed);
  }

  private refresh() {
    const era = this.stage.place === 'era';
    $('ar-place').textContent = era ? '현실로 돌아가기' : '공룡 시대로 가기';
    $<HTMLButtonElement>('ar-place').disabled = !this.modelReady || this.entering;
    $('ar-tools').hidden = era || !this.stage.placed;
    $<HTMLButtonElement>('ar-again').disabled = this.entering;
    $('ar-moves').hidden = !this.canMove;
    $('ar-here').hidden = era || this.stage.placed || !this.modelReady;
    $<HTMLButtonElement>('ar-here').disabled = this.entering;
    $('ar-size').textContent = `크기: ${this.stage.sizeLabel}`;
    if (this.modelFailed) this.say('공룡을 불러오지 못했어요. 나가기를 누르고 다시 시도해 주세요.');
    else if (!this.modelReady) this.say('공룡을 불러오는 중…');
    else if (this.entering) this.say('공룡 시대로 가는 중…');
    else if (!this.canMove) this.say('책상이나 바닥을 천천히 비추고, 동그라미가 보이면 화면을 톡 누르세요. 안 보이면 "바로 앞에 놓기"를 누르세요.');
    else this.say('');
  }

  private say(text: string, seconds = 0) {
    clearTimeout(this.messageTimer);
    $('ar-message').textContent = text;
    if (seconds) this.messageTimer = window.setTimeout(() => !this.ended && this.refresh(), seconds * 1000);
  }

  private async enterEra() {
    if (this.entering || this.stage.place === 'era') return;
    this.entering = true;
    this.refresh();
    let ok = true;
    try {
      await this.stage.loadEra();
    } catch {
      ok = false;
    }
    if (this.ended || this.ending || !this.entering) return;
    this.entering = false;
    this.refresh();
    if (document.activeElement === $('ar-exit')) $('ar-place').focus();
    if (!ok) {
      this.say('배경을 불러오지 못했어요. 인터넷 연결을 확인해 주세요.', 4);
      return;
    }
    if (!this.tracking) {
      this.say('위치를 찾는 중이에요. 폰을 천천히 움직인 뒤 다시 눌러 주세요.', 4);
      return;
    }
    stopSound();
    const dir = new THREE.Vector3();
    this.renderer.xr.getCamera().getWorldDirection(dir);
    this.eraOrigin.copy(this.cameraPos);
    this.lost = 0;
    const floor = this.floorY ?? this.cameraPos.y - EYE_HEIGHT;
    this.stage.enterEra(this.cameraPos, Math.atan2(-dir.x, -dir.z), floor);
    this.refresh();
    this.say('제자리에서 폰을 돌려 둘러보세요. 걸어 다니지 마세요!', 5);
  }

  private leaveEra(reason = '') {
    stopSound();
    this.stage.leaveEra();
    this.refresh();
    if (reason) this.say(reason, 5);
  }

  /** 기기가 좌표 기준을 다시 잡으면 전에 놓은 자리와 시작 자리를 믿을 수 없다. */
  private onReset = () => {
    if (this.ended) return;
    // 진행 중인 전환과 이전 좌표를 모두 버리고 새 프레임을 기다린다.
    this.entering = false;
    this.tracking = false;
    this.hasPose = false;
    this.reticle.visible = false;
    this.tapAt = -Infinity;
    this.closeSafety();
    stopSound();
    if (this.stage.place === 'era') this.stage.leaveEra();
    this.stage.unplace();
    this.refresh();
    this.say('위치를 다시 잡았어요. 공룡을 다시 놓아 주세요.', 5);
  };

  private onSelect = () => {
    if (this.ending || this.entering || !this.modelReady || !$('ar-safety').hidden) return;
    if (this.stage.place !== 'real' || this.stage.placed) return;
    const tapped = this.last - this.tapAt < 400;
    if (tapped) this.put(this.tapPoint);
    else if (this.reticle.visible) this.put(this.reticle.position);
    else this.say('아직 평면을 못 찾았어요. 책상이나 바닥을 천천히 비추거나 "바로 앞에 놓기"를 누르세요.', 4);
  };

  private put(point: THREE.Vector3) {
    this.stage.putAt(point, this.cameraPos, this.floorY);
    this.reticle.visible = false;
    this.tapAt = -Infinity;
    this.refresh();
  }

  /** 평면을 못 찾아도 보고 있는 쪽 앞에 놓는다. */
  private placeAhead() {
    if (this.entering || this.stage.place !== 'real' || this.stage.placed || !this.modelReady) return;
    if (this.reticle.visible) {
      this.put(this.reticle.position);
      return;
    }
    if (!this.hasPose) {
      this.say('위치를 찾는 중이에요. 폰을 천천히 움직인 뒤 다시 눌러 주세요.', 4);
      return;
    }
    const dir = new THREE.Vector3(this.forward.x, 0, this.forward.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, -1);
    dir.normalize();
    // 아래를 보고 있으면 시선을 따라, 아니면 조금 아래에 놓는다.
    const drop = Math.min(0.6, Math.max(0.25, 0.7 * Math.max(0, -this.forward.y)));
    this.put(this.cameraPos.clone().addScaledVector(dir, 0.7).add(new THREE.Vector3(0, -drop, 0)));
  }

  private frame = (time: number, frame?: XRFrame) => {
    if (!frame || this.ended) return;
    const elapsed = this.last ? Math.max(0, (time - this.last) / 1000) : 0;
    this.last = time;
    const space = this.renderer.xr.getReferenceSpace();
    const pose = space ? frame.getViewerPose(space) : undefined;
    this.hasPose = !!pose;
    this.tracking = !!pose && !pose.emulatedPosition;
    if (pose) {
      const p = pose.transform.position;
      this.cameraPos.set(p.x, p.y, p.z);
      const o = pose.transform.orientation;
      this.forward.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(o.x, o.y, o.z, o.w));
    }
    const floor = this.floorSpace && space ? frame.getPose(this.floorSpace, space) : undefined;
    if (floor) this.floorY = floor.transform.position.y;
    this.reticle.visible = false;
    if (this.stage.place === 'era') {
      this.lost = this.tracking ? 0 : this.lost + elapsed;
      const moved = Math.hypot(this.cameraPos.x - this.eraOrigin.x, this.cameraPos.z - this.eraOrigin.z);
      if (this.lost > LOST_SECONDS) this.leaveEra('위치를 놓쳐서 현실로 돌아왔어요.');
      else if (this.tracking && moved > SAFE_DISTANCE) this.leaveEra('너무 많이 움직여서 현실로 돌아왔어요. 주변을 확인하세요!');
    } else if (!this.stage.placed && space && this.hasPose) {
      this.searching += elapsed;
      this.aim(frame, space);
    }
    if (this.stage.placed) this.searching = 0;
    // 오래 멈췄다 돌아와도 동작이 한꺼번에 튀지 않게 애니메이션에만 상한을 둔다.
    this.stage.update(Math.min(0.1, elapsed), this.cameraPos);
    this.renderer.render(this.stage.scene, this.camera);
  };

  /** 결과의 위쪽 축이 하늘을 향하는 면(책상, 바닥)을 고른다. 오래 못 찾으면 눈보다 아래의 점도 받는다. */
  private surface(results: readonly XRHitTestResult[], space: XRReferenceSpace): THREE.Vector3 | null {
    let loose: THREE.Vector3 | null = null;
    for (const hit of results) {
      const t = hit.getPose(space)?.transform;
      if (!t) continue;
      const p = new THREE.Vector3(t.position.x, t.position.y, t.position.z);
      const up = t.matrix[5] ?? 0;
      if (up >= 0.85) return p;
      // 벽(위쪽 축이 거의 누움)과 천장은 끝까지 받지 않는다.
      if (!loose && up >= 0.4 && this.searching > 3 && p.y < this.cameraPos.y - 0.2 && p.distanceTo(this.cameraPos) < 3) loose = p;
    }
    return loose;
  }

  private aim(frame: XRFrame, space: XRReferenceSpace) {
    if (this.tapSource) {
      for (const tap of frame.getHitTestResultsForTransientInput(this.tapSource)) {
        const p = this.surface(tap.results, space);
        if (!p) continue;
        this.tapPoint.copy(p);
        this.tapAt = this.last;
      }
    }
    for (const source of this.hitSources) {
      const p = this.surface(frame.getHitTestResults(source), space);
      if (!p) continue;
      this.reticle.position.copy(p);
      this.reticle.scale.setScalar(Math.max(1, p.distanceTo(this.cameraPos)));
      this.reticle.visible = true;
      return;
    }
  }

  private finish() {
    this.ended = true;
    this.entering = false;
    // 화면과 버튼부터 되돌려, 뒤의 정리가 실패해도 다시 쓸 수 있게 한다.
    clearTimeout(this.messageTimer);
    this.abort.abort();
    this.closeSafety();
    this.ui.hidden = true;
    stopSound();
    this.session.removeEventListener('select', this.onSelect);
    this.renderer.setAnimationLoop(null);
    for (const source of this.hitSources) cancel(source);
    if (this.tapSource) cancel(this.tapSource);
    this.stage.dispose();
    for (const o of [this.reticle, ...this.reticle.children]) (o as THREE.Mesh).geometry.dispose();
    (this.reticle.material as THREE.Material).dispose();
    this.renderer.dispose();
  }
}
