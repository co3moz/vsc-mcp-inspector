// @ts-check
/* Create / edit connection form. Depends on common.js. */

const TRANSPORTS = [
  { id: 'stdio', title: 'STDIO', text: 'Launch a local process and talk over stdin/stdout.' },
  { id: 'sse', title: 'SSE', text: 'Legacy HTTP + Server-Sent Events endpoint.' },
  { id: 'http', title: 'Streamable HTTP', text: 'Current HTTP transport (single /mcp endpoint).' },
];

const URL_PLACEHOLDERS = { sse: 'http://localhost:3001/sse', http: 'http://localhost:3001/mcp' };
const HEADER_SUGGESTIONS = ['Authorization', 'X-API-Key', 'Api-Key', 'Cookie', 'User-Agent', 'Accept-Language', 'X-Request-ID', 'X-Tenant-ID'];
const SENSITIVE = /auth|token|key|secret|cookie|pass|session|credential/i;

/** @typedef {{ key: string, value: string, enabled: boolean }} KeyValue */

const state = {
  mode: 'create',
  id: /** @type {string | undefined} */ (undefined),
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  cwd: '',
  /** @type {KeyValue[]} */ env: [],
  url: '',
  /** @type {KeyValue[]} */ headers: [],
  /** @type {null | 'test' | 'save'} */ busy: null,
  /** @type {any} */ result: null,
};

const app = /** @type {HTMLElement} */ (document.getElementById('app'));

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'init': {
      state.mode = msg.mode;
      const c = msg.config;
      if (c) {
        state.id = c.id;
        state.name = c.name ?? '';
        state.transport = c.transport ?? 'stdio';
        state.command = c.command ?? '';
        state.argsText = formatArgs(c.args ?? []);
        state.cwd = c.cwd ?? '';
        state.env = (c.env ?? []).map((/** @type {KeyValue} */ e) => ({ ...e }));
        state.url = c.url ?? '';
        state.headers = (c.headers ?? []).map((/** @type {KeyValue} */ e) => ({ ...e }));
      }
      render();
      focusFirst();
      break;
    }
    case 'cwd':
      state.cwd = msg.path;
      render();
      break;
    case 'testResult':
      state.busy = null;
      state.result = msg.ok ? { kind: 'ok', summary: msg.summary } : { kind: 'err', title: 'Connection failed', error: msg.error };
      render();
      break;
    case 'saveResult':
      state.busy = null;
      state.result = { kind: 'err', title: state.mode === 'edit' ? 'Could not save the connection' : 'Connection was not added', error: msg.error };
      render();
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    submit('save', true);
  }
});

function focusFirst() {
  const input = /** @type {HTMLInputElement | null} */ (document.querySelector(state.name ? '[data-focus=main]' : '#name'));
  input?.focus();
}

/** @param {'test' | 'save'} action @param {boolean} [connect] */
function submit(action, connect = true) {
  if (state.busy) {
    return;
  }
  const problem = validate();
  if (problem) {
    state.result = { kind: 'err', title: 'Please check the form', error: problem };
    render();
    return;
  }
  state.busy = action;
  state.result = null;
  render();
  vscode.postMessage(action === 'test' ? { type: 'test', config: collect() } : { type: 'save', config: collect(), connect });
}

function validate() {
  if (!state.name.trim()) {
    return 'Connection name is required.';
  }
  if (state.transport === 'stdio') {
    return state.command.trim() ? '' : 'Command is required for STDIO connections.';
  }
  return state.url.trim() ? '' : 'Server URL is required.';
}

