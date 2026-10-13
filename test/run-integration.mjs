// Builds the extension and the integration suite, then runs it inside VS Code.
// Uses an installed VS Code when VSCODE_EXECUTABLE is set, otherwise downloads one into .vscode-test.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const root = resolve('.');
await esbuild.build({ entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', bundle: true, format: 'cjs', platform: 'node', target: 'node20', external: ['vscode'], sourcemap: true, logLevel: 'warning' });
await esbuild.build({ entryPoints: ['test/integration/suite.ts'], outfile: 'out/test/integration/suite.js', bundle: true, format: 'cjs', platform: 'node', target: 'node20', external: ['vscode'], sourcemap: 'inline', logLevel: 'warning' });

const userDataDir = mkdtempSync(join(tmpdir(), 'mcp-inspector-it-'));
try {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    extensionDevelopmentPath: root,
    extensionTestsPath: join(root, 'out', 'test', 'integration', 'suite.js'),
    extensionTestsEnv: { INSPECTOR_TEST_NODE: process.execPath },
    launchArgs: ['--disable-extensions', '--user-data-dir', userDataDir, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust'],
  });
} catch (err) {
  console.error('Integration tests failed:', err);
  process.exit(1);
}
