// 원본 GLB를 AR용으로 정리한다: 발을 바닥(y=0)에, 중심을 원점에, 몸길이를 지정 크기로.
// Scene Viewer는 파일 크기를 그대로 쓰므로 화면에서 확대하지 않고 파일 자체에 크기를 굽는다.
// 사용: node scripts/prepare-model.mjs <원본.glb> <id> <실제 길이(m)> [출력 폴더]
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [src, id, realArg, outDir = 'public/models'] = process.argv.slice(2);
const realLength = Number(realArg);
if (!src || !/^[a-z0-9-]+$/.test(id ?? '') || !(realLength > 0)) {
  console.error('사용: node scripts/prepare-model.mjs <원본.glb> <id> <실제 길이(m)> [출력 폴더]');
  process.exit(1);
}

const DESK_LENGTH = 0.3;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
mkdirSync(outDir, { recursive: true });

for (const [mode, target] of [['desk', DESK_LENGTH], ['real', realLength]]) {
  const doc = await io.read(src);
  const root = doc.getRoot();
  // 바닥과 길이를 정지 자세의 정점으로 재므로, 그 값이 틀어질 수 있는 입력은 거절한다.
  if (root.listScenes().length !== 1) throw new Error('씬이 하나인 파일만 지원합니다.');
  if (root.listAnimations().length || root.listSkins().length) throw new Error('애니메이션·스킨이 있는 파일은 지원하지 않습니다.');
  if (root.listMeshes().some((m) => m.listPrimitives().some((p) => p.listTargets().length))) throw new Error('모프 타깃이 있는 파일은 지원하지 않습니다.');
  if (root.listMaterials().some((m) => m.getAlphaMode() !== 'OPAQUE')) throw new Error('투명 재질은 지원하지 않습니다.');
  const scene = root.listScenes()[0];
  const { min, max } = getBounds(scene);
  const length = Math.max(max[0] - min[0], max[2] - min[2]);
  if (!(length > 0 && Number.isFinite(length))) throw new Error('모델이 비어 있습니다.');

  const s = target / length;
  const wrapper = doc
    .createNode('dino')
    .setScale([s, s, s])
    .setTranslation([(-s * (min[0] + max[0])) / 2, -s * min[1], (-s * (min[2] + max[2])) / 2]);
  for (const child of scene.listChildren()) wrapper.addChild(child);
  scene.addChild(wrapper);
  // 색은 JPEG, 노멀·재질 값은 PNG. Scene Viewer가 읽는 형식만 쓴다(WebP·KTX2·메시 압축 제외).
  await doc.transform(
    dedup(),
    weld(),
    textureCompress({ encoder: sharp, targetFormat: 'jpeg', slots: /^baseColor/, resize: [2048, 2048], quality: 85 }),
    textureCompress({ encoder: sharp, targetFormat: 'png', slots: /^(?!baseColor)/, resize: [1024, 1024] }),
    prune(),
  );

  for (const t of root.listTextures()) {
    if (!['image/jpeg', 'image/png'].includes(t.getMimeType()) || Math.max(...t.getSize()) > 2048) {
      throw new Error(`텍스처가 휴대폰용으로 줄지 않았습니다: ${t.getMimeType()} ${t.getSize()}`);
    }
  }

  const out = join(outDir, `${id}-${mode}.glb`);
  await io.write(out, doc);

  const b = getBounds(scene);
  const triangles = root
    .listMeshes()
    .flatMap((m) => m.listPrimitives())
    .reduce((n, p) => n + (p.getIndices() ?? p.getAttribute('POSITION')).getCount() / 3, 0);
  console.log(out, {
    sizeM: b.max.map((v, i) => +(v - b.min[i]).toFixed(3)),
    floorY: +b.min[1].toFixed(4),
    triangles,
  });
}
