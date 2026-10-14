// @ts-check
/* Builds an input form from a JSON Schema (tool inputSchema). Depends on common.js and, for JSON
   inputs, dist/webview/jsonEditor.js (window.McpJsonEditor). */

/**
 * @typedef {{ present: boolean, value?: any, error?: string }} ReadResult
 * @typedef {{ element: HTMLElement, read(): ReadResult, write(value: any): void, focus(): void, isEmpty(): boolean, dispose?(): void }} Field
 * @typedef {{ root: any, validate?: (text: string, schema: any) => Promise<any[]>, onSubmit?: () => void }} FormContext
 * @typedef {{ bare?: boolean }} FieldOptions  bare: no label row (array items)
 */

const MAX_DEPTH = 6;

/**
 * @param {any} schema root object schema
 * @param {Record<string, any> | undefined} initial
 * @param {{ validate?: FormContext['validate'], onSubmit?: () => void }} [options]
 */
function createSchemaForm(schema, initial, options = {}) {
  const root = schema || {};
  /** @type {FormContext} */
  const ctx = { root, validate: options.validate, onSubmit: options.onSubmit };
  const objectField = createObjectFields(root, ctx, 0);
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
    dispose() {
      objectField.dispose();
    },
  };
}

/** Explicitly open-ended object without declared properties, e.g. { additionalProperties: {...} }. @param {any} schema */
function acceptsExtraProperties(schema) {
  return !schema.properties && (schema.additionalProperties === true || isPlainObject(schema.additionalProperties));
}

/**
 * Fields for an object's properties.
 * @param {any} schema
 * @param {FormContext} ctx
 * @param {number} depth
 * @param {Set<string>} [skip] properties not to render (e.g. a union's discriminator)
 */