function collect() {
  const base = { id: state.id, name: state.name.trim(), transport: state.transport };
  if (state.transport === 'stdio') {
    return { ...base, command: state.command.trim(), args: parseArgs(state.argsText), cwd: state.cwd.trim(), env: state.env };
  }
  return { ...base, url: state.url.trim(), headers: state.headers };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const editing = state.mode === 'edit';
  const busy = !!state.busy;
  setChildren(app, 
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'header' }, h('h1', null, editing ? 'Edit Connection' : 'Create New Connection'),
        h('p', { class: 'muted' }, 'Connect to a Model Context Protocol server. Once connected it appears in the MCP Inspector sidebar with all of its tools.')),
      h('label', { class: 'field' },
        h('span', { class: 'field-label' }, 'Name', h('span', { class: 'req' }, '*')),
        h('input', {
          id: 'name',
          type: 'text',
          value: state.name,
          placeholder: 'e.g. Filesystem server',
          disabled: busy,
          oninput: (/** @type {any} */ e) => (state.name = e.target.value),
        }),
        h('span', { class: 'hint' }, 'Shown in the sidebar.')),
      h('div', { class: 'field' },
        h('span', { class: 'field-label' }, 'Transport'),
        h('div', { class: 'transport-cards', role: 'radiogroup' },
          TRANSPORTS.map((t) =>
            h('button', {
              class: 'transport-card',
              type: 'button',
              role: 'radio',
              'aria-pressed': String(state.transport === t.id),
              'aria-checked': String(state.transport === t.id),
              disabled: busy,
              onclick: () => {
                state.transport = t.id;
                state.result = null;
                render();
              },
            }, h('strong', null, t.title), h('span', null, t.text))))),
      state.transport === 'stdio' ? renderStdio(busy) : renderHttp(busy),
      renderResult(),
      renderActions(editing, busy),
    ),
  );
}

/** @param {boolean} busy */
function renderStdio(busy) {
  const argsPreview = h('div', { class: 'row hint' });
  const updatePreview = () => {
    const args = parseArgs(state.argsText);
    setChildren(argsPreview, 
      ...(args.length
        ? [`${args.length} argument${args.length === 1 ? '' : 's'}:`, ...args.map((a) => h('code', { class: 'badge outline' }, a || '""'))]
        : ['Space separated. Wrap values containing spaces in quotes.']),
    );
  };
  updatePreview();

  return h('div', { class: 'stack' },
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Command', h('span', { class: 'req' }, '*')),
      h('input', {
        type: 'text',
        class: 'code',
        'data-focus': 'main',
        value: state.command,
        placeholder: 'npx',
        disabled: busy,
        oninput: (/** @type {any} */ e) => (state.command = e.target.value),
        onblur: () => {
          // Pasting a full command line ("npx -y some-server") splits it into command + arguments.
          const split = splitCommandLine(state.command);
          if (split && !state.argsText.trim()) {
            state.command = split.command;
            state.argsText = split.rest;
            render();
          }
        },
      }),
      h('span', { class: 'hint' }, 'Executable that starts the server, e.g. npx, node, python, uvx, docker.')),
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Arguments'),
      h('input', {
        type: 'text',
        class: 'code',
        value: state.argsText,
        placeholder: '-y @modelcontextprotocol/server-everything',
        disabled: busy,
        oninput: (/** @type {any} */ e) => {
          state.argsText = e.target.value;
          updatePreview();
        },
      }),
      argsPreview),
    h('div', { class: 'field' },
      h('span', { class: 'field-label' }, 'Working directory'),
      h('div', { class: 'input-row' },
        h('input', {
          type: 'text',
          class: 'code',
          value: state.cwd,
          placeholder: 'Defaults to the extension host directory',
          disabled: busy,
          oninput: (/** @type {any} */ e) => (state.cwd = e.target.value),
        }),
        h('button', { class: 'secondary', type: 'button', disabled: busy, onclick: () => vscode.postMessage({ type: 'pickCwd', current: state.cwd }) }, 'Browse…'))),
    renderKeyValues({
      title: 'Environment variables',
      rows: state.env,
      keyPlaceholder: 'NAME',
      valuePlaceholder: 'value',
      addLabel: 'Add variable',
      hint: 'Added on top of VS Code\'s environment. Values support ${env:NAME}, ${workspaceFolder} and ${userHome}. Stored in VS Code secret storage.',
      busy,
    }),
  );
}

