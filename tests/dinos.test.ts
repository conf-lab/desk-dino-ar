import { describe, expect, it } from 'vitest';
import { DINOS, modelUrl, searchDinos } from '../src/dinos';

describe('searchDinos', () => {
  it.each(['티라노', '티라노사우루스', '티렉스', 'T-Rex', 'TREX', ' t rex ', '사우루스'])('%s: 티라노를 찾는다', (q) => {
    expect(searchDinos(q)[0]?.id).toBe('trex');
  });

  it.each(['', '   ', '!!!', '트리케라톱스', '고양이'])('%j: 결과 없음', (q) => {
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

it('크기별로 다른 파일을 쓴다', () => {
  expect(modelUrl('trex', 'desk')).not.toBe(modelUrl('trex', 'real'));
});
