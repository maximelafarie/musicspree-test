import { defineConfig } from 'rolldown';

export default defineConfig({
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'cjs',
        sourcemap: true
    },
    external: [
        'node-cron',
        'axios',
        'dotenv',
        'winston',
        'commander',
        'fs',
        'path',
        'child_process'
    ],
    resolve: {
        extensions: ['.ts', '.js']
    }
});