// CodeMirror based JSON editor for the webviews. Bundled to dist/webview/jsonEditor.js and exposed
// as `window.McpJsonEditor`. Themed with VS Code's CSS variables; schema-aware completion and hovers,
// JSON syntax diagnostics, and schema diagnostics supplied by the extension host.
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, snippetCompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, syntaxHighlighting, syntaxTree } from '@codemirror/language';
import { linter, lintKeymap, type Diagnostic } from '@codemirror/lint';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, keymap, lineNumbers, placeholder } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tags as t } from '@lezer/highlight';
import { scanContext } from './jsonContext';
import { describeSchema, expand, propertySuggestions, schemasAt, typeLabel, valueSuggestions, type PathSegment, type Schema, type Suggestion } from './schemaAssist';

export interface SchemaIssue {
  path: PathSegment[];
  message: string;
  /** What to underline: the property value, the property name, or the containing object/array. */
  target: 'value' | 'key' | 'container';
}

export interface JsonEditorOptions {
  value: string;
  schema?: Schema;
  readOnly?: boolean;
  lineNumbers?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  maxHeight?: string;
  minHeight?: string;
  onChange?(text: string): void;
  onSubmit?(): void;
  /** Validates the document against the schema (in the extension host). */
  validate?(text: string, schema: Schema): Promise<SchemaIssue[]>;
}

export interface JsonEditorHandle {
  readonly dom: HTMLElement;
  getValue(): string;
  setValue(text: string): void;
  setSchema(schema: Schema | undefined): void;
  focus(): void;
  destroy(): void;
}

const theme = EditorView.theme({
  '&': {
    color: 'var(--vscode-editor-foreground)',
    backgroundColor: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border, var(--border))',
    borderRadius: '2px',
    fontSize: 'var(--vscode-editor-font-size, 12px)',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--vscode-focusBorder)' },
  '.cm-scroller': { fontFamily: 'var(--vscode-editor-font-family, monospace)', lineHeight: '1.5' },
  '.cm-content': { caretColor: 'var(--vscode-editorCursor-foreground)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--vscode-editorCursor-foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground) !important',
  },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-foreground)', border: 'none' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--vscode-editorLineNumber-activeForeground)' },
  '.cm-activeLine': { backgroundColor: 'var(--vscode-editor-lineHighlightBackground, transparent)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--vscode-editorGutter-foldingControlForeground, var(--vscode-descriptionForeground))', cursor: 'pointer' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--vscode-editor-foldPlaceholderForeground, transparent)',
    border: '1px solid var(--vscode-editorWidget-border, var(--border))',
    color: 'var(--vscode-descriptionForeground)',
    padding: '0 4px',
  },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--vscode-editorBracketMatch-background)',
    outline: '1px solid var(--vscode-editorBracketMatch-border)',
  },
  '.cm-placeholder': { color: 'var(--vscode-input-placeholderForeground)' },
  '.cm-snippetField': { backgroundColor: 'var(--vscode-editor-snippetTabstopHighlightBackground, rgba(124,124,124,.3))' },
  '.cm-tooltip': {
    backgroundColor: 'var(--vscode-editorHoverWidget-background)',
    color: 'var(--vscode-editorHoverWidget-foreground)',
    border: '1px solid var(--vscode-editorHoverWidget-border)',
    borderRadius: '3px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size, 13px)',
  },
  '.cm-tooltip-hover': { padding: '6px 10px', maxWidth: '480px', whiteSpace: 'pre-wrap' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-background)',
    border: '1px solid var(--vscode-editorSuggestWidget-border)',
    color: 'var(--vscode-editorSuggestWidget-foreground)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--vscode-editor-font-family, monospace)', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--vscode-editorSuggestWidget-selectedBackground)',
    color: 'var(--vscode-editorSuggestWidget-selectedForeground, inherit)',
  },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600', color: 'var(--vscode-editorSuggestWidget-highlightForeground)' },
  '.cm-completionDetail': { marginLeft: '1em', fontStyle: 'normal', color: 'var(--vscode-descriptionForeground)' },
  '.cm-tooltip.cm-completionInfo': { padding: '6px 10px', maxWidth: '360px', whiteSpace: 'pre-wrap' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--vscode-editorError-foreground)', textUnderlineOffset: '3px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--vscode-editorError-foreground)' },
  '.cm-panels': { backgroundColor: 'var(--vscode-editorWidget-background)', color: 'var(--vscode-editorWidget-foreground)' },
});

const highlight = HighlightStyle.define([
  { tag: t.propertyName, color: 'var(--vscode-debugTokenExpression-name, #9cdcfe)' },
  { tag: t.string, color: 'var(--vscode-debugTokenExpression-string, #ce9178)' },
  { tag: t.number, color: 'var(--vscode-debugTokenExpression-number, #b5cea8)' },
  { tag: [t.bool, t.null], color: 'var(--vscode-debugTokenExpression-boolean, #569cd6)' },
  { tag: t.invalid, color: 'var(--vscode-errorForeground)' },
]);

