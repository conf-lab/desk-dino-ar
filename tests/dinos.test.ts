import { describe, expect, it } from 'vitest';
import { eraPath } from '../src/ar/stage';
import { DINOS, modelUrl, searchDinos, soundUrl } from '../src/dinos';

describe('searchDinos', () => {
  it.each([
    ['티라노', 'trex'],
    ['T-Rex', 'trex'],
    [' t rex ', 'trex'],
    ['트리케라톱스', 'triceratops'],
    ['브라키오', 'brachiosaurus'],
    ['목 긴 공룡', 'brachiosaurus'],
    ['스테고사우루스', 'stegosaurus'],
    ['익룡', 'pteranodon'],
    ['프테라노돈', 'pteranodon'],
  ])('%s: %s', (q, id) => {
    expect(searchDinos(q)[0]?.id).toBe(id);
  });

  it.each(['', '   ', '!!!', '고양이'])('%j: 결과 없음', (q) => {
    expect(searchDinos(q)).toEqual([]);
  });

  it('자모가 분리된 한글도 찾는다', () => {
    expect(searchDinos('티라노'.normalize('NFD'))[0]?.id).toBe('trex');
  });

  it('앞부분이 맞는 이름을 먼저 보여 준다', () => {
    const base = DINOS[0]!;
    const a = { ...base, id: 'a', ko: '가나다', en: 'a', aliases: [] };
    const b = { ...base, id: 'b', ko: '나다', en: 'b', aliases: [] };
    expect(searchDinos('나다', [a, b]).map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe.each(DINOS)('$ko', (dino) => {
  it('3D 파일과 소리 파일이 있다', () => {
    expect(modelUrl(dino.id)).toBeTruthy();
    expect(soundUrl(dino.id)).toBeTruthy();
  });

  it('뛰기가 걷기보다 빠르다', () => {
    expect(dino.speed.run).toBeGreaterThan(dino.speed.walk);
  });

  it('공룡 시대의 길이 보는 사람과 겹치지 않는다', () => {
    const p = eraPath(dino);
    expect(p.center.length() - p.radius - dino.lengthM / 2).toBeGreaterThan(3);
  });
});

it('공룡은 다섯 마리이고 id가 겹치지 않는다', () => {
  expect(new Set(DINOS.map((d) => d.id)).size).toBe(5);
});

it('없는 모델은 오류로 알린다', () => {
  expect(() => modelUrl('none')).toThrow();
});
