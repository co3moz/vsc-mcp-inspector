# Contributing

Notes for developing, testing and releasing the extension. User documentation is in [README.md](README.md).

## Development

```bash
npm install
npm run build          # bundle to dist/ (extension + webview editor)
npm run watch          # rebuild on change
npm run check          # type-check
```

Press <kbd>F5</kbd> to start an Extension Development Host.

`test/server.mjs` is a small MCP server for trying out the inspector. It has tools with many parameter types, structured output, images, progress, errors, prompts, resources and a resource template:

```bash
npm run test-server                         # Streamable HTTP on :3001/mcp, SSE on :3001/sse
REQUIRE_TOKEN=secret npm run test-server    # also require "Authorization: Bearer secret"
node test/server.mjs stdio                  # stdio
```

Tests:

```bash
npm run test:core          # unit tests + McpSession against the test server over all three transports
npm run test:integration   # inside VS Code (set VSCODE_EXECUTABLE to use an installed VS Code)
```

Packaging: `npm run package` creates a `.vsix`.

## CI and releases

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs on every push and pull request: it type-checks, runs the core tests, runs the integration tests inside VS Code 1.90.0 (the oldest supported version) and the current stable release, and packages the extension. The `.vsix` is attached to the workflow run as an artifact named `vsc-mcp-inspector-<version>-<commit>.vsix` (**Actions** → run → **Artifacts**).

To publish a release, bump `version` in `package.json`, commit, then push a matching tag:

```bash
git tag v<version>
```

```bash
git push origin v<version>
```

The workflow checks that the tag matches `package.json`, builds `vsc-mcp-inspector-<version>.vsix` and, once all tests pass, attaches it to a GitHub release with generated notes and publishes it to the Visual Studio Marketplace and Open VSX.

### Marketplace publishing setup

The `marketplace` job only runs for `v*` tags, after the build and integration tests pass, in the `marketplace` GitHub environment. The first publish creates the extension; no manual upload is needed. Re-running it for a version that is already published is a no-op (`--skip-duplicate`). It authenticates with the first of these that is configured:

**Microsoft Entra ID (recommended, no stored secret)**

1. In the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration** (for example `vsc-mcp-inspector-publisher`, single tenant). No Azure subscription is needed.
2. In the app → **Certificates & secrets** → **Federated credentials** → **Add credential** → *GitHub Actions deploying Azure resources*: organization `co3moz`, repository `vsc-mcp-inspector`, entity type **Environment**, environment `marketplace`.
3. In the GitHub repository → **Settings** → **Secrets and variables** → **Actions** → **Variables**, add `AZURE_CLIENT_ID` (the app's *Application (client) ID*) and `AZURE_TENANT_ID` (*Directory (tenant) ID*).
4. Push a tag. The **Show the Marketplace identity** step prints the app's Marketplace identity ID. The first publish fails until you add that ID under **Members** of the publisher at <https://marketplace.visualstudio.com/manage/publishers/co3moz> with the **Contributor** role; then re-run the job.

**Personal Access Token (quick start)**

Create an Azure DevOps PAT with organization *All accessible organizations* and scope **Marketplace → Manage**, and store it as the `VSCE_PAT` repository secret. Azure DevOps retires these global PATs on 2026-12-01, so switch to Entra ID before then.

Marketplace [trusted publishing](https://github.com/microsoft/vscode-vsce#trusted-publishing) (`vsce publish --oidc`) is supported by `vsce` but not yet enabled on the Marketplace; the workflow can switch to it once it is.

### Open VSX publishing setup

The `openvsx` job runs alongside the `marketplace` job and publishes the same VSIX to [open-vsx.org](https://open-vsx.org). One-time setup:

1. Create an [Eclipse account](https://accounts.eclipse.org/user/register) and fill in its *GitHub Username* with the account you will use on Open VSX.
2. Sign in to [open-vsx.org](https://open-vsx.org) with GitHub. On your profile page click **Log in with Eclipse**, then **Show Publisher Agreement** → **Agree**.
3. Create a token under **Settings** → [**Access Tokens**](https://open-vsx.org/user-settings/tokens) and store it as the `OVSX_PAT` repository secret.

The first publish creates the `co3moz` namespace. To get the "verified" badge, [claim the namespace](https://github.com/eclipse-openvsx/openvsx/wiki/Namespace-Access). After the first version is out you can also switch to [trusted publishing](https://github.com/eclipse-openvsx/openvsx/wiki/Trusted-Publishing): register this repository and the workflow `build.yml` (environment `openvsx`) under **Settings** → **Trusted Publishers**, then delete the `OVSX_PAT` secret. The job already has `id-token: write` and `ovsx` uses OIDC whenever no token is set.
