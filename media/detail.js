// @ts-check
/* Tool / prompt / resource detail page with invocation. Depends on common.js and schemaForm.js. */

const KIND_LABELS = { tool: 'Tool', prompt: 'Prompt', resource: 'Resource', template: 'Resource Template' };

/** @type {any} */
let model = null;
/** @type {ReturnType<typeof createSchemaForm> | null} */
let form = null;
/** @type {'form' | 'json'} */
let mode = 'form';
/** @type {{ runId: string, started: number, timer: number } | null} */
let running = null;
/** Set by renderParams: shows validation errors above the run button. */
let showParamErrors = (/** @type {string[]} */ _list) => {};
/** Set by renderParams: returns the JSON editor text. */
let readJsonText = () => '{}';
/** Set by renderParams: releases the form and JSON editors before re-rendering. */
let disposeParams = () => {};
/** Read-only JSON viewers per section, destroyed when the section re-renders. */
const viewers = { response: /** @type {any[]} */ ([]), schema: /** @type {any[]} */ ([]) };
/** Pending schema validations, answered by the extension host. */
const pendingValidations = new Map();

/**
 * Validates `text` against `schema` in the extension host (Ajv needs code generation, which the
 * webview CSP does not allow).
 * @param {string} text @param {any} schema @returns {Promise<any[]>}
 */
function validateWithHost(text, schema) {
  return new Promise((resolve) => {
    const requestId = uid('v');
    pendingValidations.set(requestId, resolve);
    vscode.postMessage({ type: 'validate', requestId, schema, text });
    setTimeout(() => pendingValidations.delete(requestId) && resolve([]), 5000);
  });
}

/** @param {any[]} list */
function destroyViewers(list) {
  list.splice(0).forEach((view) => view.destroy());
}

const app = /** @type {HTMLElement} */ (document.getElementById('app'));

