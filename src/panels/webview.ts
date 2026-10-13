import { randomBytes } from 'crypto';
import * as vscode from 'vscode';

/** Fires with the panel title once a webview's scripts have loaded and it asked for its data. */
export const webviewReady = new vscode.EventEmitter<string>();

export function mediaRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media');
}

/** Builds the HTML shell for a webview: CSP, shared stylesheet and scripts from /media. */
export function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri, title: string, scripts: string[]): string {
  const nonce = randomBytes(16).toString('base64');
  const media = mediaRoot(extensionUri);
  const uri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(media, file)).toString();
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource}`,
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('style.css')}">
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <main id="app"></main>
  ${['common.js', ...scripts].map((s) => `<script nonce="${nonce}" src="${uri(s)}"></script>`).join('\n  ')}
</body>
</html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