export function createJsonEditor(parent: HTMLElement, options: JsonEditorOptions): JsonEditorHandle {
  const schemaRef: { current?: Schema } = { current: options.schema };
  const extensions: Extension[] = [
    // The webview CSP only allows styles carrying the page nonce.
    EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''),
    json(),
    theme,
    syntaxHighlighting(highlight),
    EditorView.lineWrapping,
    drawSelection(),
    keymap.of([...defaultKeymap, ...foldKeymap]),
    EditorView.theme({
      '&': { maxHeight: options.maxHeight ?? '480px', minHeight: options.minHeight ?? 'auto' },
      '.cm-scroller': { overflow: 'auto' },
    }),
  ];
  if (options.ariaLabel) {
    extensions.push(EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel }));
  }
  if (options.lineNumbers ?? !options.readOnly) {
    extensions.push(lineNumbers(), highlightActiveLineGutter());
  }
  // After the line numbers, like VS Code.
  extensions.push(foldGutter({ openText: '⌄', closedText: '›' }));
  if (options.readOnly) {
    extensions.push(
      EditorState.readOnly.of(true),
      EditorView.theme({ '&': { backgroundColor: 'var(--vscode-textCodeBlock-background)', border: 'none' } }),
    );
  } else {
    extensions.push(
      history(),
      bracketMatching(),
      closeBrackets(),
      indentOnInput(),
      highlightActiveLine(),
      keymap.of([...closeBracketsKeymap, ...historyKeymap, ...completionKeymap, ...lintKeymap]),
      autocompletion({ override: [(context) => complete(context, schemaRef.current)], icons: false, activateOnTyping: true }),
      hoverTooltip((view, pos, side) => hover(view, pos, side, schemaRef.current)),
      linter(jsonParseLinter(), { delay: 300 }),
      linter((view) => schemaDiagnostics(view, schemaRef.current, options.validate), { delay: 400 }),
    );
    if (options.placeholder) {
      extensions.push(placeholder(options.placeholder));
    }
    if (options.onSubmit) {
      const submit = options.onSubmit;
      extensions.push(Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (submit(), true) }])));
    }
    if (options.onChange) {
      const onChange = options.onChange;
      extensions.push(EditorView.updateListener.of((update) => update.docChanged && onChange(update.state.doc.toString())));
    }
  }

  const view = new EditorView({ parent, state: EditorState.create({ doc: options.value, extensions }) });
  return {
    dom: view.dom,
    getValue: () => view.state.doc.toString(),
    setValue(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    setSchema(schema) {
      schemaRef.current = schema;
    },
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function complete(context: CompletionContext, schema: Schema | undefined): CompletionResult | null {
  if (!schema) {
    return null;
  }
  const text = context.state.doc.toString();
  const ctx = scanContext(text, context.pos);
  if (!ctx || (!context.explicit && ctx.kind !== 'key' && ctx.kind !== 'value')) {
    return null;
  }
  const doc = documentValue(context.state);
  if (ctx.kind === 'key') {
    const schemas = schemasAt(schema, ctx.path, doc);
    const suggestions = propertySuggestions(schemas, schema, new Set(ctx.siblings));
    const keyOnly = /^\s*:/.test(text.slice(ctx.to));
    return {
      from: ctx.from,
      to: ctx.to,
      options: suggestions.map((s) => toCompletion(s, keyOnly ? JSON.stringify(s.label) : s.snippet)),
      validFor: /^"?[\w$-]*"?$/,
    };
  }
  if (ctx.kind === 'value') {
    const schemas = schemasAt(schema, ctx.path, doc);
    // Inside a value, pick variants from what the user typed so far, not the whole object.
    const suggestions = valueSuggestions(schemas.length ? schemas : expand(schema, schema), schema);
    if (!suggestions.length) {
      return null;
    }
    return { from: ctx.from, to: ctx.to, options: suggestions.map((s) => toCompletion(s, s.snippet)), validFor: /^"?[\w$.-]*"?$/ };
  }
  return null;
}

function toCompletion(s: Suggestion, template: string): Completion {
  const base: Completion = {
    label: s.label,
    detail: s.detail,
    info: s.info || undefined,
    type: s.kind === 'property' ? 'property' : s.kind === 'variant' ? 'class' : 'constant',
    boost: s.boost,
  };
  return snippetCompletion(template, base);
}

// ---------------------------------------------------------------------------
// Syntax tree helpers
// ---------------------------------------------------------------------------

/** Best-effort value of the document, tolerating syntax errors. */
function documentValue(state: EditorState): unknown {
  const text = state.doc.toString();
  try {
    return JSON.parse(text);
  } catch {
    const top = syntaxTree(state).topNode.firstChild;
    return top ? nodeValue(top, text) : undefined;
  }
}

function nodeValue(node: SyntaxNode, text: string): unknown {
  switch (node.name) {
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name !== 'Property') continue;
        const name = child.getChild('PropertyName');
        const value = name?.nextSibling?.nextSibling ?? null; // skip ":"
        if (!name) continue;
        try {
          out[JSON.parse(text.slice(name.from, name.to))] = value ? nodeValue(value, text) : undefined;
        } catch {
          // incomplete property name
        }
      }
      return out;
    }
    case 'Array': {
      const out: unknown[] = [];
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (isValueNode(child)) out.push(nodeValue(child, text));
      }
      return out;
    }
    case 'String':
      try {
        return JSON.parse(text.slice(node.from, node.to));
      } catch {
        return undefined;
      }
    case 'Number':
      return Number(text.slice(node.from, node.to));
    case 'True':
      return true;
    case 'False':
      return false;
    case 'Null':
      return null;
    default:
      return undefined;
  }
}

