export type Motion = 'idle' | 'walk' | 'run' | 'roar';

export interface Dino {
  id: string;
  ko: string;
  en: string;
  aliases: string[];
  /** 실제 크기(미터). 몸길이이며 익룡은 날개폭이다. 3D 파일은 이 길이가 0.3m가 되도록 줄여 두었다. */
  lengthM: number;
  sizeLabel: string;
  period: string;
  diet: string;
  fact: string;
  flies?: boolean;
  /** 제자리 동작과 발이 맞는 실제 이동 속도(m/s). scripts/rig_dinos.py가 출력하는 INFO 값과 같아야 한다. */
  speed: { idle: number; walk: number; run: number; roar: number };
  labels: Record<Motion, string>;
}

/** GLB 안에서 가장 긴 쪽의 길이(m) */
export const MODEL_LENGTH = 0.3;

const GROUND = { idle: '쉬기', walk: '걷기', run: '뛰기', roar: '포효하기' };

export const DINOS: Dino[] = [
  {
    id: 'trex',
    ko: '티라노사우루스',
    en: 'Tyrannosaurus rex',
    aliases: ['티라노', '티렉스', 't-rex', 'trex', 'tyrannosaurus'],
    lengthM: 12,
    sizeLabel: '몸길이 약 12m',
    period: '백악기 후기',
    diet: '육식',
    fact: '앞발가락은 두 개뿐이지만, 무는 힘은 육상 동물 가운데 가장 강한 축에 들었어요.',
    speed: { idle: 0, walk: 2.933, run: 8.64, roar: 0 },
    labels: GROUND,
  },
  {
    id: 'triceratops',
    ko: '트리케라톱스',
    en: 'Triceratops horridus',
    aliases: ['트리케라', '세뿔공룡', '뿔공룡'],
    lengthM: 8,
    sizeLabel: '몸길이 약 8m',
    period: '백악기 후기',
    diet: '초식',
    fact: '이름은 "뿔이 세 개 달린 얼굴"이라는 뜻이에요. 티라노사우루스와 같은 때에 살았어요.',
    speed: { idle: 0, walk: 1.49, run: 4.629, roar: 0 },
    labels: GROUND,
  },
  {
    id: 'brachiosaurus',
    ko: '브라키오사우루스',
    en: 'Brachiosaurus altithorax',
    aliases: ['브라키오', '목긴공룡', '목 긴 공룡'],
    lengthM: 22,
    sizeLabel: '몸길이 약 22m',
    period: '쥐라기 후기',
    diet: '초식',
    fact: '앞다리가 뒷다리보다 길고 목을 높이 들 수 있어서, 높은 나무의 잎을 먹을 수 있었어요.',
    speed: { idle: 0, walk: 2.092, run: 4.246, roar: 0 },
    labels: { ...GROUND, run: '빨리 걷기', roar: '울기' },
  },
  {
    id: 'stegosaurus',
    ko: '스테고사우루스',
    en: 'Stegosaurus stenops',
    aliases: ['스테고', '골판공룡'],
    lengthM: 7,
    sizeLabel: '몸길이 약 7m',
    period: '쥐라기 후기',
    diet: '초식',
    fact: '등에는 큰 골판이 줄지어 있고, 꼬리 끝의 뾰족한 가시 네 개로 몸을 지켰어요.',
    speed: { idle: 0, walk: 1.2, run: 2.824, roar: 0 },
    labels: { ...GROUND, roar: '울기' },
  },
  {
    id: 'pteranodon',
    ko: '프테라노돈',
    en: 'Pteranodon longiceps',
    aliases: ['익룡', '테라노돈', '프테라'],
    lengthM: 6,
    sizeLabel: '날개폭 약 6m',
    period: '백악기 후기',
    diet: '물고기',
    fact: '하늘을 나는 파충류인 익룡이에요. 공룡과 가까운 친척이지만 공룡은 아니에요.',
    flies: true,
    speed: { idle: 7, walk: 7, run: 13, roar: 6 },
    labels: { idle: '미끄러지기', walk: '날기', run: '빨리 날기', roar: '울기' },
  },
];

const normalize = (s: string) =>
  s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/** 이름이나 별명이 검색어로 시작하면 먼저, 포함하면 그다음에 보여 준다. */
export function searchDinos(query: string, dinos: Dino[] = DINOS): Dino[] {
  const q = normalize(query);
  if (!q) return [];
  const rank = (d: Dino) => {
    const names = [d.ko, d.en, ...d.aliases].map(normalize);
    if (names.some((n) => n.startsWith(q))) return 0;
    return names.some((n) => n.includes(q)) ? 1 : 2;
  };
  return dinos
    .map((dino) => ({ dino, r: rank(dino) }))
    .filter((x) => x.r < 2)
    .sort((a, b) => a.r - b.r)
    .map((x) => x.dino);
}

// Vite가 내용에 따라 파일 이름을 바꾸므로, 새로 배포하면 예전 파일이 캐시에서 나오지 않는다.
const MODELS = import.meta.glob<string>('./models/*.glb', { query: '?url', import: 'default', eager: true });
const SOUNDS = import.meta.glob<string>('./sounds/*.mp3', { query: '?url', import: 'default', eager: true });

function pick(files: Record<string, string>, path: string): string {
  const url = files[path];
  if (!url) throw new Error(`파일이 없습니다: ${path}`);
  return url;
}

export const modelUrl = (id: string) => pick(MODELS, `./models/${id}.glb`);
export const soundUrl = (id: string) => pick(SOUNDS, `./sounds/${id}.mp3`);
