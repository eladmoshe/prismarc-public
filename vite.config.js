import { defineConfig } from 'vite';
import { createArcifyConfig } from './vite-plugins/vite-plugin-arcify-extension.js';

import { storeBuildMode } from './scripts/fork/chrome-web-store-build.js';

export default defineConfig(({ mode }) => createArcifyConfig({
  isDev: false,
  isStore: mode === storeBuildMode,
}));