const els = {
  header: h('div', { class: 'header' }),
  params: h('section'),
  response: h('section', { class: 'hidden', 'aria-live': 'polite' }),
  schema: h('section'),
};

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init':
      model = msg;
      mode = 'form';
      setChildren(app, els.header, els.params, els.response, els.schema);
      renderHeader();
      renderParams(msg.lastArgs);
      renderSchema();
      requestAnimationFrame(() => (msg.autoRun ? run() : form?.focus()));
      break;
    case 'invoke':
      if (msg.args) {
        mode = 'form';
        renderParams(msg.args);
      }
      if (msg.run) {
        run();
      }
      break;
    case 'definition': {
      const current = currentArgs(true);
      model.definition = msg.definition;
      renderHeader();
      renderParams(current ?? undefined);
      renderSchema();
      break;
    }
    case 'connection':
      model.connection = msg.connection;
      renderHeader();
      break;
    case 'progress':
      if (running?.runId === msg.runId) {
        renderProgress(msg);
      }
      break;
    case 'result':
      if (running?.runId === msg.runId) {
        finishRun(msg);
      }
      break;
    case 'validation': {
      const resolve = pendingValidations.get(msg.requestId);
      pendingValidations.delete(msg.requestId);
      resolve?.(msg.issues);
      break;
    }
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    run();
  } else if (event.key === 'Escape' && running) {
    cancel();
  }
});

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function renderHeader() {
  const def = model.definition || {};
  const conn = model.connection;
  const name = model.kind === 'resource' || model.kind === 'template' ? def.name || model.key : model.key;
  const title = def.title || def.annotations?.title;

  /** @type {any[]} */
  const badges = [];
  const ann = def.annotations || {};
  if (model.kind === 'tool') {
    if (ann.readOnlyHint === true) badges.push(h('span', { class: 'badge outline', title: 'readOnlyHint' }, 'read-only'));
    if (ann.destructiveHint === true && ann.readOnlyHint !== true) badges.push(h('span', { class: 'badge warn', title: 'destructiveHint' }, 'destructive'));
    if (ann.idempotentHint === true) badges.push(h('span', { class: 'badge outline', title: 'idempotentHint' }, 'idempotent'));
    if (ann.openWorldHint === true) badges.push(h('span', { class: 'badge outline', title: 'openWorldHint' }, 'open world'));
    if (def.outputSchema) badges.push(h('span', { class: 'badge outline' }, 'structured output'));
  }
  if (def.mimeType) badges.push(h('span', { class: 'badge outline' }, def.mimeType));
  if (typeof def.size === 'number') badges.push(h('span', { class: 'badge outline' }, formatBytes(def.size)));

  setChildren(els.header,
    h('div', { class: 'row' },
      h('span', { class: 'badge' }, KIND_LABELS[/** @type {keyof typeof KIND_LABELS} */ (model.kind)]),
      h('span', { class: 'spacer' }),
      h('span', { class: 'connection-chip', title: conn.server ? `Server: ${conn.server}` : '' },
        h('span', { class: `dot ${conn.status}` }), `${conn.name} · ${conn.transport} · ${conn.status}`)),
    h('h1', null, name),
    title && title !== name ? h('p', { class: 'muted' }, title) : null,
    model.kind === 'resource' ? h('code', null, model.key) : null,
    model.kind === 'template' ? h('code', null, model.key) : null,
    badges.length ? h('div', { class: 'row' }, badges) : null,
    def.description ? h('p', { class: 'description' }, def.description) : null,
    !model.definition ? h('div', { class: 'callout err' }, 'This item is no longer offered by the server. Refresh the connection to update the list.') : null,
  );
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Input schema for the current item, synthesized for prompts and templates. */
function inputSchema() {
  const def = model.definition || {};
  switch (model.kind) {
    case 'tool':
      return def.inputSchema || { type: 'object' };
    case 'prompt': {
      const args = def.arguments || [];
      return {
        type: 'object',
        properties: Object.fromEntries(args.map((/** @type {any} */ a) => [a.name, { type: 'string', title: a.title, description: a.description }])),
        required: args.filter((/** @type {any} */ a) => a.required).map((/** @type {any} */ a) => a.name),
        additionalProperties: false,
      };
    }
    case 'template':
      return {
        type: 'object',
        properties: Object.fromEntries(templateVariables(model.key).map((v) => [v, { type: 'string' }])),
        required: templateVariables(model.key),
        additionalProperties: false,
      };
    default:
      return { type: 'object', properties: {}, additionalProperties: false };
  }
}

/** @param {string} template */
function templateVariables(template) {
  const names = new Set();
  for (const match of template.matchAll(/\{[+#./;?&]?([^}]+)\}/g)) {
    for (const part of match[1].split(',')) {
      names.add(part.replace(/\*$/, '').replace(/:\d+$/, '').trim());
    }
  }
  return [...names].filter(Boolean);
}

/** @param {Record<string, any>} [initial] */
function renderParams(initial) {
  disposeParams();
  const schema = inputSchema();
  form = createSchemaForm(schema, initial, { validate: validateWithHost, onSubmit: () => run() });
  if (form.jsonOnly) {
    mode = 'json';
  } else if (!form.hasFields) {
    mode = 'form';
  }
  const heading = model.kind === 'template' ? 'URI Variables' : model.kind === 'tool' ? 'Parameters' : 'Arguments';
  const showParams = model.kind !== 'resource';

  // The JSON editor is created the first time JSON mode is shown.
  const jsonHost = h('div', { class: 'json-host' });
  /** @type {any} */
  let jsonEditor = null;
  let jsonText = prettyJson(initial || {});
  const getJson = () => (jsonEditor ? jsonEditor.getValue() : jsonText);
  const setJson = (/** @type {string} */ text) => {
    jsonText = text;
    jsonEditor?.setValue(text);
  };
  const ensureJsonEditor = () => {
    jsonEditor ??= createEditor(jsonHost, {
      value: jsonText,
      schema,
      validate: validateWithHost,
      onSubmit: () => run(),
      ariaLabel: 'Arguments as JSON',
      placeholder: '{ }',
      minHeight: '140px',
      maxHeight: '560px',
    });
    return jsonEditor;
  };
  const errors = h('div', { class: 'callout err hidden', role: 'alert' });

  const toggle = h('div', { class: 'segmented', role: 'tablist' },
    h('button', { type: 'button', 'aria-pressed': String(mode === 'form'), onclick: () => switchMode('form') }, 'Form'),
    h('button', { type: 'button', 'aria-pressed': String(mode === 'json'), onclick: () => switchMode('json') }, 'JSON'));

  /** @param {'form' | 'json'} next */
  function switchMode(next) {
    if (next === mode) {
      return;
    }
    if (next === 'json') {
      setJson(prettyJson(form?.read().value ?? {}));
    } else {
      try {
        const value = JSON.parse(getJson() || '{}');
        if (!isPlainObject(value)) {
          throw new Error('Arguments must be a JSON object.');
        }
        form?.write(value);
      } catch (err) {
        showErrors([`Cannot switch to the form: ${/** @type {Error} */ (err).message}`]);
        return;
      }
    }
    mode = next;
    showErrors([]);
    renderBody();
  }

  const body = h('div', { class: 'stack' });
  function renderBody() {
    toggle.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (mode === 'form'))));
    if (mode === 'json') {
      setChildren(body, jsonHost,
        h('span', { class: 'hint' }, 'Sent as the "arguments" object of the request. ', h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'Space'), ' suggests properties and values from the schema.'));
      requestAnimationFrame(() => ensureJsonEditor().focus());
    } else if (form?.hasFields) {
      setChildren(body, /** @type {HTMLElement} */ (form.element));
    } else {
      setChildren(body, h('p', { class: 'empty-state' }, model.kind === 'tool' ? 'This tool takes no parameters.' : 'No arguments.'));
    }
  }
  renderBody();

  const runButton = h('button', { type: 'button', id: 'run', onclick: run, disabled: !model.definition, title: 'Ctrl+Enter' }, '▶ ', model.runLabel);
  const cancelButton = h('button', { type: 'button', id: 'cancel', class: 'secondary hidden', onclick: cancel, title: 'Esc' }, 'Cancel');
  const resetButton = h('button', {
    type: 'button',
    class: 'ghost',
    onclick: () => {
      form?.write({});
      setJson('{}');
      showErrors([]);
    },
  }, 'Clear');

  setChildren(els.params,
    showParams
      ? h('div', { class: 'section-head' }, h('h2', null, heading), h('span', { class: 'spacer' }), form.hasFields || model.kind === 'tool' ? toggle : null)
      : null,
    showParams ? body : null,
    errors,
    h('div', { class: 'actions' }, runButton, cancelButton, showParams ? resetButton : null, h('span', { class: 'spacer' }),
      h('span', { class: 'hint' }, h('span', { class: 'kbd' }, 'Ctrl'), ' + ', h('span', { class: 'kbd' }, 'Enter'), ' to run')),
  );

  /** @param {string[]} list */
  function showErrors(list) {
    setChildren(errors, ...(list.length ? [h('div', { class: 'callout-title' }, 'Please fix the following'), h('div', null, list.map((e) => h('div', null, e)))] : []));
    errors.classList.toggle('hidden', !list.length);
  }

  showParamErrors = showErrors;
  readJsonText = getJson;
  disposeParams = () => {
    form?.dispose();
    jsonEditor?.destroy();
  };
}

