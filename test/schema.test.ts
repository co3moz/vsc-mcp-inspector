// Unit tests for the JSON editor's schema assistance and the extension-side validation.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateJson } from '../src/schemaValidation';
import { scanContext } from '../src/webview/jsonContext';
import { propertySuggestions, schemasAt, valueSuggestions, type Schema } from '../src/webview/schemaAssist';

const point = { format: 'uint16', minimum: 0, maximum: 65535, type: 'integer' };

/** Draft 2020-12 schema with $defs, a discriminated oneOf and nullable fields. */
const automate: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  additionalProperties: false,
  required: ['actions', 'session'],
  properties: {
    actions: { type: 'array', items: { $ref: '#/$defs/Action' } },
    capture: { $ref: '#/$defs/Capture' },
    session: { type: 'string', minLength: 1, description: 'Session to drive.' },
    delay_ms: { type: 'integer', minimum: 0, default: 500 },
  },
  $defs: {
    Action: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          description: 'Move the pointer.',
          properties: { type: { const: 'move', type: 'string' }, x: point, y: point },
          required: ['type', 'x', 'y'],
        },
        {
          type: 'object',
          additionalProperties: false,
          description: 'Click at a position.',
          properties: { type: { const: 'click', type: 'string' }, button: { $ref: '#/$defs/Button' }, x: point, y: point, count: { type: 'integer', default: 1 } },
          required: ['type', 'x', 'y'],
        },
        {
          type: 'object',
          additionalProperties: false,
          description: 'Press keys.',
          properties: { type: { const: 'key_press', type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
          required: ['type', 'keys'],
        },
      ],
    },
    Button: { enum: ['left', 'middle', 'right'], type: 'string' },
    Capture: {
      type: 'object',
      properties: {
        max_width: { type: ['integer', 'null'], default: null, minimum: 0 },
        region: { type: ['string', 'null'], default: null },
      },
    },
  },
};

const at = (text: string) => scanContext(text.replace('|', ''), text.indexOf('|'));

describe('scanContext', () => {
  it('finds property-name positions inside array items', () => {
    assert.deepEqual(at('{"actions": [{"type": "click", |'), { kind: 'key', path: ['actions', 0], siblings: ['type'], from: 31, to: 31 });
  });

  it('finds value positions in arrays and objects', () => {
    assert.deepEqual(at('{"actions": [|')?.path, ['actions', 0]);
    assert.deepEqual(at('{"actions": [{"type": "move"}, |')?.path, ['actions', 1]);
    assert.equal(at('{"capture": {"max_width": |')?.kind, 'value');
    assert.deepEqual(at('{"capture": {"max_width": |')?.path, ['capture', 'max_width']);
  });

  it('replaces the whole string when the cursor is inside it', () => {
    const ctx = at('{"actions": [{"type": "cl|"}]}');
    assert.equal(ctx?.kind, 'value');
    assert.deepEqual(ctx?.path, ['actions', 0, 'type']);
    assert.deepEqual([ctx?.from, ctx?.to], [22, 26]);
  });

  it('treats a bare word in key position as a property name', () => {
    assert.deepEqual(at('{"session": "a", ac|'), { kind: 'key', path: [], siblings: ['session'], from: 17, to: 19 });
  });
});

describe('schema suggestions', () => {
  it('suggests root properties, required ones first', () => {
    const suggestions = propertySuggestions(schemasAt(automate, [], {}), automate, new Set());
    assert.deepEqual(suggestions.map((s) => s.label).sort(), ['actions', 'capture', 'delay_ms', 'session']);
    assert.equal(suggestions.find((s) => s.label === 'session')?.boost, 2);
    assert.match(suggestions.find((s) => s.label === 'session')!.info!, /Session to drive/);
  });

  it('offers one template per union variant for a new array item', () => {
    const suggestions = valueSuggestions(schemasAt(automate, ['actions', 0], { actions: [] }), automate);
    assert.deepEqual(
      suggestions.filter((s) => s.kind === 'variant').map((s) => s.label),
      ['move', 'click', 'key_press'],
    );
    const click = suggestions.find((s) => s.label === 'click')!;
    assert.equal(click.snippet, '{\n  "type": "click",\n  "x": ${1:0},\n  "y": ${2:0}\n}');
    assert.equal(click.info, 'Click at a position.');
  });

  it('narrows to the variant chosen by the discriminator', () => {
    const doc = { actions: [{ type: 'click' }] };
    const props = propertySuggestions(schemasAt(automate, ['actions', 0], doc), automate, new Set(['type']));
    assert.deepEqual(props.map((s) => s.label).sort(), ['button', 'count', 'x', 'y']);
    const buttons = valueSuggestions(schemasAt(automate, ['actions', 0, 'button'], doc), automate);
    assert.deepEqual(buttons.map((s) => s.label), ['"left"', '"middle"', '"right"']);
  });

  it('suggests null for nullable fields', () => {
    const values = valueSuggestions(schemasAt(automate, ['capture', 'max_width'], {}), automate);
    assert.ok(values.some((s) => s.label === 'null'));
  });
});

describe('validateJson', () => {
  const check = (value: unknown) => validateJson(automate, JSON.stringify(value));

  it('accepts a valid document', () => {
    assert.deepEqual(check({ session: 's', actions: [{ type: 'click', x: 1, y: 2, button: 'left' }, { type: 'key_press', keys: ['ctrl', 'c'] }] }), []);
  });

  it('reports only the chosen variant\'s errors', () => {
    assert.deepEqual(check({ session: 's', actions: [{ type: 'click', x: 1 }] }), [
      { path: ['actions', 0], target: 'container', message: 'missing required property "y"' },
    ]);
  });

  it('explains an unknown discriminator value', () => {
    assert.deepEqual(check({ session: 's', actions: [{ type: 'clik', x: 1, y: 2 }] }), [
      { path: ['actions', 0, 'type'], target: 'value', message: '"type" must be one of: "move", "click", "key_press"' },
    ]);
  });

  it('flags unknown properties and enum values', () => {
    const issues = check({ session: 's', actions: [{ type: 'click', x: 1, y: 2, button: 'top' }], extra: true });
    const byMessage = (x: { message: string }, y: { message: string }) => x.message.localeCompare(y.message);
    assert.deepEqual(issues.sort(byMessage), [
      { path: ['actions', 0, 'button'], target: 'value', message: 'button must be one of: "left", "middle", "right"' },
      { path: ['extra'], target: 'key', message: 'unknown property "extra"' },
    ].sort(byMessage));
  });

  it('works with draft-07 schemas and ignores unknown formats', () => {
    const schema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { n: { type: 'integer', format: 'uint32' } }, required: ['n'] };
    assert.deepEqual(validateJson(schema, '{"n": 3}'), []);
    assert.deepEqual(validateJson(schema, '{}'), [{ path: [], target: 'container', message: 'missing required property "n"' }]);
  });

  it('ignores text that is not JSON', () => {
    assert.deepEqual(validateJson(automate, '{"session": '), []);
  });
});
