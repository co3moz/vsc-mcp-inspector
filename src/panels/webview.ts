import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

export interface WebviewReadyEvent {
  title: string;
  /** Detail panels: whether the JSON editor bundle loaded. */
  editorLoaded?: boolean;
}

/** Fires once a webview's scripts have loaded and it asked for its data. */
export const webviewReady = new vscode.EventEmitter<WebviewReadyEvent>();

/** Folders webviews may load files from: hand-written assets and the bundled editor. */
export function webviewRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist', 'webview')];
}

/**
 * Builds the HTML shell for a webview: CSP, shared stylesheet and scripts. Script paths are relative
 * to the extension root; media/common.js is always loaded first.
 */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, scripts: string[]): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, file)).toString();
  const csp = [
    `default-src 'none'`,
    // CodeMirror injects its styles at runtime; they carry the nonce.
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data: https:`,
    `media-src data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="csp-nonce" content="${nonce}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('media/style.css')}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main id="app"></main>
  ${['media/common.js', ...scripts].map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n  ')}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
