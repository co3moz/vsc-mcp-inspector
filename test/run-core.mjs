// Bundles the Node-only test suites (no VS Code dependency) and runs them with the Node test runner.
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

const suites = ['core', 'schema'];

await esbuild.build({
  entryPoints: suites.map((name) => `test/${name}.test.ts`),
  outdir: 'out/test',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
});

const files = suites.map((name) => `out/test/${name}.test.cjs`);
const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-reporter=spec', '--test-timeout=30000', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
