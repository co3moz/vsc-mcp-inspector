// Finds where the cursor is inside a (possibly incomplete) JSON document: which object or array,
// which key or index, and whether a property name or a value is expected.
import type { PathSegment } from './schemaAssist';

export interface ScanContext {
  kind: 'key' | 'value' | 'other';
  /** Path of the object (for keys) or of the value (for values). */
  path: PathSegment[];
  /** Keys already present in the object, for key completion. */
  siblings: string[];
  from: number;
  to: number;
}

interface Frame {
  type: 'object' | 'array';
  segment?: PathSegment;
  key?: string;
  index: number;
  expect: 'key' | 'colon' | 'value' | 'comma';
  keys: string[];
}

/**
 * Tolerant scan of `text` up to `pos` that works on incomplete JSON: tracks the open
 * objects/arrays, the current key or index, and what token is expected next.
 */
export function scanContext(text: string, pos: number): ScanContext | null {
  const stack: Frame[] = [];
  let rootExpect: 'value' | 'done' = 'value';
  let i = 0;
  const top = () => stack[stack.length - 1];
  const valueDone = () => {
    const frame = top();
    if (frame) {
      frame.expect = 'comma';
    } else {
      rootExpect = 'done';
    }
  };
  const childSegment = (): PathSegment | undefined => {
    const frame = top();
    return frame ? (frame.type === 'object' ? frame.key : frame.index) : undefined;
  };
  const path = () => stack.slice(1).map((f) => f.segment!) as PathSegment[];

  while (i < pos) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '"') {
      const end = stringEnd(text, i);
      if (end === -1 || end >= pos) {
        // Cursor inside this string.
        const to = end === -1 ? text.length : end + 1;
        const frame = top();
        if (frame?.type === 'object' && frame.expect === 'key') {
          return { kind: 'key', path: stack.map((f) => f.segment).slice(1) as PathSegment[], siblings: frame.keys, from: i, to };
        }
        return { kind: 'value', path: [...path(), ...(childSegment() !== undefined ? [childSegment()!] : [])], siblings: [], from: i, to };
      }
      const frame = top();
      if (frame?.type === 'object' && frame.expect === 'key') {
        try {
          frame.key = JSON.parse(text.slice(i, end + 1));
        } catch {
          frame.key = text.slice(i + 1, end);
        }
        frame.keys.push(frame.key!);
        frame.expect = 'colon';
      } else {
        valueDone();
      }
      i = end + 1;
      continue;
    }
    if (ch === '{' || ch === '[') {
      const segment = childSegment();
      stack.push({ type: ch === '{' ? 'object' : 'array', segment, index: 0, expect: ch === '{' ? 'key' : 'value', keys: [] });
      i++;
      continue;
    }
    if (ch === '}' || ch === ']') {
      stack.pop();
      valueDone();
      i++;
      continue;
    }
    if (ch === ':') {
      const frame = top();
      if (frame) frame.expect = 'value';
      i++;
      continue;
    }
    if (ch === ',') {
      const frame = top();
      if (frame) {
        if (frame.type === 'object') {
          frame.expect = 'key';
          frame.key = undefined;
        } else {
          frame.index++;
          frame.expect = 'value';
        }
      }
      i++;
      continue;
    }
    // Bare word: number, true/false/null or a partially typed token.
    const match = /^[^\s,:{}[\]"]+/.exec(text.slice(i));
    const word = match ? match[0] : ch;
    if (i + word.length >= pos) {
      return contextAt(i, i + word.length);
    }
    valueDone();
    i += word.length;
  }
  return contextAt(pos, pos);

  function contextAt(from: number, to: number): ScanContext | null {
    const frame = top();
    if (!frame) {
      return rootExpect === 'value' ? { kind: 'value', path: [], siblings: [], from, to } : null;
    }
    const base = stack.map((f) => f.segment).slice(1) as PathSegment[];
    if (frame.type === 'object') {
      if (frame.expect === 'key') return { kind: 'key', path: base, siblings: frame.keys, from, to };
      if (frame.expect === 'value') return { kind: 'value', path: [...base, frame.key!], siblings: [], from, to };
      return { kind: 'other', path: base, siblings: [], from, to };
    }
    if (frame.expect === 'value') return { kind: 'value', path: [...base, frame.index], siblings: [], from, to };
    return { kind: 'other', path: base, siblings: [], from, to };
  }
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (text[i] === '"') {
      return i;
    } else if (text[i] === '\n') {
      return -1;
    }
  }
  return -1;
}
