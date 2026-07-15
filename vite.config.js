import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        port: 5173,
        open: true,
        watch: {
            /**
             * Don't watch root-level docs/spec markdown. They aren't imported by the
             * app, and on Windows an editor holding one open makes chokidar throw
             * `EBUSY: resource busy or locked`, which crashes the whole dev server.
             */
            ignored: ['**/*.md', '**/*-spec.md'],
        },
    },
    build: {
        rollupOptions: {
            output: {
                /**
                 * Split rarely-changing third-party libraries into stable, separately
                 * cacheable vendor chunks. Application/route code is NOT force-chunked
                 * here — it splits naturally via the route-level React.lazy() imports.
                 * Kept intentionally coarse to avoid over-fragmentation.
                 */
                manualChunks: function (id) {
                    var nid = id.replace(/\\/g, '/');
                    if (!nid.includes('/node_modules/'))
                        return undefined;
                    if (nid.includes('/node_modules/lucide-react/'))
                        return 'icons';
                    // zod is used at store init (validation) → keep it separate from the
                    // form library, which is only pulled in by the lazy entry drawers.
                    if (nid.includes('/node_modules/zod/'))
                        return 'validation';
                    if (nid.includes('/node_modules/react-hook-form/') ||
                        nid.includes('/node_modules/@hookform/')) {
                        return 'forms';
                    }
                    if (nid.includes('/node_modules/zustand/'))
                        return 'state';
                    if (nid.includes('/node_modules/react-dom/') ||
                        nid.includes('/node_modules/react/') ||
                        nid.includes('/node_modules/scheduler/')) {
                        return 'react-vendor';
                    }
                    return 'vendor';
                },
            },
        },
    },
});
