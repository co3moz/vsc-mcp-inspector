// Bundles test/core.test.ts (no VS Code dependency) and runs it with the Node test runner.
import { spawnSync } from 'node:child_process';
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['test/core.test.ts'],
  outfile: 'out/test/core.test.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: 'inline',
  logLevel: 'warning',
});

const result = spawnSync(process.execPath, ['--enable-source-maps', '--test', '--test-reporter=spec', '--test-timeout=30000', 'out/test/core.test.cjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
