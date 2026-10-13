// @ts-check
/* Builds an input form from a JSON Schema (tool inputSchema). Depends on common.js. */

/**
 * @typedef {{ present: boolean, value?: any, error?: string }} ReadResult
 * @typedef {{ element: HTMLElement, read(): ReadResult, write(value: any): void, focus(): void, isEmpty(): boolean }} Field
 */

const MAX_DEPTH = 4;

/**
 * @param {any} schema root object schema
 * @param {Record<string, any> | undefined} initial
 */
function createSchemaForm(schema, initial) {
  const root = schema || {};
  const objectField = createObjectFields(root, root, 0);
  if (initial) {
    objectField.write(initial);
  }
  return {
    element: objectField.element,
    hasFields: objectField.count > 0,
    /** Free-form objects (no declared properties) can only be edited as JSON. */
    jsonOnly: objectField.count === 0 && acceptsExtraProperties(root),
    /** @returns {{ value: Record<string, any>, errors: string[] }} */
    read() {
      const errors = [];
      const value = objectField.readAll(errors, '');
      return { value, errors };
    },
    /** @param {Record<string, any>} value */
    write(value) {
      objectField.write(value || {});
    },
    focus() {
      objectField.focus();
    },
  };
}

/** Explicitly open-ended object without declared properties, e.g. { additionalProperties: {...} }. @param {any} schema */
function acceptsExtraProperties(schema) {
  return !schema.properties && (schema.additionalProperties === true || isPlainObject(schema.additionalProperties));
}

/**
 * @param {any} schema
 * @param {any} root
 * @param {number} depth
 */
function createObjectFields(schema, root, depth) {
  const properties = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  /** @type {[string, Field][]} */
  const fields = Object.entries(properties).map(([name, propSchema]) => [name, createField(name, propSchema, required.has(name), root, depth)]);
  const element = h('div', { class: 'stack' }, fields.map(([, field]) => field.element));

  return {
    element,
    count: fields.length,
    /** @param {string[]} errors @param {string} path */
    readAll(errors, path) {
      /** @type {Record<string, any>} */
      const value = {};
      for (const [name, field] of fields) {
        const result = field.read();
        if (result.error) {
          errors.push(`${path}${name}: ${result.error}`);
        } else if (result.present) {
          value[name] = result.value;
        }
      }
      return value;
    },
    /** @param {Record<string, any>} value */
    write(value) {
      for (const [name, field] of fields) {
        field.write(value ? value[name] : undefined);
      }
    },
    focus() {
      fields[0]?.[1].focus();
    },
    isEmpty() {
      return fields.every(([, field]) => field.isEmpty());
    },
  };
}

/**
 * @param {string} name
 * @param {any} rawSchema
 * @param {boolean} required
 * @param {any} root
 * @param {number} depth
 * @returns {Field}
 */
function createField(name, rawSchema, required, root, depth) {
  const schema = normalizeSchema(rawSchema, root);
  const type = schema.type;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : null;

  if (enumValues) {
    return enumField(name, schema, required, enumValues);
  }
  if (type === 'boolean') {
    return booleanField(name, schema, required);
  }
  if (type === 'number' || type === 'integer') {
    return numberField(name, schema, required);
  }
  if (type === 'string') {
    return stringField(name, schema, required);
  }
  if (type === 'object' && schema.properties && Object.keys(schema.properties).length && depth < MAX_DEPTH) {
    return objectField(name, schema, required, root, depth);
  }
  return jsonField(name, schema, required);
}

/**
 * Resolves local $refs and simplifies nullable unions so the right widget can be picked.
 * @param {any} schema
 * @param {any} root
 */
