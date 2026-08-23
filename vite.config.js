import { defineConfig } from 'vite';
import legacy from '@vitejs/plugin-legacy';

export default defineConfig({
  plugins: [
    legacy({
      targets: ['chrome >= 38', 'android >= 5.0'],
      renderLegacyChunks: true,
    }),
  ],
});