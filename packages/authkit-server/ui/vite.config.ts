import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The base will be rewritten at serving time from /__AUTHKIT_BASE__/ to the actual adminBase.
// We use a placeholder so all asset URLs are root-relative and can be rewritten by the shell controller.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/__AUTHKIT_BASE__/',
  // The shell controller rewrites the base placeholder in index.html only. URLs inside the CSS
  // (the bundled Sora / JetBrains Mono files) are emitted relative to the stylesheet instead, so
  // they resolve under whatever admin prefix serves the assets.
  experimental: {
    renderBuiltUrl(_filename, { hostType }) {
      return hostType === 'css' ? { relative: true } : undefined;
    },
  },
  build: {
    // tsconfig do server tem rootDir './', então admin_shell_controller.ts compila
    // para build/src/host/admin_console/ — seu `../../host/ui-dist` resolve para
    // build/src/host/ui-dist. O dist do Vite PRECISA cair aí (não em build/host/ui-dist),
    // senão o serving cai no fallback "Build Required". Ver admin_shell_controller.ts.
    outDir: resolve(__dirname, '../build/src/host/ui-dist'),
    emptyOutDir: true,
  },
});