/**
 * Reads the arguments from the active editor.
 * @param {boolean} [lenient] ignore validation errors (used when re-rendering)
 * @returns {Record<string, any> | null}
 */
function currentArgs(lenient = false) {
  if (!form) {
    return {};
  }
  if (mode === 'json') {
    try {
      const value = JSON.parse(readJsonText() || '{}');
      if (!isPlainObject(value)) {
        throw new Error('Arguments must be a JSON object.');
      }
      return value;
    } catch (err) {
      if (!lenient) {
        showParamErrors([`Invalid JSON: ${/** @type {Error} */ (err).message}`]);
      }
      return null;
    }
  }
  const { value, errors } = form.read();
  if (errors.length && !lenient) {
    showParamErrors(errors);
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

function run() {
  if (running || !model?.definition) {
    return;
  }
  const args = model.kind === 'resource' ? {} : currentArgs();
  if (!args) {
    return;
  }
  showParamErrors([]);
  destroyViewers(viewers.response);
  const runId = uid('run');
  const started = Date.now();
  running = { runId, started, timer: 0 };
  setRunning(true);

  els.response.classList.remove('hidden');
  const elapsed = h('span', { class: 'muted' }, '0.0 s');
  running.timer = window.setInterval(() => {
    elapsed.textContent = `${((Date.now() - started) / 1000).toFixed(1)} s`;
  }, 100);
  setChildren(els.response,
    h('div', { class: 'section-head' }, h('h2', null, 'Response'), h('span', { class: 'spacer' }),
      h('span', { class: 'row' }, h('span', { class: 'spinner' }), model.connection.status === 'connected' ? 'Running…' : 'Connecting…', elapsed)),
    h('div', { class: 'progress hidden', id: 'progress' }, h('div', { class: 'progress-track' }, h('div', { class: 'progress-bar' })), h('span', { class: 'hint' })),
  );
  vscode.postMessage({ type: 'run', runId, args });
}

function cancel() {
  if (running) {
    vscode.postMessage({ type: 'cancel', runId: running.runId });
  }
}

/** @param {boolean} value */
function setRunning(value) {
  const runButton = /** @type {HTMLButtonElement | null} */ (document.getElementById('run'));
  const cancelButton = document.getElementById('cancel');
  if (runButton) runButton.disabled = value || !model.definition;
  cancelButton?.classList.toggle('hidden', !value);
}

/** @param {{ progress: number, total?: number, message?: string }} p */
function renderProgress(p) {
  const container = document.getElementById('progress');
  if (!container) {
    return;
  }
  container.classList.remove('hidden');
  const bar = /** @type {HTMLElement} */ (container.querySelector('.progress-bar'));
  const label = /** @type {HTMLElement} */ (container.querySelector('.hint'));
  const percent = p.total ? Math.min(100, (p.progress / p.total) * 100) : null;
  bar.style.width = percent === null ? '100%' : `${percent}%`;
  label.textContent = [p.total ? `${p.progress} / ${p.total}` : `${p.progress}`, p.message].filter(Boolean).join(' — ');
}

/** @param {any} msg */
function finishRun(msg) {
  if (running) {
    clearInterval(running.timer);
  }
  running = null;
  setRunning(false);

  const isToolError = msg.ok && model.kind === 'tool' && msg.result?.isError === true;
  const status = !msg.ok
    ? h('span', { class: 'badge err' }, '✗ Failed')
    : isToolError
      ? h('span', { class: 'badge warn' }, '⚠ Tool error')
      : h('span', { class: 'badge ok' }, '✓ Success');

  /** @type {any[]} */
  let body;
  if (!msg.ok) {
    body = [h('div', { class: 'callout err', role: 'alert' }, h('div', { class: 'callout-title' }, 'Request failed'), h('pre', null, msg.error))];
  } else if (model.kind === 'tool') {
    body = renderToolResult(msg.result);
  } else if (model.kind === 'prompt') {
    body = renderPromptResult(msg.result);
  } else {
    body = renderResourceResult(msg.result);
  }

  setChildren(els.response,
    h('div', { class: 'section-head' }, h('h2', null, 'Response'), h('span', { class: 'spacer' }),
      h('span', { class: 'result-meta' }, status, h('span', { class: 'muted' }, formatDuration(msg.durationMs)), h('span', { class: 'muted' }, new Date().toLocaleTimeString()))),
    msg.uri ? h('div', { class: 'hint' }, 'URI: ', h('code', null, msg.uri)) : null,
    body,
    msg.ok
      ? jsonDetails('Raw result', msg.result, viewers.response, {
        hint: 'The whole "result" object of the JSON-RPC response, as sent by the server. Long strings are shortened here; Copy and Open in Editor use the full text.',
        truncate: true,
      })
      : null,
  );
}

// ---------------------------------------------------------------------------
// Result renderers
// ---------------------------------------------------------------------------

/** @param {any} result */
function renderToolResult(result) {
  const out = [];
  if (result.isError) {
    out.push(h('div', { class: 'callout err' }, 'The tool reported an error (isError: true).'));
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const structured = result.structuredContent;
  content.forEach((block, i) => {
    const label = content.length > 1 ? `#${i + 1}` : '';
    // Tools with an output schema usually repeat structuredContent as JSON text for older clients.
    if (structured !== undefined && block?.type === 'text' && sameJson(block.text, structured)) {
      out.push(h('details', { class: 'content-block duplicate' },
        h('summary', null, h('span', { class: 'badge outline' }, 'text'), label ? ` ${label}` : '', h('span', { class: 'muted' }, ' — same JSON as structuredContent')),
        h('div', { class: 'details-body' }, h('pre', null, block.text))));
      return;
    }
    out.push(renderContentBlock(block, label));
  });
  if (structured !== undefined) {
    const json = prettyJson(structured);
    out.push(h('div', { class: 'content-block' },
      h('div', { class: 'content-block-head' },
        h('span', { class: 'badge outline' }, 'structuredContent'),
        h('span', { class: 'muted' }, 'machine-readable result'),
        h('span', { class: 'spacer' }), copyButton(json), openButton(json, 'json')),
      jsonViewer(json, viewers.response)));
  }
  if (!content.length && result.structuredContent === undefined) {
    out.push(h('p', { class: 'empty-state' }, 'The tool returned no content.'));
  }
  return out;
}

/** @param {any} result */
function renderPromptResult(result) {
  const out = [];
  if (result.description) {
    out.push(h('p', { class: 'description muted' }, result.description));
  }
  for (const message of result.messages || []) {
    out.push(h('div', { class: 'message' }, renderContentBlock(message.content, '', h('span', { class: 'badge' }, message.role))));
  }
  if (!(result.messages || []).length) {
    out.push(h('p', { class: 'empty-state' }, 'The prompt returned no messages.'));
  }
  return out;
}

/** @param {any} result */
function renderResourceResult(result) {
  const contents = result.contents || [];
  if (!contents.length) {
    return [h('p', { class: 'empty-state' }, 'The resource has no contents.')];
  }
  return contents.map((/** @type {any} */ c) => h('div', { class: 'content-block' }, resourceContents(c)));
}

/**
 * @param {any} block MCP ContentBlock
 * @param {string} label
 * @param {HTMLElement} [prefix]
 */
function renderContentBlock(block, label, prefix) {
  const type = block?.type ?? 'unknown';
  const head = (/** @type {any[]} */ ...extra) =>
    h('div', { class: 'content-block-head' }, prefix, h('span', { class: 'badge outline' }, type), label ? h('span', null, label) : null, ...extra);

  switch (type) {
    case 'text': {
      const json = asJson(block.text ?? '');
      return h('div', { class: 'content-block' },
        head(json !== null ? h('span', { class: 'muted' }, 'JSON') : null, h('span', { class: 'spacer' }), copyButton(block.text ?? ''), json !== null ? openButton(json, 'json') : null),
        json !== null ? jsonViewer(json, viewers.response) : h('pre', null, block.text ?? ''));
    }
    case 'image':
      return h('div', { class: 'content-block' }, head(h('span', null, block.mimeType)), mediaElement('img', block.mimeType, block.data));
    case 'audio':
      return h('div', { class: 'content-block' }, head(h('span', null, block.mimeType)), mediaElement('audio', block.mimeType, block.data));
    case 'resource':
      return h('div', { class: 'content-block' }, head(), resourceContents(block.resource || {}));
    case 'resource_link':
      return h('div', { class: 'content-block' }, head(),
        h('dl', { class: 'kv-grid' },
          h('dt', null, 'Name'), h('dd', null, block.title || block.name || '—'),
          h('dt', null, 'URI'), h('dd', null, h('code', null, block.uri)),
          block.mimeType ? [h('dt', null, 'MIME type'), h('dd', null, block.mimeType)] : null,
          block.description ? [h('dt', null, 'Description'), h('dd', null, block.description)] : null));
    default:
      return h('div', { class: 'content-block' }, head(), h('pre', null, prettyJson(block)));
  }
}

/** @param {any} c TextResourceContents | BlobResourceContents */
function resourceContents(c) {
  const head = h('div', { class: 'content-block-head' }, h('code', null, c.uri || ''), c.mimeType ? h('span', { class: 'badge outline' }, c.mimeType) : null, h('span', { class: 'spacer' }),
    typeof c.text === 'string' ? copyButton(c.text) : null,
    typeof c.text === 'string' ? openButton(c.text, languageFor(c.mimeType, c.uri)) : null);
  if (typeof c.text === 'string') {
    const json = asJson(c.text);
    return [head, json !== null ? jsonViewer(json, viewers.response) : h('pre', null, c.text)];
  }
  if (typeof c.blob === 'string') {
    const mime = c.mimeType || '';
    if (mime.startsWith('image/')) return [head, mediaElement('img', mime, c.blob)];
    if (mime.startsWith('audio/')) return [head, mediaElement('audio', mime, c.blob)];
    return [head, h('p', { class: 'muted' }, `Binary content, ${formatBytes(Math.floor((c.blob.length * 3) / 4))} (base64).`), h('div', { class: 'actions' }, copyButton(c.blob, 'Copy base64'))];
  }
  return [head, h('pre', null, prettyJson(c))];
}

/** @param {'img' | 'audio'} tag @param {string} mime @param {string} data */
function mediaElement(tag, mime, data) {
  const safeMime = /^[\w.+-]+\/[\w.+-]+$/.test(mime || '') ? mime : 'application/octet-stream';
  const safeData = /^[A-Za-z0-9+/=\s]*$/.test(data || '') ? data : '';
  const src = `data:${safeMime};base64,${safeData}`;
  return tag === 'img' ? h('img', { src, alt: 'Image returned by the server' }) : h('audio', { src, controls: true });
}

/**
 * Collapsible read-only JSON viewer; the editor is created when it is first opened.
 * @param {string} title @param {unknown} value @param {any[]} registry
 * @param {{ hint?: string, truncate?: boolean }} [options]
 */
function jsonDetails(title, value, registry, options = {}) {
  const json = prettyJson(value);
  const body = h('div', { class: 'details-body' },
    h('div', { class: 'actions' }, copyButton(json), openButton(json, 'json'), options.hint ? h('span', { class: 'hint' }, options.hint) : null));
  let rendered = false;
  const details = h('details', {
    ontoggle: () => {
      if (details.open && !rendered) {
        rendered = true;
        body.append(jsonViewer(options.truncate ? prettyJson(shortenStrings(value)) : json, registry));
      }
    },
  }, h('summary', null, title), body);
  return details;
}

/**
 * Read-only, foldable JSON view (falls back to <pre> without the editor bundle).
 * @param {string} text @param {any[]} registry
 */
function jsonViewer(text, registry) {
  const host = h('div', { class: 'json-view' });
  const factory = /** @type {any} */ (window).McpJsonEditor;
  if (!factory) {
    host.append(h('pre', null, text));
    return host;
  }
  registry.push(factory.create(host, { value: text, readOnly: true, maxHeight: '480px', ariaLabel: 'JSON' }));
  return host;
}

/** Replaces very long strings (base64 payloads) with a short preview. @param {unknown} value @returns {unknown} */
function shortenStrings(value) {
  if (typeof value === 'string') {
    return value.length > 1000 ? `${value.slice(0, 120)}… [${value.length} characters]` : value;
  }
  if (Array.isArray(value)) {
    return value.map(shortenStrings);
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(/** @type {Record<string, unknown>} */ (value)).map(([k, v]) => [k, shortenStrings(v)]));
  }
  return value;
}

/** Pretty JSON text when `text` is a JSON object or array, otherwise null. @param {string} text */
function asJson(text) {
  const trimmed = text.trim();
  if (!/^[[{]/.test(trimmed)) {
    return null;
  }
  try {
    return prettyJson(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

/** @param {string} text @param {unknown} value */
function sameJson(text, value) {
  try {
    return canonical(JSON.parse(text)) === canonical(value);
  } catch {
    return false;
  }
}

/** JSON with sorted keys, for order-insensitive comparison. @param {unknown} value @returns {string} */
function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** @param {string} text @param {string} [label] */
function copyButton(text, label = 'Copy') {
  return h('button', { type: 'button', class: 'ghost', onclick: () => vscode.postMessage({ type: 'copy', text }) }, label);
}

/** @param {string} content @param {string} language */
function openButton(content, language) {
  return h('button', { type: 'button', class: 'ghost', onclick: () => vscode.postMessage({ type: 'openInEditor', content, language }) }, 'Open in Editor');
}

// ---------------------------------------------------------------------------
// Schema section
// ---------------------------------------------------------------------------

function renderSchema() {
  const def = model.definition;
  destroyViewers(viewers.schema);
  if (!def) {
    setChildren(els.schema);
    return;
  }
  setChildren(els.schema,
    h('div', { class: 'section-head' }, h('h2', null, 'Definition')),
    model.kind === 'tool' ? jsonDetails('Input schema', def.inputSchema ?? {}, viewers.schema) : null,
    model.kind === 'tool' && def.outputSchema ? jsonDetails('Output schema', def.outputSchema, viewers.schema) : null,
    jsonDetails(`Full ${KIND_LABELS[/** @type {keyof typeof KIND_LABELS} */ (model.kind)].toLowerCase()} definition`, def, viewers.schema),
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** @param {string | undefined} mime @param {string | undefined} uri */
function languageFor(mime, uri) {
  const m = mime || '';
  if (m.includes('json')) return 'json';
  if (m.includes('markdown')) return 'markdown';
  if (m.includes('html')) return 'html';
  if (m.includes('xml')) return 'xml';
  if (m.includes('yaml')) return 'yaml';
  if (m.includes('javascript')) return 'javascript';
  if (m.includes('typescript')) return 'typescript';
  if (m.includes('python')) return 'python';
  if (m.includes('css')) return 'css';
  const ext = /\.(\w+)$/.exec(uri || '')?.[1];
  return ext ? ({ md: 'markdown', js: 'javascript', ts: 'typescript', py: 'python', yml: 'yaml' })[/** @type {string} */ (ext)] || ext : 'plaintext';
}

/** @param {number} ms */
function formatDuration(ms) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

/** @param {number} bytes */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

vscode.postMessage({ type: 'ready', editorLoaded: typeof (/** @type {any} */ (window).McpJsonEditor) !== 'undefined' });
