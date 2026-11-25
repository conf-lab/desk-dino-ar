import { soundUrl } from './dinos';

let context: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;
let request = 0;
const buffers = new Map<string, Promise<AudioBuffer>>();

/** 브라우저는 사용자가 누른 순간에만 소리를 허락하므로 버튼을 누를 때마다 부른다. */
export function unlockAudio(): AudioContext | null {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
  } catch {
    return null; // 소리를 못 내는 기기에서도 나머지는 동작해야 한다.
  }
}

function load(ctx: AudioContext, id: string): Promise<AudioBuffer> {
  let p = buffers.get(id);
  if (!p) {
    p = fetch(soundUrl(id))
      .then((r) => {
        if (!r.ok) throw new Error(`소리 파일 ${r.status}`);
        return r.arrayBuffer();
      })
      .then((b) => ctx.decodeAudioData(b));
    p.catch(() => buffers.delete(id)); // 실패하면 다음에 다시 받는다.
    buffers.set(id, p);
  }
  return p;
}

export function preloadSound(id: string) {
  const ctx = unlockAudio();
  if (ctx) load(ctx, id).catch(() => {});
}

/** 아직 받는 중인 소리가 뒤늦게 나오지 않게 한다. 이미 나오는 소리는 그대로 둔다. */
export function cancelPendingSound() {
  request += 1;
}

export function stopSound() {
  cancelPendingSound();
  const node = playing;
  playing = null;
  try {
    node?.stop();
  } catch {
    // 이미 끝난 소리
  }
}

export async function playSound(id: string): Promise<void> {
  const ctx = unlockAudio();
  if (!ctx) return;
  stopSound();
  const mine = request;
  try {
    const buffer = await load(ctx, id);
    if (mine !== request) return; // 기다리는 동안 멈췄거나 다른 소리를 틀었다.
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(ctx.destination);
    node.addEventListener('ended', () => {
      node.disconnect();
      if (playing === node) playing = null;
    });
    node.start();
    playing = node;
  } catch (e) {
    console.warn('소리를 내지 못했습니다.', e);
  }
}