function normalizeSchema(schema, root) {
  let s = schema && typeof schema === 'object' ? schema : {};
  for (let i = 0; i < 5 && typeof s.$ref === 'string' && s.$ref.startsWith('#/'); i++) {
    const target = s.$ref
      .slice(2)
      .split('/')
      .reduce((/** @type {any} */ node, /** @type {string} */ part) => (node ? node[part.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
    if (!target) {
      break;
    }
    const { $ref, ...rest } = s;
    s = { ...target, ...rest };
  }
  let nullable = false;
  if (Array.isArray(s.type)) {
    const types = s.type.filter((/** @type {string} */ t) => t !== 'null');
    nullable = types.length !== s.type.length;
    s = { ...s, type: types.length === 1 ? types[0] : undefined, typeList: types };
  }
  const union = s.anyOf || s.oneOf;
  if (Array.isArray(union)) {
    const options = union.map((/** @type {any} */ o) => normalizeSchema(o, root));
    const nonNull = options.filter((/** @type {any} */ o) => o.type !== 'null');
    nullable = nullable || nonNull.length !== options.length;
    if (nonNull.length === 1) {
      const { anyOf, oneOf, ...rest } = s;
      s = { ...nonNull[0], ...rest, description: s.description ?? nonNull[0].description };
    } else if (nonNull.length && nonNull.every((/** @type {any} */ o) => o.const !== undefined || Array.isArray(o.enum))) {
      s = { ...s, enum: nonNull.flatMap((/** @type {any} */ o) => (o.const !== undefined ? [o.const] : o.enum)) };
    }
  }
  return nullable ? { ...s, nullable: true } : s;
}

/** @param {any} schema */
function typeLabel(schema) {
  if (Array.isArray(schema.enum)) {
    return 'enum';
  }
  if (schema.type === 'array') {
    const item = schema.items && typeof schema.items === 'object' ? schema.items.type : undefined;
    return item ? `${item}[]` : 'array';
  }
  if (schema.type) {
    return schema.format ? `${schema.type} · ${schema.format}` : schema.type;
  }
  if (schema.typeList?.length) {
    return schema.typeList.join(' | ');
  }
  if (schema.anyOf || schema.oneOf) {
    return 'union';
  }
  return 'any';
}

/** @param {any} schema */
function constraintHint(schema) {
  const parts = [];
  if (schema.minimum !== undefined) parts.push(`min ${schema.minimum}`);
  if (schema.exclusiveMinimum !== undefined) parts.push(`> ${schema.exclusiveMinimum}`);
  if (schema.maximum !== undefined) parts.push(`max ${schema.maximum}`);
  if (schema.exclusiveMaximum !== undefined) parts.push(`< ${schema.exclusiveMaximum}`);
  if (schema.minLength !== undefined) parts.push(`min length ${schema.minLength}`);
  if (schema.maxLength !== undefined) parts.push(`max length ${schema.maxLength}`);
  if (schema.minItems !== undefined) parts.push(`min items ${schema.minItems}`);
  if (schema.maxItems !== undefined) parts.push(`max items ${schema.maxItems}`);
  if (schema.pattern) parts.push(`pattern ${schema.pattern}`);
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts.join(' · ');
}

/**
 * Common label / description / error chrome around an input.
 * @param {string} name @param {any} schema @param {boolean} required @param {HTMLElement} control
 */
function fieldShell(name, schema, required, control) {
  const error = h('span', { class: 'field-error hidden' });
  const hint = constraintHint(schema);
  const element = h('div', { class: 'field' },
    h('label', { class: 'field-label', for: control.id || undefined },
      h('span', null, schema.title && schema.title !== name ? `${schema.title} (${name})` : name),
      required ? h('span', { class: 'req', title: 'Required' }, '*') : null,
      h('span', { class: 'type-tag' }, typeLabel(schema))),
    schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
    control,
    hint ? h('span', { class: 'hint' }, hint) : null,
    error);
  /** @param {string | undefined} message */
  const setError = (message) => {
    error.textContent = message || '';
    error.classList.toggle('hidden', !message);
    control.classList.toggle('invalid', !!message);
  };
  return { element, setError };
}

/** @param {string} name @param {any} schema @param {boolean} required @returns {Field} */
function stringField(name, schema, required) {
  const input = /** @type {HTMLTextAreaElement} */ (autoGrow(h('textarea', {
    id: uid('f'),
    rows: 1,
    placeholder: schema.default !== undefined ? String(schema.default) : schema.examples?.[0] !== undefined ? `e.g. ${schema.examples[0]}` : '',
    spellcheck: 'false',
  })));
  const shell = fieldShell(name, schema, required, input);
  input.addEventListener('input', () => shell.setError(undefined));
  return {
    element: shell.element,
    read() {
      const value = input.value;
      if (value === '') {
        return required ? fail(shell, 'Required') : { present: false };
      }
      shell.setError(undefined);
      return { present: true, value };
    },
    write(value) {
      input.value = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      input.dispatchEvent(new Event('input'));
    },
    focus: () => input.focus(),
    isEmpty: () => input.value === '',
  };
}

/** @param {string} name @param {any} schema @param {boolean} required @returns {Field} */
function numberField(name, schema, required) {
  const integer = schema.type === 'integer';
  const input = /** @type {HTMLInputElement} */ (h('input', {
    id: uid('f'),
    type: 'number',
    step: integer ? '1' : 'any',
    min: schema.minimum,
    max: schema.maximum,
    placeholder: schema.default !== undefined ? String(schema.default) : '',
  }));
  const shell = fieldShell(name, schema, required, input);
  input.addEventListener('input', () => shell.setError(undefined));
  return {
    element: shell.element,
    read() {
      const raw = input.value.trim();
      if (raw === '') {
        return required ? fail(shell, 'Required') : { present: false };
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        return fail(shell, 'Not a valid number');
      }
      if (integer && !Number.isInteger(value)) {
        return fail(shell, 'Must be an integer');
      }
      shell.setError(undefined);
      return { present: true, value };
    },
    write(value) {
      input.value = typeof value === 'number' ? String(value) : value === undefined || value === null ? '' : String(value);
    },
    focus: () => input.focus(),
    isEmpty: () => input.value.trim() === '',
  };
}

/** @param {string} name @param {any} schema @param {boolean} required @returns {Field} */
function booleanField(name, schema, required) {
  if (required) {
    const input = /** @type {HTMLInputElement} */ (h('input', { id: uid('f'), type: 'checkbox', checked: schema.default === true }));
    const shell = fieldShell(name, schema, required, h('div', { class: 'bool-field' }, input, h('span', { class: 'muted' }, 'true when checked')));
    return {
      element: shell.element,
      read: () => ({ present: true, value: input.checked }),
      write(value) {
        input.checked = value === true;
      },
      focus: () => input.focus(),
      isEmpty: () => !input.checked,
    };
  }
  const select = /** @type {HTMLSelectElement} */ (h('select', { id: uid('f') },
    h('option', { value: '' }, schema.default !== undefined ? `(not set — default ${schema.default})` : '(not set)'),
    h('option', { value: 'true' }, 'true'),
    h('option', { value: 'false' }, 'false')));
  const shell = fieldShell(name, schema, required, select);
  return {
    element: shell.element,
    read: () => (select.value === '' ? { present: false } : { present: true, value: select.value === 'true' }),
    write(value) {
      select.value = value === true ? 'true' : value === false ? 'false' : '';
    },
    focus: () => select.focus(),
    isEmpty: () => select.value === '',
  };
}

/** @param {string} name @param {any} schema @param {boolean} required @param {any[]} values @returns {Field} */
function enumField(name, schema, required, values) {
  const select = /** @type {HTMLSelectElement} */ (h('select', { id: uid('f') },
    required && values.length === 1 ? null : h('option', { value: '' }, schema.default !== undefined ? `(not set — default ${JSON.stringify(schema.default)})` : '(not set)'),
    values.map((v, i) => h('option', { value: String(i) }, typeof v === 'string' ? v : JSON.stringify(v)))));
  const shell = fieldShell(name, schema, required, select);
  select.addEventListener('change', () => shell.setError(undefined));
  return {
    element: shell.element,
    read() {
      if (select.value === '') {
        return required ? fail(shell, 'Required') : { present: false };
      }
      shell.setError(undefined);
      return { present: true, value: values[Number(select.value)] };
    },
    write(value) {
      const index = values.findIndex((v) => JSON.stringify(v) === JSON.stringify(value));
      select.value = index >= 0 ? String(index) : required && values.length === 1 ? '0' : '';
    },
    focus: () => select.focus(),
    isEmpty: () => select.value === '' || (required && values.length === 1),
  };
}

/** @param {string} name @param {any} schema @param {boolean} required @param {any} root @param {number} depth @returns {Field} */
function objectField(name, schema, required, root, depth) {
  const inner = createObjectFields(schema, root, depth + 1);
  const error = h('span', { class: 'field-error hidden' });
  const element = h('fieldset', null,
    h('legend', null, name, required ? h('span', { class: 'req' }, ' *') : null, ' ', h('span', { class: 'type-tag' }, 'object')),
    schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
    inner.element,
    error);
  return {
    element,
    read() {
      if (!required && inner.isEmpty()) {
        // An optional object left completely blank is omitted, even if it has required children.
        element.querySelectorAll('.field-error').forEach((e) => e.classList.add('hidden'));
        element.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
        error.classList.add('hidden');
        return { present: false };
      }
      /** @type {string[]} */
      const errors = [];
      const value = inner.readAll(errors, '');
      error.textContent = errors.length ? `${errors.length} invalid field(s)` : '';
      error.classList.toggle('hidden', !errors.length);
      if (errors.length) {
        return { present: false, error: errors.join('; ') };
      }
      if (!Object.keys(value).length && !required) {
        return { present: false };
      }
      return { present: true, value };
    },
    write(value) {
      inner.write(isPlainObject(value) ? value : {});
    },
    focus: () => inner.focus(),
    isEmpty: () => inner.isEmpty(),
  };
}

/** Free-form JSON input for arrays, unions and untyped values. @returns {Field} */
function jsonField(/** @type {string} */ name, /** @type {any} */ schema, /** @type {boolean} */ required) {
  const example = schema.type === 'array' ? exampleArray(schema) : schema.type === 'object' ? '{ "key": "value" }' : 'JSON value';
  const input = /** @type {HTMLTextAreaElement} */ (autoGrow(h('textarea', {
    id: uid('f'),
    class: 'code',
    rows: 2,
    spellcheck: 'false',
    placeholder: schema.default !== undefined ? JSON.stringify(schema.default) : example,
  })));
  const shell = fieldShell(name, schema, required, input);
  input.addEventListener('input', () => shell.setError(undefined));
  const strict = schema.type === 'array' || schema.type === 'object' || schema.type === 'number' || schema.type === 'integer';
  return {
    element: shell.element,
    read() {
      const raw = input.value.trim();
      if (raw === '') {
        return required ? fail(shell, 'Required') : { present: false };
      }
      try {
        const value = JSON.parse(raw);
        if (schema.type === 'array' && !Array.isArray(value)) {
          return fail(shell, 'Expected a JSON array, e.g. ' + example);
        }
        if (schema.type === 'object' && !isPlainObject(value)) {
          return fail(shell, 'Expected a JSON object');
        }
        shell.setError(undefined);
        return { present: true, value };
      } catch (err) {
        if (!strict) {
          // Untyped / union values that are not JSON are sent as plain strings.
          shell.setError(undefined);
          return { present: true, value: input.value };
        }
        return fail(shell, `Invalid JSON: ${/** @type {Error} */ (err).message}`);
      }
    },
    write(value) {
      input.value = value === undefined ? '' : typeof value === 'string' && !strict ? value : prettyJson(value);
      input.dispatchEvent(new Event('input'));
    },
    focus: () => input.focus(),
    isEmpty: () => input.value.trim() === '',
  };
}

/** @param {any} schema */
function exampleArray(schema) {
  const itemType = schema.items && typeof schema.items === 'object' ? schema.items.type : undefined;
  switch (itemType) {
    case 'string':
      return '["first", "second"]';
    case 'number':
    case 'integer':
      return '[1, 2, 3]';
    case 'boolean':
      return '[true, false]';
    case 'object':
      return '[{ "key": "value" }]';
    default:
      return '[ ... ]';
  }
}

/** @param {{ setError(message?: string): void }} shell @param {string} message @returns {ReadResult} */
function fail(shell, message) {
  shell.setError(message);
  return { present: false, error: message };
}
