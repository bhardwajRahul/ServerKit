import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'url'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')
    const frontendPort = Number(env.SERVERKIT_FRONTEND_PORT) || 41921
    const apiTarget = (env.VITE_API_URL || 'http://localhost:47927/api/v1').replace(/\/api\/v1\/?$/, '')

    return {
        plugins: [react(), tailwindcss()],
        resolve: {
            alias: {
                '@': fileURLToPath(new URL('./src', import.meta.url)),
                // Stable import path for plugin code:
                //   import { api, useAuth } from 'serverkit-sdk';
                // Internal restructures of src/plugins/sdk are invisible
                // to plugins as long as the named exports stay stable.
                'serverkit-sdk': fileURLToPath(new URL('./src/plugins/sdk/index.js', import.meta.url)),
            },
        },
        server: {
            port: frontendPort,
            proxy: {
                '/api': {
                    target: apiTarget,
                    changeOrigin: true,
                },
                '/socket.io': {
                    target: apiTarget,
                    changeOrigin: true,
                    ws: true,
                },
            },
            // Enable polling for WSL (Windows filesystem doesn't support inotify)
            watch: {
                usePolling: true,
                interval: 1000,
            },
        },
        css: {
            preprocessorOptions: {
                scss: {
                    // Silence Dart Sass deprecation warnings for @import and slash-div
                    // These are expected during migration from LESS and will be addressed
                    // when moving to @use/@forward module system
                    silenceDeprecations: ['import', 'slash-div', 'legacy-js-api', 'global-builtin', 'color-functions', 'strict-unary'],
                },
            },
        },
        build: {
            sourcemap: false,
            rollupOptions: {
                output: {
                    manualChunks: {
                        'vendor-react': ['react', 'react-dom', 'react-router-dom'],
                        'vendor-charts': ['recharts'],
                        'vendor-flow': ['@xyflow/react'],
                        'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
                        'vendor-icons': ['lucide-react'],
                    },
                },
            },
        },
    }
})