function isValueNode(node: SyntaxNode): boolean {
  return ['Object', 'Array', 'String', 'Number', 'True', 'False', 'Null'].includes(node.name);
}

/** JSON path of a node (for hovers), from the syntax tree. */
function pathOf(node: SyntaxNode, text: string): PathSegment[] {
  const path: PathSegment[] = [];
  let current: SyntaxNode | null = node;
  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (current.name === 'Property') {
      const name = current.getChild('PropertyName');
      if (name) {
        try {
          path.unshift(JSON.parse(text.slice(name.from, name.to)));
        } catch {
          path.unshift(text.slice(name.from + 1, name.to - 1));
        }
      }
    } else if (parent?.name === 'Array' && isValueNode(current)) {
      let index = 0;
      for (let sibling = parent.firstChild; sibling && sibling !== current && sibling.from < current.from; sibling = sibling.nextSibling) {
        if (isValueNode(sibling)) index++;
      }
      path.unshift(index);
    }
    current = parent;
  }
  return path;
}

/** Node for a JSON path: the value, or the property name when `key` is true. */
function nodeAtPath(state: EditorState, path: PathSegment[], target: SchemaIssue['target']): SyntaxNode | null {
  const text = state.doc.toString();
  let node: SyntaxNode | null = syntaxTree(state).topNode.firstChild;
  let nameNode: SyntaxNode | null = null;
  for (const segment of path) {
    if (!node) return null;
    let next: SyntaxNode | null = null;
    if (node.name === 'Object' && typeof segment === 'string') {
      for (let child = node.firstChild; child; child = child.nextSibling) {
        const name = child.name === 'Property' ? child.getChild('PropertyName') : null;
        if (name && safeParse(text.slice(name.from, name.to)) === segment) {
          nameNode = name;
          next = name.nextSibling?.nextSibling ?? name;
          break;
        }
      }
    } else if (node.name === 'Array' && typeof segment === 'number') {
      let index = 0;
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (isValueNode(child) && index++ === segment) {
          next = child;
          break;
        }
      }
      nameNode = null;
    }
    if (!next) return node;
    node = next;
  }
  return target === 'key' && nameNode ? nameNode : node;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Hover and diagnostics
// ---------------------------------------------------------------------------

function hover(view: EditorView, pos: number, side: -1 | 1, schema: Schema | undefined) {
  if (!schema) return null;
  const node = syntaxTree(view.state).resolveInner(pos, side);
  if (node.name !== 'PropertyName') return null;
  const text = view.state.doc.toString();
  const path = pathOf(node.parent!, text);
  const schemas = schemasAt(schema, path, documentValue(view.state));
  if (!schemas.length) return null;
  const parentSchemas = schemasAt(schema, path.slice(0, -1), documentValue(view.state));
  const raw = parentSchemas.map((s) => s.properties?.[path[path.length - 1] as string]).find(Boolean) ?? schemas[0];
  return {
    pos: node.from,
    end: node.to,
    above: true,
    create() {
      const dom = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = `${String(path[path.length - 1])}: ${typeLabel(schemas[0])}`;
      const body = document.createElement('div');
      body.textContent = describeSchema(raw, schema);
      dom.append(title, body);
      return { dom };
    },
  };
}

async function schemaDiagnostics(view: EditorView, schema: Schema | undefined, validate: JsonEditorOptions['validate']): Promise<Diagnostic[]> {
  const text = view.state.doc.toString();
  if (!schema || !validate || !text.trim() || safeParse(text) === undefined) {
    return [];
  }
  let issues: SchemaIssue[];
  try {
    issues = await validate(text, schema);
  } catch {
    return [];
  }
  if (view.state.doc.toString() !== text) {
    return [];
  }
  return issues.map((issue) => {
    const node = nodeAtPath(view.state, issue.path, issue.target);
    const from = node ? node.from : 0;
    // Objects/arrays: only underline the opening bracket so large blocks are not all red.
    const to = node && issue.target === 'container' && (node.name === 'Object' || node.name === 'Array') ? from + 1 : node ? node.to : Math.min(1, text.length);
    return { from, to: Math.max(to, from + 1), severity: 'error', message: issue.message, source: 'schema' } satisfies Diagnostic;
  });
}

(globalThis as Record<string, unknown>).McpJsonEditor = { create: createJsonEditor };
