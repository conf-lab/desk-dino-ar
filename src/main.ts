import '@google/model-viewer';
import type { ModelViewerElement } from '@google/model-viewer';
import './style.css';
import { arSupported, runAR } from './ar/session';
import { DINOS, modelUrl, searchDinos, type Dino, type Motion } from './dinos';
import { cancelPendingSound, playSound, stopSound, unlockAudio } from './sound';

const $ = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`화면 요소가 없습니다: ${selector}`);
  return el;
};

const form = $<HTMLFormElement>('#search');
const input = $<HTMLInputElement>('#q');
const submit = $<HTMLButtonElement>('#search button');
const list = $<HTMLElement>('#list');
const message = $<HTMLElement>('#message');
const stage = $<HTMLElement>('#stage');
const title = $<HTMLElement>('#name');
const viewer = $<ModelViewerElement>('#viewer');
const arButton = $<HTMLButtonElement>('#ar');
const arNote = $<HTMLElement>('#ar-note');
const moves = $<HTMLFieldSetElement>('#moves');

const MOTIONS: Motion[] = ['idle', 'walk', 'run', 'roar'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let current: Dino | null = null;
let loading = false;
let busyAR = false;
let webxr = false;
let motion: Motion = 'idle';
let noteTimer = 0;
const failures = new Map<string, number>();
let requested = '';

// 로딩 중에는 공룡을 바꾸거나 AR을 시작하지 못하게 한다.
// model-viewer는 취소된 이전 로드에도 load를 보낼 수 있어, 한 번에 하나만 불러온다.
function setLoading(on: boolean) {
  loading = on;
  submit.disabled = on;
  moves.disabled = on;
  for (const b of list.querySelectorAll('button')) b.disabled = on;
  if (on) arButton.hidden = true;
}

/** AR 지원 검사는 비동기라 모델을 다 불러온 뒤에도 바뀔 수 있다. */
function refreshAR() {
  const can = webxr || viewer.canActivateAR;
  arButton.hidden = !can || !viewer.loaded || loading;
  arNote.hidden = can;
}

function setMotion(next: Motion) {
  motion = next;
  for (const m of MOTIONS) $(`#move-${m}`).setAttribute('aria-pressed', String(m === next));
  viewer.animationName = next;
}

/** 화면을 멈추거나 가릴 때: 울던 중이면 그만두고 쉬는 동작으로 돌려 둔다. */
function rest() {
  stopSound();
  if (motion === 'roar') setMotion('idle');
  viewer.pause();
}

/** 움직임을 줄이도록 설정했으면 저절로 다시 움직이지 않는다. */
function resume() {
  if (!viewer.loaded || busyAR) return;
  if (reducedMotion.matches) rest();
  else viewer.play();
}

function play(next: Motion) {
  setMotion(next);
  if (next === 'roar') {
    viewer.currentTime = 0;
    viewer.play({ repetitions: 1, pingpong: false });
    if (current) void playSound(current.id);
  } else {
    stopSound();
    viewer.play();
  }
}

function show(dino: Dino) {
  stopSound();
  message.textContent = '';
  stage.hidden = false;
  title.textContent = dino.ko;
  $('#latin').textContent = dino.en;
  $('#size').textContent = dino.sizeLabel;
  $('#period').textContent = dino.period;
  $('#diet').textContent = dino.diet;
  $('#fact').textContent = dino.fact;
  for (const m of MOTIONS) $(`#move-${m}`).textContent = dino.labels[m];
  for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === dino.id));
  title.focus();

  // model-viewer는 실패한 주소도 캐시하므로, 실패한 뒤에는 주소를 바꿔 새로 받는다.
  const base = modelUrl(dino.id);
  const retry = failures.get(base);
  const url = retry ? `${base}?retry=${retry}` : base;
  if (current === dino && viewer.getAttribute('src') === url) return;
  current = dino;
  requested = base;
  clearInterval(noteTimer);
  arNote.hidden = true;
  setLoading(true);
  message.textContent = '공룡을 불러오는 중…';
  viewer.alt = `${dino.ko} 3D 모델`;
  viewer.autoplay = false;
  viewer.animationName = 'idle';
  viewer.setAttribute('camera-orbit', dino.flies ? '40deg 70deg auto' : '50deg 80deg auto');
  viewer.setAttribute('src', url);
}

