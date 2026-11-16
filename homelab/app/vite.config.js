import { defineConfig } from 'vite';
import pkg from './package.json' with { type: 'json' };

// Changes with every build; frames compare it with /build.json and reload after a deploy.
const BUILD_ID = Date.now().toString(36);

// CSS targets chrome61 on purpose (see upstream): a newer target lets the minifier rewrite
// transparent colours into 4/8-digit hex, which older tablet WebViews reject.
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(pkg.version.replace(/\.0$/, '')), __BUILD_ID__: JSON.stringify(BUILD_ID) },
  plugins: [{
    name: 'build-json',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: BUILD_ID, version: pkg.version }) }); },
  }],
  build: { target: 'chrome106', cssTarget: 'chrome61', rollupOptions: { input: { main: 'index.html', shop: 'shop.html' } } },
});
