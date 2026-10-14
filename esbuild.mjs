import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  {
    // Extension host (Node).
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  },
  {
    // JSON editor for the webviews (browser).
    entryPoints: ['src/webview/jsonEditor.ts'],
    outfile: 'dist/webview/jsonEditor.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  },
];

if (watch) {
  for (const options of builds) {
    await (await esbuild.context(options)).watch();
  }
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}
