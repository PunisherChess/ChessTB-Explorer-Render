import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const dropHtml = {
    name: 'drop-html-output',
    enforce: 'post',
    generateBundle(_, bundle) {
        for (const name of Object.keys(bundle)) {
            if (name.endsWith('.html')) delete bundle[name];
        }
    },
};

export default defineConfig({
    plugins: [react(), dropHtml],
    base: '/static/dist/',
    build: {
        outDir: '../static/dist',
        emptyOutDir: true,
        rollupOptions: {
            input: { app: 'index.html', admin: 'admin.html' },
            output: {
                entryFileNames: '[name].js',
                chunkFileNames: 'app-[name].js',
                assetFileNames: ({ name }) => (/\.woff2?$/.test(name ?? '') ? 'fonts/[name][extname]' : '[name][extname]'),
            },
        },
    },
});
