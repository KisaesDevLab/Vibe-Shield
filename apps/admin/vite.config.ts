import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Production builds bake `/__VIBE_BASE_PATH__/` as the asset base. The
// nginx image's /docker-entrypoint.d/40-base-path.sh sed-substitutes
// that sentinel with the runtime $VITE_BASE_PATH value at container
// start, so a single image works at any mount point:
//   - Vibe-Appliance path-prefix mode    → VITE_BASE_PATH=/shield/
//   - Dedicated subdomain (domain mode)  → VITE_BASE_PATH=/
//   - Custom standalone mount            → whatever the operator sets
// Dev (`vite dev`) keeps base='/' so the dev URL stays clean and the
// proxy below routes /v1/* to the local gateway without prefix mangling.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/__VIBE_BASE_PATH__/' : '/',
  plugins: [react()],
  server: {
    port: 5173,
    // Forward /v1/admin/* to the gateway during local dev.
    proxy: {
      '/v1': {
        target: process.env.VITE_GATEWAY_URL ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
}));
