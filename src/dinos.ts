export interface Dino {
  id: string;
  ko: string;
  en: string;
  aliases: string[];
  /** 실제 몸길이(미터). scripts/prepare-model.mjs에 같은 값을 넘겨 크기를 맞춘다. */
  lengthM: number;
  period: string;
  diet: string;
  fact: string;
}

export const DINOS: Dino[] = [
  {
    id: 'trex',
    ko: '티라노사우루스',
    en: 'Tyrannosaurus rex',
    aliases: ['티라노', '티렉스', 't-rex', 'trex', 'tyrannosaurus'],
    lengthM: 12,
    period: '백악기 후기',
    diet: '육식',
    fact: '앞발가락은 두 개뿐이지만, 무는 힘은 육상 동물 가운데 가장 강한 축에 들었어요.',
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

export type SceneMode = 'meadow' | 'desk' | 'real';

// Vite가 내용에 따라 파일 이름을 바꾸므로, 새로 배포하면 예전 파일이 캐시에서 나오지 않는다.
const MODELS = import.meta.glob<string>('./models/*.glb', { query: '?url', import: 'default', eager: true });

export function modelUrl(id: string, mode: SceneMode): string {
  const url = MODELS[`./models/${id}-${mode}.glb`];
  if (!url) throw new Error(`3D 모델이 없습니다: ${id}-${mode}`);
  return url;
}
