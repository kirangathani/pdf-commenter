import esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

// The mock loads the pdfjs worker as a plain file (no blob URL needed outside Obsidian).
fs.copyFileSync(
    path.join(repo, 'node_modules/pdfjs-dist/build/pdf.worker.js'),
    path.join(here, 'pdf.worker.js'),
);

const ctx = await esbuild.context({
    entryPoints: [path.join(here, 'mock-main.ts')],
    bundle: true,
    format: 'iife',
    target: 'es2018',
    outfile: path.join(here, 'mock.js'),
    sourcemap: 'inline',
    logLevel: 'info',
});

if (process.argv.includes('watch')) {
    await ctx.watch();
} else {
    await ctx.rebuild();
    await ctx.dispose();
}