function createObjectFields(schema, ctx, depth, skip) {
  const properties = schema.properties || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  /** @type {[string, Field][]} */
  const fields = Object.entries(properties)
    .filter(([name]) => !skip?.has(name))
    .map(([name, propSchema]) => [name, createField(name, propSchema, required.has(name), ctx, depth)]);
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
    /** Values that can be read without validation errors (used when switching variants). */
    readLenient() {
      /** @type {Record<string, any>} */
      const value = {};
      for (const [name, field] of fields) {
        const result = field.read();
        if (result.present) value[name] = result.value;
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
    dispose() {
      fields.forEach(([, field]) => field.dispose?.());
    },
  };
}

/**
 * @param {string} name
 * @param {any} rawSchema
 * @param {boolean} required
 * @param {FormContext} ctx
 * @param {number} depth
 * @param {FieldOptions} [options]
 * @returns {Field}
 */
function createField(name, rawSchema, required, ctx, depth, options = {}) {
  const schema = normalizeSchema(rawSchema, ctx.root);
  const type = schema.type;
  const enumValues = Array.isArray(schema.enum) ? schema.enum : schema.const !== undefined ? [schema.const] : null;

  if (enumValues) {
    return enumField(name, schema, required, enumValues, options);
  }
  if (objectVariants(schema, ctx.root) && depth < MAX_DEPTH) {
    return unionField(name, schema, required, ctx, depth, options);
  }
  if (type === 'boolean') {
    return booleanField(name, schema, required, options);
  }
  if (type === 'number' || type === 'integer') {
    return numberField(name, schema, required, options);
  }
  if (type === 'string') {
    return stringField(name, schema, required, options);
  }
  if (type === 'object' && schema.properties && Object.keys(schema.properties).length && depth < MAX_DEPTH) {
    return objectField(name, schema, required, ctx, depth, options);
  }
  if (type === 'array' && depth < MAX_DEPTH && arrayItemsRenderable(schema, ctx.root)) {
    return arrayField(name, schema, required, ctx, depth, options);
  }
  return jsonField(name, schema, required, ctx, options);
}

/**
 * Resolves local $refs and simplifies nullable unions so the right widget can be picked.
 * @param {any} schema
 * @param {any} root
 */
function normalizeSchema(schema, root) {
  let s = resolveRef(schema, root);
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

/** @param {any} schema @param {any} root */
function resolveRef(schema, root) {
  let s = schema && typeof schema === 'object' ? schema : {};
  for (let i = 0; i < 8 && typeof s.$ref === 'string' && s.$ref.startsWith('#'); i++) {
    const target = s.$ref === '#'
      ? root
      : s.$ref
        .slice(2)
        .split('/')
        .reduce((/** @type {any} */ node, /** @type {string} */ part) => (node ? node[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
    if (!target) {
      break;
    }
    const { $ref, ...rest } = s;
    s = { ...target, ...rest };
  }
  return s;
}

/**
 * Object variants of a oneOf/anyOf with their discriminator, or null when the union is not a set
 * of objects (those are edited as JSON).
 * @param {any} schema normalized schema
 * @param {any} root
 * @returns {{ variants: any[], key: string | undefined } | null}
 */
function objectVariants(schema, root) {
  const union = schema.oneOf || schema.anyOf;
  if (!Array.isArray(union)) {
    return null;
  }
  const { oneOf, anyOf, ...base } = schema;
  const variants = union
    .map((/** @type {any} */ v) => normalizeSchema(v, root))
    .filter((/** @type {any} */ v) => v.type !== 'null')
    .map((/** @type {any} */ v) => ({
      ...base,
      ...v,
      properties: { ...(base.properties || {}), ...(v.properties || {}) },
      required: [...new Set([...(base.required || []), ...(v.required || [])])],
    }));
  if (variants.length < 2 || !variants.every((/** @type {any} */ v) => (v.type === 'object' || v.type === undefined) && Object.keys(v.properties).length)) {
    return null;
  }
  const first = Object.keys(variants[0].properties);
  const key = first.find((k) => variants.every((/** @type {any} */ v) => v.properties[k] && constValue(normalizeSchema(v.properties[k], root)) !== undefined));
  return { variants, key };
}

/** @param {any} schema */
function constValue(schema) {
  if ('const' in schema) return { value: schema.const };
  if (Array.isArray(schema.enum) && schema.enum.length === 1) return { value: schema.enum[0] };
  return undefined;
}

/** @param {any} schema @param {any} root */
function arrayItemsRenderable(schema, root) {
  if (!isPlainObject(schema.items) || Array.isArray(schema.prefixItems)) {
    return false;
  }
  const items = normalizeSchema(schema.items, root);
  if (Array.isArray(items.enum) || items.const !== undefined || objectVariants(items, root)) {
    return true;
  }
  if (['string', 'number', 'integer', 'boolean'].includes(items.type)) {
    return true;
  }
  return items.type === 'object' && isPlainObject(items.properties) && Object.keys(items.properties).length > 0;
}

/** @param {any} schema @param {any} root */
function typeLabel(schema, root) {
  if (Array.isArray(schema.enum)) {
    return 'enum';
  }
  if (schema.type === 'array') {
    const raw = schema.items && typeof schema.items === 'object' ? schema.items : undefined;
    if (raw?.$ref) {
      return `${String(raw.$ref).split('/').pop()}[]`;
    }
    const items = raw ? normalizeSchema(raw, root) : undefined;
    const union = items && (items.oneOf || items.anyOf);
    if (Array.isArray(union)) {
      return `array · ${union.length} kinds`;
    }
    return items?.type ? `${items.type}[]` : 'array';
  }
  if (schema.oneOf || schema.anyOf) {
    return 'one of';
  }
  if (schema.type) {
    const base = schema.format ? `${schema.type} · ${schema.format}` : schema.type;
    return schema.nullable ? `${base} | null` : base;
  }
  if (schema.typeList?.length) {
    return schema.typeList.join(' | ');
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
  if (hasDefault(schema)) parts.push(`default ${JSON.stringify(schema.default)}`);
  return parts.join(' · ');
}

/** A meaningful default (null defaults only say "may be omitted"). @param {any} schema */
function hasDefault(schema) {
  return schema.default !== undefined && schema.default !== null;
}

/**
 * Common label / description / error chrome around an input.
 * @param {string} name @param {any} schema @param {boolean} required @param {HTMLElement} control @param {FieldOptions} [options]
 */
function fieldShell(name, schema, required, control, options = {}) {
  const error = h('span', { class: 'field-error hidden' });
  const hint = constraintHint(schema);
  const element = h('div', { class: 'field' },
    options.bare
      ? null
      : h('label', { class: 'field-label', for: control.id || undefined },
        h('span', null, schema.title && schema.title !== name ? `${schema.title} (${name})` : name),
        required ? h('span', { class: 'req', title: 'Required' }, '*') : null,
        h('span', { class: 'type-tag' }, typeLabel(schema, null))),
    !options.bare && schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
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

/** @param {string} name @param {any} schema @param {boolean} required @param {FieldOptions} [options] @returns {Field} */
function stringField(name, schema, required, options) {
  const input = /** @type {HTMLTextAreaElement} */ (autoGrow(h('textarea', {
    id: uid('f'),
    rows: 1,
    placeholder: hasDefault(schema) ? String(schema.default) : schema.examples?.[0] !== undefined ? `e.g. ${schema.examples[0]}` : '',
    spellcheck: 'false',
    'aria-label': options?.bare ? name : undefined,
  })));
  const shell = fieldShell(name, schema, required, input, options);
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

/** @param {string} name @param {any} schema @param {boolean} required @param {FieldOptions} [options] @returns {Field} */
function numberField(name, schema, required, options) {
  const integer = schema.type === 'integer';
  const input = /** @type {HTMLInputElement} */ (h('input', {
    id: uid('f'),
    type: 'number',
    step: integer ? '1' : 'any',
    min: schema.minimum,
    max: schema.maximum,
    placeholder: hasDefault(schema) ? String(schema.default) : '',
    'aria-label': options?.bare ? name : undefined,
  }));
  const shell = fieldShell(name, schema, required, input, options);
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

/** @param {string} name @param {any} schema @param {boolean} required @param {FieldOptions} [options] @returns {Field} */
function booleanField(name, schema, required, options) {
  if (required) {
    const input = /** @type {HTMLInputElement} */ (h('input', { id: uid('f'), type: 'checkbox', checked: schema.default === true }));
    const shell = fieldShell(name, schema, required, h('div', { class: 'bool-field' }, input, h('span', { class: 'muted' }, 'true when checked')), options);
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
    h('option', { value: '' }, hasDefault(schema) ? `(not set — default ${schema.default})` : '(not set)'),
    h('option', { value: 'true' }, 'true'),
    h('option', { value: 'false' }, 'false')));
  const shell = fieldShell(name, schema, required, select, options);
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

/** @param {string} name @param {any} schema @param {boolean} required @param {any[]} values @param {FieldOptions} [options] @returns {Field} */
function enumField(name, schema, required, values, options) {
  const select = /** @type {HTMLSelectElement} */ (h('select', { id: uid('f') },
    required && values.length === 1 ? null : h('option', { value: '' }, hasDefault(schema) ? `(not set — default ${JSON.stringify(schema.default)})` : '(not set)'),
    values.map((v, i) => h('option', { value: String(i) }, typeof v === 'string' ? v : JSON.stringify(v)))));
  const shell = fieldShell(name, schema, required, select, options);
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

/**
 * Nested object in a fieldset (or bare, inside an array item).
 * @param {string} name @param {any} schema @param {boolean} required @param {FormContext} ctx @param {number} depth @param {FieldOptions} [options]
 * @returns {Field}
 */
function objectField(name, schema, required, ctx, depth, options = {}) {
  const inner = createObjectFields(schema, ctx, depth + 1);
  const error = h('span', { class: 'field-error hidden' });
  const element = options.bare
    ? h('div', { class: 'stack' }, inner.element, error)
    : h('fieldset', null,
      h('legend', null, name, required ? h('span', { class: 'req' }, ' *') : null, ' ', h('span', { class: 'type-tag' }, 'object')),
      schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
      inner.element,
      error);
  return {
    element,
    read() {
      if (!required && !options.bare && inner.isEmpty()) {
        // An optional object left completely blank is omitted, even if it has required children.
        clearErrors(element);
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
      if (!Object.keys(value).length && !required && !options.bare) {
        return { present: false };
      }
      return { present: true, value };
    },
    write(value) {
      inner.write(isPlainObject(value) ? value : {});
    },
    focus: () => inner.focus(),
    isEmpty: () => inner.isEmpty(),
    dispose: () => inner.dispose(),
  };
}

/**
 * A oneOf/anyOf of objects: a variant selector (by discriminator such as "type") plus the
 * selected variant's fields.
 * @param {string} name @param {any} schema @param {boolean} required @param {FormContext} ctx @param {number} depth @param {FieldOptions} [options]
 * @returns {Field}
 */
function unionField(name, schema, required, ctx, depth, options = {}) {
  const { variants, key } = /** @type {{ variants: any[], key: string | undefined }} */ (objectVariants(schema, ctx.root));
  const labelOf = (/** @type {any} */ v, /** @type {number} */ i) => {
    const discriminator = key ? constValue(normalizeSchema(v.properties[key], ctx.root)) : undefined;
    if (discriminator) return String(discriminator.value);
    return v.title || (v.description ? String(v.description).split('\n')[0].slice(0, 60) : `Option ${i + 1}`);
  };
  const selectable = !options.bare && !required;
  const select = /** @type {HTMLSelectElement} */ (h('select', { id: uid('f'), class: 'variant-select', 'aria-label': key ? `${name} ${key}` : `${name} variant` },
    selectable ? h('option', { value: '' }, '(not set)') : null,
    variants.map((v, i) => h('option', { value: String(i) }, labelOf(v, i)))));
  const variantHint = h('span', { class: 'hint description' });
  const body = h('div', { class: 'stack' });
  const error = h('span', { class: 'field-error hidden' });
  /** @type {ReturnType<typeof createObjectFields> | null} */
  let inner = null;

  const render = (/** @type {Record<string, any>} */ carry) => {
    inner?.dispose();
    inner = null;
    const index = select.value === '' ? -1 : Number(select.value);
    const variant = variants[index];
    variantHint.textContent = variant?.description || '';
    variantHint.classList.toggle('hidden', !variant?.description);
    if (!variant) {
      setChildren(body);
      return;
    }
    inner = createObjectFields(variant, ctx, depth + 1, key ? new Set([key]) : undefined);
    inner.write(carry);
    setChildren(body, inner.count ? inner.element : h('p', { class: 'empty-state' }, 'No other fields.'));
  };
  select.addEventListener('change', () => {
    error.classList.add('hidden');
    render(inner ? inner.readLenient() : {});
  });

  const header = h('div', { class: 'variant-row' },
    key ? h('span', { class: 'variant-key' }, key) : h('span', { class: 'variant-key' }, 'shape'),
    select);
  const element = options.bare
    ? h('div', { class: 'stack' }, header, variantHint, body, error)
    : h('fieldset', null,
      h('legend', null, name, required ? h('span', { class: 'req' }, ' *') : null, ' ', h('span', { class: 'type-tag' }, `one of ${variants.length}`)),
      schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
      header, variantHint, body, error);
  render({});

  return {
    element,
    read() {
      const index = select.value === '' ? -1 : Number(select.value);
      if (index < 0 || !inner) {
        clearErrors(element);
        return required ? { present: false, error: 'Required' } : { present: false };
      }
      /** @type {string[]} */
      const errors = [];
      const value = inner.readAll(errors, '');
      error.textContent = errors.length ? `${errors.length} invalid field(s)` : '';
      error.classList.toggle('hidden', !errors.length);
      if (errors.length) {
        return { present: false, error: errors.join('; ') };
      }
      if (key) {
        const discriminator = /** @type {{ value: any }} */ (constValue(normalizeSchema(variants[index].properties[key], ctx.root))).value;
        return { present: true, value: { [key]: discriminator, ...value } };
      }
      return { present: true, value };
    },
    write(value) {
      let index = -1;
      if (isPlainObject(value)) {
        if (key && key in value) {
          index = variants.findIndex((v) => JSON.stringify(constValue(normalizeSchema(v.properties[key], ctx.root))?.value) === JSON.stringify(value[key]));
        }
        if (index < 0) {
          // No discriminator: pick the variant sharing the most properties with the value.
          let best = 0;
          variants.forEach((v, i) => {
            const score = Object.keys(value).filter((k) => k in v.properties).length;
            if (score > best) {
              best = score;
              index = i;
            }
          });
        }
      }
      select.value = index >= 0 ? String(index) : selectable ? '' : '0';
      render(isPlainObject(value) ? value : {});
    },
    focus: () => select.focus(),
    isEmpty: () => select.value === '',
    dispose: () => inner?.dispose(),
  };
}

/**
 * List of items with add / remove / reorder; items use the item schema's widgets.
 * @param {string} name @param {any} schema @param {boolean} required @param {FormContext} ctx @param {number} depth @param {FieldOptions} [options]
 * @returns {Field}
 */
function arrayField(name, schema, required, ctx, depth, options = {}) {
  const itemSchema = normalizeSchema(schema.items, ctx.root);
  const union = objectVariants(itemSchema, ctx.root);
  // Strings, numbers, booleans and enums get a one-line row instead of a card.
  const compact = !union && itemSchema.type !== 'object' && itemSchema.type !== 'array';
  const list = h('div', { class: 'array-items' });
  const count = h('span', { class: 'badge outline' }, '0');
  const error = h('span', { class: 'field-error hidden' });
  /** @type {{ field: Field, element: HTMLElement }[]} */
  const items = [];

  const refresh = () => {
    count.textContent = String(items.length);
    items.forEach((item, i) => {
      /** @type {HTMLElement} */ (item.element.querySelector('.item-index')).textContent = `#${i + 1}`;
      /** @type {HTMLButtonElement} */ (item.element.querySelector('[data-move="up"]')).disabled = i === 0;
      /** @type {HTMLButtonElement} */ (item.element.querySelector('[data-move="down"]')).disabled = i === items.length - 1;
    });
    setChildren(list, items.length ? items.map((item) => item.element) : h('div', { class: 'kv-empty' }, 'No items'));
  };

  const move = (/** @type {object} */ entry, /** @type {number} */ delta) => {
    const from = items.findIndex((item) => item === entry);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= items.length) return;
    [items[from], items[to]] = [items[to], items[from]];
    refresh();
  };

  /** @param {any} [value] @param {boolean} [focus] */
  const addItem = (value, focus) => {
    const field = createField(`${name}[]`, schema.items, true, ctx, depth + 1, { bare: true });
    if (value !== undefined) {
      field.write(value);
    }
    /** @type {{ field: Field, element: HTMLElement }} */
    const entry = { field, element: h('div') };
    const buttons = [
      h('button', { type: 'button', class: 'ghost icon', 'data-move': 'up', title: 'Move up', 'aria-label': 'Move up', onclick: () => move(entry, -1) }, '↑'),
      h('button', { type: 'button', class: 'ghost icon', 'data-move': 'down', title: 'Move down', 'aria-label': 'Move down', onclick: () => move(entry, 1) }, '↓'),
      h('button', {
        type: 'button',
        class: 'ghost icon',
        title: 'Remove',
        'aria-label': 'Remove item',
        onclick: () => {
          const index = items.indexOf(entry);
          if (index >= 0) {
            items.splice(index, 1);
            field.dispose?.();
            refresh();
          }
        },
      }, '✕'),
    ];
    entry.element = compact
      ? h('div', { class: 'array-item compact' }, h('span', { class: 'item-index' }), field.element, buttons)
      : h('div', { class: 'array-item' },
        h('div', { class: 'array-item-head' }, h('span', { class: 'item-index' }), h('span', { class: 'spacer' }), buttons),
        field.element);
    items.push(entry);
    refresh();
    if (focus) {
      field.focus();
    }
  };

  // Union items: pick the variant up front ("+ Add click"); otherwise a plain add button.
  const adder = union && union.key
    ? /** @type {HTMLSelectElement} */ (h('select', {
      class: 'array-add-select',
      'aria-label': `Add ${name} item`,
      onchange: (/** @type {any} */ e) => {
        const index = Number(e.target.value);
        if (e.target.value !== '') {
          const variant = union.variants[index];
          const key = /** @type {string} */ (union.key);
          addItem({ [key]: constValue(normalizeSchema(variant.properties[key], ctx.root))?.value }, true);
        }
        e.target.value = '';
      },
    },
    h('option', { value: '' }, '+ Add item…'),
    union.variants.map((v, i) => h('option', { value: String(i) }, `${String(constValue(normalizeSchema(v.properties[/** @type {string} */ (union.key)], ctx.root))?.value)}${v.description ? ` — ${String(v.description).split('\n')[0].slice(0, 50)}` : ''}`))))
    : h('button', { type: 'button', class: 'ghost', onclick: () => addItem(undefined, true) }, '+ Add item');

  const element = h('fieldset', { class: 'array-field' },
    options.bare ? null : h('legend', null, name, required ? h('span', { class: 'req' }, ' *') : null, ' ', h('span', { class: 'type-tag' }, typeLabel(schema, ctx.root)), ' ', count),
    !options.bare && schema.description ? h('span', { class: 'hint description' }, schema.description) : null,
    list,
    h('div', { class: 'actions' }, adder),
    constraintHint(schema) ? h('span', { class: 'hint' }, constraintHint(schema)) : null,
    error);
  refresh();

  return {
    element,
    read() {
      if (!items.length) {
        clearErrors(element);
        return required ? { present: true, value: [] } : { present: false };
      }
      /** @type {string[]} */
      const errors = [];
      const value = [];
      items.forEach((item, i) => {
        const result = item.field.read();
        if (result.error) {
          errors.push(`#${i + 1}: ${result.error}`);
        } else {
          value.push(result.present ? result.value : null);
        }
      });
      error.textContent = errors.length ? `${errors.length} invalid item(s)` : '';
      error.classList.toggle('hidden', !errors.length);
      return errors.length ? { present: false, error: errors.join('; ') } : { present: true, value };
    },
    write(value) {
      items.splice(0).forEach((item) => item.field.dispose?.());
      for (const item of Array.isArray(value) ? value : []) {
        addItem(item, false);
      }
      refresh();
    },
    focus: () => (items[0] ? items[0].field.focus() : /** @type {HTMLElement} */ (adder).focus()),
    isEmpty: () => items.length === 0,
    dispose: () => items.forEach((item) => item.field.dispose?.()),
  };
}

/**
 * Free-form JSON input for unions of primitives and untyped values, with schema-aware completion.
 * @param {string} name @param {any} schema @param {boolean} required @param {FormContext} ctx @param {FieldOptions} [options]
 * @returns {Field}
 */
function jsonField(name, schema, required, ctx, options) {
  const example = schema.type === 'array' ? exampleArray(schema) : schema.type === 'object' ? '{ "key": "value" }' : 'JSON value';
  const host = h('div', { class: 'json-host', id: uid('f') });
  const shell = fieldShell(name, schema, required, host, options);
  // Keep $defs so $refs inside the field's schema still resolve for completion and validation.
  const { nullable, typeList, ...clean } = schema;
  const editorSchema = { $schema: ctx.root.$schema, $defs: ctx.root.$defs, definitions: ctx.root.definitions, ...clean };
  const editor = createEditor(host, {
    value: '',
    schema: editorSchema,
    placeholder: hasDefault(schema) ? JSON.stringify(schema.default) : example,
    ariaLabel: name,
    lineNumbers: false,
    minHeight: '32px',
    maxHeight: '320px',
    validate: ctx.validate,
    onSubmit: ctx.onSubmit,
    onChange: () => shell.setError(undefined),
  });
  const strict = schema.type === 'array' || schema.type === 'object' || schema.type === 'number' || schema.type === 'integer';
  return {
    element: shell.element,
    read() {
      const raw = editor.getValue().trim();
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
          return { present: true, value: editor.getValue() };
        }
        return fail(shell, `Invalid JSON: ${/** @type {Error} */ (err).message}`);
      }
    },
    write(value) {
      editor.setValue(value === undefined ? '' : typeof value === 'string' && !strict ? value : prettyJson(value));
    },
    focus: () => editor.focus(),
    isEmpty: () => editor.getValue().trim() === '',
    dispose: () => editor.destroy(),
  };
}

/**
 * Creates a JSON editor, or a plain textarea when the editor bundle is unavailable.
 * @param {HTMLElement} host
 * @param {any} options
 * @returns {{ getValue(): string, setValue(text: string): void, focus(): void, destroy(): void, setSchema?(schema: any): void }}
 */
function createEditor(host, options) {
  const factory = /** @type {any} */ (window).McpJsonEditor;
  if (factory) {
    return factory.create(host, options);
  }
  const textarea = /** @type {HTMLTextAreaElement} */ (autoGrow(h('textarea', { class: 'code', rows: 2, spellcheck: 'false', placeholder: options.placeholder || '' })));
  textarea.value = options.value || '';
  textarea.addEventListener('input', () => options.onChange?.(textarea.value));
  host.append(textarea);
  return {
    getValue: () => textarea.value,
    setValue(text) {
      textarea.value = text;
      textarea.dispatchEvent(new Event('input'));
    },
    focus: () => textarea.focus(),
    destroy: () => textarea.remove(),
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

/** @param {HTMLElement} element */
function clearErrors(element) {
  element.querySelectorAll('.field-error').forEach((e) => e.classList.add('hidden'));
  element.querySelectorAll('.invalid').forEach((e) => e.classList.remove('invalid'));
}

/** @param {{ setError(message?: string): void }} shell @param {string} message @returns {ReadResult} */
function fail(shell, message) {
  shell.setError(message);
  return { present: false, error: message };
}