/** @param {boolean} busy */
function renderHttp(busy) {
  return h('div', { class: 'stack' },
    h('label', { class: 'field' },
      h('span', { class: 'field-label' }, 'Server URL', h('span', { class: 'req' }, '*')),
      h('input', {
        type: 'text',
        class: 'code',
        'data-focus': 'main',
        value: state.url,
        placeholder: URL_PLACEHOLDERS[/** @type {'sse' | 'http'} */ (state.transport)],
        disabled: busy,
        oninput: (/** @type {any} */ e) => (state.url = e.target.value),
      }),
      h('span', { class: 'hint' }, state.transport === 'sse' ? 'The SSE stream endpoint, usually ending in /sse.' : 'The MCP endpoint, usually ending in /mcp.')),
    renderKeyValues({
      title: 'Headers',
      rows: state.headers,
      keyPlaceholder: 'Header-Name',
      valuePlaceholder: 'value',
      addLabel: 'Add header',
      extra: h('button', {
        class: 'ghost',
        type: 'button',
        disabled: busy,
        onclick: () => {
          const existing = state.headers.find((r) => r.key.toLowerCase() === 'authorization');
          if (!existing) {
            state.headers.push({ key: 'Authorization', value: 'Bearer ', enabled: true });
          }
          render();
          const inputs = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.kv-row [data-role=value]'));
          const index = state.headers.findIndex((r) => r.key.toLowerCase() === 'authorization');
          const input = inputs[index];
          if (input) {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
          }
        },
      }, '+ Bearer token'),
      hint: 'Sent with every request, including the SSE stream. Values support ${env:NAME}. Stored in VS Code secret storage.',
      suggestions: HEADER_SUGGESTIONS,
      busy,
    }),
  );
}

/**
 * @param {{ title: string, rows: KeyValue[], keyPlaceholder: string, valuePlaceholder: string, addLabel: string,
 *           hint: string, busy: boolean, extra?: HTMLElement, suggestions?: string[] }} opts
 */
function renderKeyValues(opts) {
  const listId = opts.suggestions ? uid('suggest') : undefined;
  const rows = opts.rows.map((row, index) => {
    const valueInput = h('input', {
      type: SENSITIVE.test(row.key) ? 'password' : 'text',
      class: 'code',
      'data-role': 'value',
      value: row.value,
      placeholder: opts.valuePlaceholder,
      disabled: opts.busy,
      'aria-label': `${opts.title} value`,
      oninput: (/** @type {any} */ e) => (row.value = e.target.value),
      onfocus: (/** @type {any} */ e) => (e.target.type = 'text'),
      onblur: (/** @type {any} */ e) => (e.target.type = SENSITIVE.test(row.key) ? 'password' : 'text'),
    });
    const element = h('div', { class: `kv-row${row.enabled ? '' : ' disabled'}` },
      h('input', {
        type: 'checkbox',
        checked: row.enabled,
        disabled: opts.busy,
        title: 'Enabled',
        'aria-label': 'Enabled',
        onchange: (/** @type {any} */ e) => {
          row.enabled = e.target.checked;
          element.classList.toggle('disabled', !row.enabled);
        },
      }),
      h('input', {
        type: 'text',
        class: 'code',
        value: row.key,
        placeholder: opts.keyPlaceholder,
        list: listId,
        disabled: opts.busy,
        'aria-label': `${opts.title} name`,
        oninput: (/** @type {any} */ e) => {
          row.key = e.target.value;
          if (document.activeElement !== valueInput) {
            valueInput.type = SENSITIVE.test(row.key) ? 'password' : 'text';
          }
        },
      }),
      valueInput,
      h('button', {
        class: 'ghost icon',
        type: 'button',
        title: 'Remove',
        'aria-label': 'Remove',
        disabled: opts.busy,
        onclick: () => {
          opts.rows.splice(index, 1);
          render();
        },
      }, '✕'),
    );
    return element;
  });

  return h('div', { class: 'field' },
    h('div', { class: 'section-head' }, h('span', { class: 'field-label' }, opts.title), h('span', { class: 'badge outline' }, String(opts.rows.length)), h('span', { class: 'spacer' }), opts.extra,
      h('button', {
        class: 'ghost',
        type: 'button',
        disabled: opts.busy,
        onclick: () => {
          opts.rows.push({ key: '', value: '', enabled: true });
          render();
          const keys = /** @type {NodeListOf<HTMLInputElement>} */ (document.querySelectorAll('.kv-row input.code:not([data-role])'));
          keys[keys.length - 1]?.focus();
        },
      }, `+ ${opts.addLabel}`)),
    h('div', { class: 'kv-table' }, rows.length ? rows : h('div', { class: 'kv-empty' }, 'None')),
    listId ? h('datalist', { id: listId }, (opts.suggestions ?? []).map((s) => h('option', { value: s }))) : null,
    h('span', { class: 'hint' }, opts.hint));
}

