// @ts-check
/* Shared helpers for the MCP Inspector webviews. Loaded before the page script. */

// eslint-disable-next-line no-undef
const vscode = acquireVsCodeApi();

const PROPERTY_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'open', 'indeterminate']);

/**
 * Tiny DOM builder. Text children are always inserted as text nodes, so server provided
 * strings can never inject markup.
 * @param {string} tag
 * @param {Record<string, any> | null} [props]
 * @param {...any} children
 * @returns {any}
 */
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    if (key === 'class') {
      el.className = value;
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (PROPERTY_KEYS.has(key)) {
      el[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(el, children);
  return el;
}

/** @param {HTMLElement} el @param {any[]} children */
function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) {
      continue;
    }
    el.append(child instanceof Node ? child : String(child));
  }
}

/**
 * Replaces an element's children, skipping null/undefined/false (the native replaceChildren
 * would render them as text).
 * @param {HTMLElement} el
 * @param {...any} children
 */
function setChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}

/** Grows a textarea with its content. @param {HTMLTextAreaElement} textarea */
function autoGrow(textarea) {
  textarea.classList.add('autogrow');
  const resize = () => {
    if (!textarea.isConnected) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, 420)}px`;
  };
  textarea.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return textarea;
}

/** @param {unknown} value */
function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

/** @param {string} prefix */
function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
