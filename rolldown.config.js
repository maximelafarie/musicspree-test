import { defineConfig } from 'rolldown';

export default defineConfig({
    input: 'src/index.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: true
    },
    external: [
        // Node.js built-in modules
        'crypto',
        'util',
        'fs',
        'path',
        'child_process',

        // NPM dependencies
        'node-cron',
        'axios',
        'dotenv',
        'winston',
        'commander'
    ],
    resolve: {
        extensions: ['.ts', '.js']
    }
});