function renderResult() {
  if (state.busy) {
    return h('div', { class: 'callout info' },
      h('div', { class: 'row' }, h('span', { class: 'spinner' }), h('span', null, state.transport === 'stdio' ? 'Starting the server and initializing…' : 'Connecting to the server and initializing…')));
  }
  const result = state.result;
  if (!result) {
    return null;
  }
  if (result.kind === 'err') {
    return h('div', { class: 'callout err', role: 'alert' }, h('div', { class: 'callout-title' }, result.title), h('pre', null, result.error));
  }
  const s = result.summary;
  return h('div', { class: 'callout ok' },
    h('div', { class: 'callout-title' }, '✓ Connection successful'),
    h('dl', { class: 'kv-grid' },
      h('dt', null, 'Server'), h('dd', null, [s.serverName, s.serverVersion].filter(Boolean).join(' ') || 'unknown'),
      h('dt', null, 'Protocol'), h('dd', null, s.protocolVersion ?? 'unknown'),
      h('dt', null, 'Capabilities'), h('dd', null, s.capabilities.length ? s.capabilities.join(', ') : 'none'),
      h('dt', null, 'Offers'), h('dd', null, [plural(s.counts.tools, 'tool'), plural(s.counts.prompts, 'prompt'), plural(s.counts.resources, 'resource'), plural(s.counts.templates, 'resource template')].join(' · '))),
    s.instructions ? h('details', null, h('summary', null, 'Server instructions'), h('div', { class: 'details-body' }, h('pre', null, s.instructions))) : null);
}

/** @param {boolean} editing @param {boolean} busy */
function renderActions(editing, busy) {
  return h('div', { class: 'actions' },
    h('button', { type: 'button', disabled: busy, onclick: () => submit('save', true), title: 'Ctrl+Enter' },
      state.busy === 'save' ? h('span', { class: 'spinner' }) : null, editing ? 'Save & Reconnect' : 'Connect & Save'),
    h('button', { type: 'button', class: 'secondary', disabled: busy, onclick: () => submit('test') },
      state.busy === 'test' ? h('span', { class: 'spinner' }) : null, 'Test Connection'),
    h('button', { type: 'button', class: 'ghost', disabled: busy, onclick: () => submit('save', false) }, 'Save Without Connecting'),
    h('span', { class: 'spacer' }),
    h('button', { type: 'button', class: 'ghost', onclick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel'));
}

/** @param {number} n @param {string} word */
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/**
 * Splits a command line into arguments. Quotes group words; backslashes are kept literally so
 * Windows paths survive.
 * @param {string} text
 * @returns {string[]}
 */
function parseArgs(text) {
  const args = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) {
        quote = '';
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) {
    args.push(current);
  }
  return args;
}

/** @param {string[]} args */
function formatArgs(args) {
  return args
    .map((arg) => {
      if (arg === '') {
        return '""';
      }
      if (!/[\s"']/.test(arg)) {
        return arg;
      }
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`;
    })
    .join(' ');
}

/**
 * "npx -y server" → { command: "npx", rest: "-y server" }. Unquoted paths that contain spaces
 * (e.g. C:\Program Files\...) are left alone; quoted ones are split.
 * @param {string} commandLine
 */
function splitCommandLine(commandLine) {
  const trimmed = commandLine.trim();
  if (/^["']/.test(trimmed)) {
    const [command, ...rest] = parseArgs(trimmed);
    return command && rest.length ? { command, rest: formatArgs(rest) } : null;
  }
  const match = /^(\S+)\s+(.+)$/.exec(trimmed);
  if (!match || /[\\/]/.test(match[1])) {
    return null;
  }
  return { command: match[1], rest: match[2] };
}

vscode.postMessage({ type: 'ready' });
