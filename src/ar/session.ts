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
      requiredFeatures: ['hit-test', 'dom-overlay'],
      optionalFeatures: ['local-floor'],
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

class Run {
  readonly done: Promise<void>;
  private renderer: THREE.WebGLRenderer;
  private stage: Stage;
  private camera = new THREE.PerspectiveCamera(60, 1, 0.03, 200);
  private reticle: THREE.Mesh;
  private hitSource: XRHitTestSource | null = null;
  private abort = new AbortController();
  private cameraPos = new THREE.Vector3();
  private eraOrigin = new THREE.Vector3();
  private hasFloor = false;
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
      new THREE.RingGeometry(0.06, 0.075, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: '#ffffff' }),
    );
    this.reticle.visible = false;
    this.stage.scene.add(this.reticle);
    this.done = new Promise((resolve, reject) =>
      session.addEventListener(
        'end',
        () => {
          this.finish();
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
    let type: XRReferenceSpaceType = 'local';
    try {
      await this.session.requestReferenceSpace('local-floor');
      type = 'local-floor';
      this.hasFloor = true;
    } catch {
      // 바닥 높이를 모르면 시작한 자세의 눈높이에서 어림한다.
    }
    if (this.ended) return;
    this.renderer.xr.setReferenceSpaceType(type);
    // 세션을 넘기기 전에 걸어야 한다. 뒤에 걸면 일반 화면용 갱신까지 함께 돈다.
    this.renderer.setAnimationLoop(this.frame);
    await this.renderer.xr.setSession(this.session);
    this.renderer.xr.getReferenceSpace()?.addEventListener('reset', this.onReset, { signal: this.abort.signal });
    const viewer = await this.session.requestReferenceSpace('viewer');
    const source = (await this.session.requestHitTestSource?.({ space: viewer })) ?? null;
    if (!source) throw new Error('평면을 찾는 기능을 쓸 수 없습니다.');
    if (this.ended) {
      source.cancel();
      return;
    }
    this.hitSource = source;
    this.session.addEventListener('select', this.onSelect);
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
    $('ar-size').textContent = `크기: ${this.stage.sizeLabel}`;
    if (this.modelFailed) this.say('공룡을 불러오지 못했어요. 나가기를 누르고 다시 시도해 주세요.');
    else if (!this.modelReady) this.say('공룡을 불러오는 중…');
    else if (this.entering) this.say('공룡 시대로 가는 중…');
    else if (!this.canMove) this.say('책상이나 바닥을 천천히 비춘 뒤, 동그라미가 보이면 화면을 톡 누르세요.');
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
    const floor = this.hasFloor ? 0 : this.cameraPos.y - EYE_HEIGHT;
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
    this.closeSafety();
    stopSound();
    if (this.stage.place === 'era') this.stage.leaveEra();
    this.stage.unplace();
    this.refresh();
    this.say('위치를 다시 잡았어요. 공룡을 다시 놓아 주세요.', 5);
  };

  private onSelect = () => {
    if (this.ending || this.entering || !this.modelReady || !$('ar-safety').hidden) return;
    if (this.stage.place !== 'real' || this.stage.placed || !this.reticle.visible) return;
    this.stage.putAt(this.reticle.position, this.cameraPos);
    this.reticle.visible = false;
    this.refresh();
  };

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
    }
    this.reticle.visible = false;
    if (this.stage.place === 'era') {
      this.lost = this.tracking ? 0 : this.lost + elapsed;
      const moved = Math.hypot(this.cameraPos.x - this.eraOrigin.x, this.cameraPos.z - this.eraOrigin.z);
      if (this.lost > LOST_SECONDS) this.leaveEra('위치를 놓쳐서 현실로 돌아왔어요.');
      else if (this.tracking && moved > SAFE_DISTANCE) this.leaveEra('너무 많이 움직여서 현실로 돌아왔어요. 주변을 확인하세요!');
    } else if (!this.stage.placed && this.hitSource && space && this.hasPose) {
      this.aim(frame, space, this.hitSource);
    }
    // 오래 멈췄다 돌아와도 동작이 한꺼번에 튀지 않게 애니메이션에만 상한을 둔다.
    this.stage.update(Math.min(0.1, elapsed), this.cameraPos);
    this.renderer.render(this.stage.scene, this.camera);
  };

  private aim(frame: XRFrame, space: XRReferenceSpace, source: XRHitTestSource) {
    for (const hit of frame.getHitTestResults(source)) {
      const t = hit.getPose(space)?.transform;
      if (!t) continue;
      // 결과의 위쪽 축이 하늘을 향하는 면(책상, 바닥)만 받는다.
      if ((t.matrix[5] ?? 0) < 0.85) continue;
      this.reticle.position.set(t.position.x, t.position.y, t.position.z);
      this.reticle.visible = true;
      return;
    }
  }

  private finish() {
    this.ended = true;
    this.entering = false;
    clearTimeout(this.messageTimer);
    this.abort.abort();
    this.session.removeEventListener('select', this.onSelect);
    stopSound();
    this.renderer.setAnimationLoop(null);
    this.hitSource?.cancel();
    this.stage.dispose();
    this.reticle.geometry.dispose();
    (this.reticle.material as THREE.Material).dispose();
    this.renderer.dispose();
    this.closeSafety();
    this.ui.hidden = true;
  }
}
