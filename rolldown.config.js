import { defineConfig } from 'rolldown';

export default defineConfig({
    input: {
        index: 'src/index.ts',
        cli: 'src/cli.ts'
    },
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
        'url',
        'process',

        // NPM dependencies
        'node-cron',
        'axios',
        'dotenv',
        'winston',
        'commander'
    ],
    resolve: {
        extensions: ['.ts', '.js']
    },
    // Configuration pour ES modules
    platform: 'node',
    target: 'es2022'
});