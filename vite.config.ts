import { defineConfig } from 'vite';

// 상대 경로라서 하위 폴더(예: GitHub Pages)에 올려도 그대로 동작한다.
export default defineConfig({ base: './' });
