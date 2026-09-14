import { defineConfig } from 'vite';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'public',
  publicDir: '../static',
  // Match Vercel's page aliases while developing through its API proxy.
  plugins: [{
    name: 'camaze-page-aliases',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        if (req.url === '/') req.url = '/dashboard.html';
        else if (/^\/sim(?:\/|\?|$)/.test(req.url)) {
          req.url = req.url.replace(/^\/sim/, '') || '/dashboard.html';
          if (req.url === '/') req.url = '/dashboard.html';
        }
        next();
      });
    },
  }],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: Object.fromEntries(readdirSync('public').filter(f => f.endsWith('.html')).map(f => [f.replace('.html', ''), resolve('public', f)])),
    },
  },
});