for (const dino of DINOS) {
  const b = document.createElement('button');
  b.type = 'button';
  b.dataset.id = dino.id;
  b.textContent = dino.ko;
  b.setAttribute('aria-pressed', 'false');
  b.addEventListener('click', () => !loading && show(dino));
  list.append(b);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || loading) return;
  const [found] = searchDinos(q);
  if (found) {
    show(found);
    return;
  }
  stopSound();
  stage.hidden = true;
  for (const b of list.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
  message.textContent = `'${q}'은(는) 아직 준비하지 못했어요. 위의 공룡을 눌러 보세요.`;
});

for (const m of MOTIONS) $(`#move-${m}`).addEventListener('click', () => play(m));

viewer.addEventListener('finished', () => {
  if (motion !== 'roar') return;
  cancelPendingSound();
  setMotion('idle');
  resume();
});

viewer.addEventListener('load', () => {
  setLoading(false);
  message.textContent = '';
  setMotion('idle');
  resume();
  refreshAR();
  arNote.hidden = true;
  clearInterval(noteTimer);
  noteTimer = window.setInterval(refreshAR, 1500);
});

viewer.addEventListener('error', (e: Event) => {
  // 렌더링 오류 등도 이 이벤트로 오므로, 모델 로드 실패만 처리한다.
  const detail = (e as CustomEvent<{ type?: string }>).detail;
  if (detail?.type !== 'loadfailure') return;
  setLoading(false);
  moves.disabled = true;
  arButton.hidden = true;
  failures.set(requested, (failures.get(requested) ?? 0) + 1);
  viewer.removeAttribute('src');
  message.textContent = '공룡을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 찾아 주세요.';
});

reducedMotion.addEventListener('change', resume);

arButton.addEventListener('click', async () => {
  if (!current || busyAR) return;
  unlockAudio();
  if (!webxr) {
    rest(); // 돌아오면 visibilitychange나 ar-status에서 다시 움직인다.
    void viewer.activateAR();
    return;
  }
  busyAR = true;
  arButton.disabled = true;
  rest();
  try {
    await runAR(current);
    message.textContent = '';
  } catch (e) {
    console.error(e);
    const denied = e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
    const fallback = !denied && viewer.canActivateAR;
    if (fallback) webxr = false;
    if (denied) message.textContent = 'AR을 시작하지 못했어요. 카메라 권한을 허용해 주세요.';
    else if (fallback) message.textContent = '이 기기에서는 버튼이 있는 AR을 쓸 수 없어요. 다시 누르면 간단한 AR로 열어요.';
    else message.textContent = 'AR을 시작하지 못했어요. 기기의 AR 지원(ARCore)을 확인해 주세요.';
  } finally {
    busyAR = false;
    arButton.disabled = false;
    resume();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resume();
  else if (!busyAR && viewer.loaded) rest();
});

viewer.addEventListener('ar-status', (e: Event) => {
  const s = (e as CustomEvent<{ status: string }>).detail.status;
  if (s === 'failed' || s === 'not-presenting') resume();
  // 모델을 비울 때도 failed가 오므로 모델이 있을 때만 알린다.
  if (s === 'failed' && viewer.hasAttribute('src') && !webxr && !loading) {
    message.textContent = 'AR을 시작하지 못했어요. 카메라 권한과 기기의 AR 지원(ARCore)을 확인해 주세요.';
  }
});

void arSupported().then((ok) => {
  webxr = ok;
  refreshAR();
  if (!viewer.loaded) arNote.hidden = true;
});
