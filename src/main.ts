import '@google/model-viewer';
import type { ModelViewerElement } from '@google/model-viewer';
import './style.css';
import { DINOS, modelUrl, searchDinos, type Dino, type SizeMode } from './dinos';

const $ = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`화면 요소가 없습니다: ${selector}`);
  return el;
};

const form = $<HTMLFormElement>('#search');
const input = $<HTMLInputElement>('#q');
const submit = $<HTMLButtonElement>('#search button');
const message = $<HTMLElement>('#message');
const stage = $<HTMLElement>('#stage');
const title = $<HTMLElement>('#name');
const viewer = $<ModelViewerElement>('#viewer');
const arButton = $<HTMLButtonElement>('#ar');
const arNote = $<HTMLElement>('#ar-note');
const sizes = $<HTMLFieldSetElement>('#sizes');
const sizeInputs = document.querySelectorAll<HTMLInputElement>('input[name="size"]');

let current: Dino | null = null;
let size: SizeMode = 'desk';
let loading = false;
let noteTimer = 0;
const failures = new Map<string, number>();
let requested = '';
let focusBack: HTMLElement | null = null;

// 로딩 중에는 모델을 바꾸거나 AR을 시작하지 못하게 한다.
// model-viewer는 취소된 이전 로드에도 load를 보낼 수 있어, 한 번에 하나만 불러온다.
function setLoading(on: boolean) {
  loading = on;
  submit.disabled = on;
  sizes.disabled = on;
  arButton.hidden = on;
  // 잠그는 동안 라디오가 포커스를 잃으므로, 다른 곳으로 옮기지 않았을 때만 되돌린다.
  if (!on) {
    if (document.activeElement === document.body) focusBack?.focus();
    focusBack = null;
  }
}

function loadModel() {
  if (!current || loading) return;
  // model-viewer는 실패한 주소도 캐시하므로, 실패한 뒤에는 주소를 바꿔 새로 받는다.
  const base = modelUrl(current.id, size);
  const retry = failures.get(base);
  const url = retry ? `${base}?retry=${retry}` : base;
  if (viewer.getAttribute('src') === url) return;
  clearInterval(noteTimer);
  arNote.hidden = true;
  requested = base;
  setLoading(true);
  message.textContent = '공룡을 불러오는 중…';
  viewer.alt = `${current.ko} 3D 모델`;
  // 실제 크기는 그대로 봐야 하므로 손가락 확대를 막는다.
  viewer.setAttribute('ar-scale', size === 'real' ? 'fixed' : 'auto');
  viewer.setAttribute('src', url);
}

function show(dino: Dino) {
  current = dino;
  message.textContent = '';
  title.textContent = dino.ko;
  $('#latin').textContent = dino.en;
  $('#length').textContent = `약 ${dino.lengthM}m`;
  $('#period').textContent = dino.period;
  $('#diet').textContent = dino.diet;
  $('#fact').textContent = dino.fact;
  stage.hidden = false;
  title.focus();
  loadModel();
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
  stage.hidden = true;
  current = null;
  const names = DINOS.map((d) => d.ko).join(', ');
  message.textContent = `'${q}'은(는) 아직 준비하지 못했어요. 지금 볼 수 있는 공룡: ${names}`;
});

sizeInputs.forEach((radio) =>
  radio.addEventListener('change', () => {
    size = radio.value as SizeMode;
    focusBack = radio;
    loadModel();
  }),
);

viewer.addEventListener('load', () => {
  setLoading(false);
  message.textContent = '';
  // AR 지원 검사는 비동기라 load보다 늦게 끝날 수 있다.
  clearInterval(noteTimer);
  noteTimer = window.setInterval(() => {
    arNote.hidden = viewer.canActivateAR;
  }, 1500);
});

viewer.addEventListener('error', (e: Event) => {
  // 렌더링 오류 등도 이 이벤트로 오므로, 모델 로드 실패만 처리한다.
  const detail = (e as CustomEvent<{ type?: string }>).detail;
  if (detail?.type !== 'loadfailure') return;
  setLoading(false);
  arButton.hidden = true;
  failures.set(requested, (failures.get(requested) ?? 0) + 1);
  viewer.removeAttribute('src');
  message.textContent = '공룡을 불러오지 못했어요. 인터넷 연결을 확인하고 다시 찾아 주세요.';
});

viewer.addEventListener('ar-status', (e: Event) => {
  const s = (e as CustomEvent<{ status: string }>).detail.status;
  if (s === 'session-started') message.textContent = '';
  // 모델을 비울 때도 failed가 오므로 모델이 있을 때만 알린다.
  else if (s === 'failed' && viewer.hasAttribute('src')) {
    message.textContent = 'AR을 시작하지 못했어요. 카메라 권한과 기기의 AR 지원(ARCore)을 확인해 주세요.';
  }
});
