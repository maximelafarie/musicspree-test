import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { join } from 'path';

const packageJson = JSON.parse(
    readFileSync(join(process.cwd(), 'package.json'), 'utf8')
);

// Configuration commune
const commonConfig = {
    bundle: true,
    platform: 'node',
    target: 'es2022',
    format: 'esm',
    sourcemap: true,
    minify: process.env.NODE_ENV === 'production',
    // Externaliser les dépendances npm pour éviter de les bundler
    external: Object.keys(packageJson.dependencies || {}),
    // Configuration pour les modules ES
    banner: {
        js: `// MusicSpree v${packageJson.version}
// Generated at ${new Date().toISOString()}`
    },
    logLevel: 'info'
};

async function buildAll() {
    try {
        console.log('🔨 Building MusicSpree...');

        // Build principal
        await build({
            ...commonConfig,
            entryPoints: ['src/index.ts'],
            outfile: 'dist/index.js'
        });

        // Build CLI
        await build({
            ...commonConfig,
            entryPoints: ['src/cli.ts'],
            outfile: 'dist/cli.js'
        });

        console.log('✅ Build completed successfully!');

    } catch (error) {
        console.error('❌ Build failed:', error);
        process.exit(1);
    }
}

// Support du watch mode
if (process.argv.includes('--watch')) {
    console.log('👀 Starting watch mode...');

    const ctx1 = await build({
        ...commonConfig,
        entryPoints: ['src/index.ts'],
        outfile: 'dist/index.js'
    });

    const ctx2 = await build({
        ...commonConfig,
        entryPoints: ['src/cli.ts'],
        outfile: 'dist/cli.js'
    });

    await ctx1.watch();
    await ctx2.watch();

    console.log('📂 Watching for changes...');
} else {
    buildAll();
}