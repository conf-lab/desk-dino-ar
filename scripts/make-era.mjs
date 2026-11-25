// 코덱스가 만든 배경 이미지를 공룡 시대 모드용으로 가공한다.
// 원경 4장: 마젠타를 지우고 360도로 이어 4조각 WebP로. 바닥: 이음새 없는 WebP로. 식물: 마젠타를 지운 WebP로.
import sharp from 'sharp';
import { existsSync, mkdirSync } from 'node:fs';

const SRC = 'assets/background';
const OUT = 'src/era';
mkdirSync(OUT, { recursive: true });

async function keyed(file, width) {
  const { data, info } = await sharp(file).resize({ width }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  const out = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let [r, g, b] = [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]];
    const key = Math.min(r, b) - g;
    const a = 1 - Math.min(1, Math.max(0, (key - 18) / 70));
    if (key > 0) { r = Math.min(r, g + 6); b = Math.min(b, g + 10); }
    out.set([r, g, b, Math.round(a * 255)], i * 4);
  }
  return { out, w, h };
}

const STEP = 2048, OVER = 200, FRAME = 900, SKY = 420; // SKY: 양 끝 능선을 맞출 줄
const FOG = [169, 183, 154]; // src/ar/era.ts의 안개색과 같아야 한다
async function horizon() {
  const names = ['conifer', 'volcano', 'valley', 'ridge'];
  const W = STEP * 4;
  const acc = new Float32Array(W * FRAME * 4), sum = new Float32Array(W * FRAME);
  for (const [n, name] of names.entries()) {
    const { out, w, h } = await keyed(`${SRC}/horizon-${name}.png`, STEP + OVER);
    const edge = [];
    for (const x of [3, 10, w - 11, w - 4]) { let y = 0; while (y < h && out[(y * w + x) * 4 + 3] < 128) y++; edge.push(y); }
    console.log(name, `${w}x${h}`, '양 끝 능선', edge.join());
    for (let x = 0; x < w; x++) {
      const wt = Math.max(1e-4, Math.min(1, x / OVER, (w - 1 - x) / OVER));
      const X = (n * STEP + x) % W;
      // 양 끝의 높이 차이를 펴서 이음새에서 능선이 만나게 한다.
      const t = x / (w - 1);
      const local = (edge[0] + edge[1]) / 2 * (1 - t) + (edge[2] + edge[3]) / 2 * t;
      for (let Y = 0; Y < FRAME; Y++) {
        // 능선 아래는 그림마다 높이가 달라 같은 비율로 맞춘다.
        const y = Math.min(h - 1, Math.round(Y < SKY ? Y - SKY + local : local + (Y - SKY) * (h - local) / (FRAME - SKY)));
        const i = (Math.max(0, y) * w + x) * 4, a = y < 0 ? 0 : out[i + 3] / 255, o = Y * W + X;
        for (let c = 0; c < 3; c++) acc[o * 4 + c] += out[i + c] * a * wt;
        acc[o * 4 + 3] += a * wt; sum[o] += wt;
      }
    }
  }
  const px = Buffer.alloc(W * FRAME * 4);
  for (let i = 0; i < W * FRAME; i++) {
    const a = acc[i * 4 + 3];
    const Y = Math.floor(i / W);
    const f = Math.min(1, Math.max(0, (Y - SKY - 170) / (FRAME - SKY - 250)));
    const fog = f * f * (3 - 2 * f);
    for (let c = 0; c < 3; c++) px[i * 4 + c] = (a > 0 ? Math.min(255, acc[i * 4 + c] / a) : FOG[c]) * (1 - fog) + FOG[c] * fog;
    px[i * 4 + 3] = Math.round(255 * a / sum[i]);
  }
  for (let k = 0; k < 4; k++) {
    const info = await sharp(px, { raw: { width: W, height: FRAME, channels: 4 } }).extract({ left: k * STEP, top: 0, width: STEP, height: FRAME })
      .webp({ quality: 82, alphaQuality: 90 }).toFile(`${OUT}/horizon-${k}.webp`);
    console.log(`horizon-${k}`, info.size);
  }
  await sharp(px, { raw: { width: W, height: FRAME, channels: 4 } }).flatten({ background: '#bcd6e2' }).resize({ width: 2400 }).png().toFile(`${process.env.PREVIEW ?? OUT}/horizon-preview.png`);
  const at = (Y) => { let s = [0, 0, 0]; for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) s[c] += px[(Y * W + x) * 4 + c]; return s.map((v) => Math.round(v / W)); };
  console.log('맨 아래 안개색', at(FRAME - 1), '중간', at(FRAME - 200));
}

// 반쪽씩 밀어 만든 이음새를 가운데 십자로 섞어 어느 쪽으로든 이어지게 한다.
async function ground(name) {
  const N = 1024;
  const { data } = await sharp(`${SRC}/ground-${name}.png`).resize(N, N).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const px = Buffer.alloc(N * N * 3), at = (x, y, c) => data[(((y + N) % N) * N + ((x + N) % N)) * 3 + c];
  const ramp = (d) => Math.min(1, Math.max(0, d / 140));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const m = ramp(Math.min(x, N - 1 - x)) , k = ramp(Math.min(y, N - 1 - y));
    for (let c = 0; c < 3; c++) {
      const h = at(x, y, c) * m + at(x + N / 2, y, c) * (1 - m);
      const v = at(x, y + N / 2, c) * m + at(x + N / 2, y + N / 2, c) * (1 - m);
      px[(y * N + x) * 3 + c] = h * k + v * (1 - k);
    }
  }
  const info = await sharp(px, { raw: { width: N, height: N, channels: 3 } }).webp({ quality: 80 }).toFile(`${OUT}/ground-${name}.webp`);
  console.log(`ground-${name}`, info.size);
}

async function plant(name) {
  const file = `${SRC}/plant-${name}.png`;
  if (!existsSync(file)) return console.log('없음', file);
  const { out, w, h } = await keyed(file, 900);
  const info = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).trim({ threshold: 5 }).resize({ width: 512, height: 768, fit: 'inside' })
    .webp({ quality: 84, alphaQuality: 90 }).toFile(`${OUT}/plant-${name}.webp`);
  console.log(`plant-${name}`, `${info.width}x${info.height}`, info.size);
}

await horizon();
for (const g of ['dirt', 'fern']) await ground(g);
for (const p of ['araucaria', 'conifer', 'treefern', 'fern']) await plant(p);
