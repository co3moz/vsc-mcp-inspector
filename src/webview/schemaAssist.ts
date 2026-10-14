// JSON Schema helpers for the webview JSON editor: resolving the schema at a JSON path,
// completion suggestions and hover text. Pure functions, no DOM or CodeMirror dependency.

export type Schema = Record<string, any>;
export type PathSegment = string | number;

export interface Suggestion {
  label: string;
  /** Short type hint shown next to the label. */
  detail?: string;
  /** Longer description shown in the completion info panel. */
  info?: string;
  /** CodeMirror snippet template (`${1:text}` fields). */
  snippet: string;
  kind: 'property' | 'value' | 'variant';
  boost?: number;
}

const MAX_REF_HOPS = 16;

/** Follows local `$ref`s (`#/$defs/...`, `#/definitions/...`), keeping keywords next to the ref. */
export function resolve(schema: unknown, root: Schema): Schema {
  let current: Schema = isObject(schema) ? schema : {};
  for (let i = 0; i < MAX_REF_HOPS && typeof current.$ref === 'string'; i++) {
    const target = lookupPointer(root, current.$ref);
    if (!isObject(target)) {
      break;
    }
    const { $ref: _ref, ...rest } = current;
    current = { ...target, ...rest };
  }
  return current;
}

function lookupPointer(root: Schema, ref: string): unknown {
  if (ref === '#') {
    return root;
  }
  if (!ref.startsWith('#/')) {
    return undefined;
  }
  return ref
    .slice(2)
    .split('/')
    .map((part) => decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'))
    .reduce<unknown>((node, part) => (isObject(node) || Array.isArray(node) ? (node as Record<string, unknown>)[part] : undefined), root);
}

/** The single-valued `const`/`enum` of a schema, if any. */
export function constOf(schema: Schema): { value: unknown } | undefined {
  if ('const' in schema) {
    return { value: schema.const };
  }
  if (Array.isArray(schema.enum) && schema.enum.length === 1) {
    return { value: schema.enum[0] };
  }
  return undefined;
}

/** Types a schema allows, `[]` when unconstrained. */
export function typesOf(schema: Schema): string[] {
  if (Array.isArray(schema.type)) {
    return schema.type;
  }
  if (typeof schema.type === 'string') {
    return [schema.type];
  }
  if (schema.properties || schema.required) {
    return ['object'];
  }
  if (schema.items || schema.prefixItems) {
    return ['array'];
  }
  return [];
}

/** Variants of a `oneOf`/`anyOf`, resolved, without the `null` branch. */
export function variantsOf(schema: Schema, root: Schema): Schema[] | undefined {
  const union = schema.oneOf ?? schema.anyOf;
  if (!Array.isArray(union)) {
    return undefined;
  }
  const { oneOf: _o, anyOf: _a, ...base } = schema;
  return union
    .map((variant) => merge(base, resolve(variant, root)))
    .filter((variant) => !(typesOf(variant).length === 1 && typesOf(variant)[0] === 'null'));
}

/** Property that has a constant value in every variant, e.g. `type` in `{ type: "click", ... }`. */
export function discriminatorOf(variants: Schema[], root: Schema): string | undefined {
  if (variants.length < 2 || !variants.every((v) => isObject(v.properties))) {
    return undefined;
  }
  const candidates = Object.keys(variants[0].properties);
  return candidates.find((key) => variants.every((v) => v.properties[key] && constOf(resolve(v.properties[key], root))));
}

/**
 * Expands a schema into the concrete alternatives that apply to `value`: resolves refs, merges
 * `allOf` and splits unions, keeping only the variants whose discriminator matches `value`.
 */
export function expand(schema: unknown, root: Schema, value?: unknown, depth = 0): Schema[] {
  const resolved = resolve(schema, root);
  if (depth > 8) {
    return [resolved];
  }
  let current = resolved;
  if (Array.isArray(current.allOf)) {
    const { allOf, ...rest } = current;
    current = allOf.reduce<Schema>((acc, part) => merge(acc, resolve(part, root)), rest);
  }
  const variants = variantsOf(current, root);
  if (!variants) {
    return [current];
  }
  let chosen = variants;
  const key = discriminatorOf(variants, root);
  if (key && isObject(value) && key in value) {
    const matching = variants.filter((v) => deepEqual(constOf(resolve(v.properties[key], root))?.value, value[key]));
    if (matching.length) {
      chosen = matching;
    }
  }
  return chosen.flatMap((variant) => expand(variant, root, value, depth + 1));
}

/** Schemas that apply at `path` inside a document whose (partial) value is `doc`. */
export function schemasAt(root: Schema, path: PathSegment[], doc: unknown): Schema[] {
  let candidates = expand(root, root, doc);
  let value = doc;
  for (const segment of path) {
    value = isObject(value) || Array.isArray(value) ? (value as Record<string | number, unknown>)[segment] : undefined;
    const next: Schema[] = [];
    for (const schema of candidates) {
      const child = childSchema(schema, segment);
      if (child !== undefined) {
        next.push(...expand(child, root, value));
      }
    }
    candidates = next;
  }
  return candidates;
}

/** Raw (unresolved) schema of a property or array item. */
export function childSchema(schema: Schema, segment: PathSegment): unknown {
  if (typeof segment === 'number') {
    if (Array.isArray(schema.prefixItems) && segment < schema.prefixItems.length) {
      return schema.prefixItems[segment];
    }
    if (isObject(schema.items)) {
      return schema.items;
    }
    return Array.isArray(schema.items) ? schema.items[segment] ?? schema.additionalItems : undefined;
  }
  if (isObject(schema.properties) && segment in schema.properties) {
    return schema.properties[segment];
  }
  if (isObject(schema.patternProperties)) {
    for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      try {
        if (new RegExp(pattern, 'u').test(segment)) {
          return child;
        }
      } catch {
        // invalid pattern
      }
    }
  }
  return isObject(schema.additionalProperties) ? schema.additionalProperties : undefined;
}

/** Property name suggestions for an object at a position whose schemas are `schemas`. */
export function propertySuggestions(schemas: Schema[], root: Schema, existing: Set<string>): Suggestion[] {
  const seen = new Map<string, Suggestion>();
  for (const schema of schemas) {
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    for (const [name, raw] of Object.entries<unknown>(isObject(schema.properties) ? schema.properties : {})) {
      if (existing.has(name) || seen.has(name)) {
        continue;
      }
      const child = expand(raw, root)[0] ?? {};
      seen.set(name, {
        label: name,
        detail: typeLabel(child) + (required.has(name) ? ' · required' : ''),
        info: describeSchema(resolve(raw, root), root),
        snippet: `${JSON.stringify(name)}: ${valueTemplate(resolve(raw, root), root, '', { next: 1 })}`,
        kind: 'property',
        boost: required.has(name) ? 2 : 0,
      });
    }
  }
  return [...seen.values()];
}

/** Value suggestions (constants, enums, booleans, templates) for a value position. */
export function valueSuggestions(schemas: Schema[], root: Schema): Suggestion[] {
  const out: Suggestion[] = [];
  const add = (suggestion: Suggestion) => {
    if (!out.some((s) => s.snippet === suggestion.snippet)) {
      out.push(suggestion);
    }
  };
  const objectVariants = schemas.filter((s) => typesOf(s).includes('object') && isObject(s.properties));
  const key = objectVariants.length > 1 ? discriminatorOf(objectVariants, root) : undefined;

  for (const schema of schemas) {
    const constant = constOf(schema);
    if (constant) {
      add({ label: JSON.stringify(constant.value), snippet: escapeSnippet(JSON.stringify(constant.value)), kind: 'value', detail: 'const', boost: 2 });
      continue;
    }
    if (Array.isArray(schema.enum)) {
      for (const value of schema.enum) {
        add({ label: JSON.stringify(value), snippet: escapeSnippet(JSON.stringify(value)), kind: 'value', detail: 'enum', boost: 1 });
      }
      continue;
    }
    const types = typesOf(schema);
    if (types.includes('object') && isObject(schema.properties)) {
      const discriminator = key ? constOf(resolve(schema.properties[key], root))?.value : undefined;
      add({
        label: discriminator !== undefined ? String(discriminator) : '{ }',
        detail: discriminator !== undefined ? `${key}: ${JSON.stringify(discriminator)}` : 'object',
        info: schema.description,
        snippet: valueTemplate(schema, root, '', { next: 1 }),
        kind: discriminator !== undefined ? 'variant' : 'value',
        boost: discriminator !== undefined ? 1 : 0,
      });
    } else if (types.includes('object')) {
      add({ label: '{ }', snippet: '{${0}}', kind: 'value', detail: 'object' });
    }
    if (types.includes('array')) {
      add({ label: '[ ]', snippet: '[${0}]', kind: 'value', detail: 'array' });
    }
    if (types.includes('boolean')) {
      add({ label: 'true', snippet: 'true', kind: 'value', detail: 'boolean' });
      add({ label: 'false', snippet: 'false', kind: 'value', detail: 'boolean' });
    }
    if (types.includes('null')) {
      add({ label: 'null', snippet: 'null', kind: 'value', detail: 'null' });
    }
    if (schema.default !== undefined && schema.default !== null) {
      add({ label: JSON.stringify(schema.default), snippet: escapeSnippet(JSON.stringify(schema.default)), kind: 'value', detail: 'default' });
    }
    if (Array.isArray(schema.examples)) {
      for (const example of schema.examples.slice(0, 5)) {
        add({ label: JSON.stringify(example), snippet: escapeSnippet(JSON.stringify(example)), kind: 'value', detail: 'example' });
      }
    }
  }
  return out;
}

/** Snippet for a value of `schema`; objects get their required properties pre-filled. */
export function valueTemplate(schema: Schema, root: Schema, indent: string, counter: { next: number }, depth = 0): string {
  const [first] = expand(schema, root);
  const s = first ?? {};
  const constant = constOf(s);
  if (constant) {
    return escapeSnippet(JSON.stringify(constant.value));
  }
  if (Array.isArray(s.enum) && s.enum.length) {
    return field(counter, escapeSnippet(JSON.stringify(s.enum[0])));
  }
  if (s.default !== undefined && s.default !== null) {
    return field(counter, escapeSnippet(JSON.stringify(s.default)));
  }
  const types = typesOf(s).filter((t) => t !== 'null');
  switch (types[0]) {
    case 'string':
      return `"${field(counter, '')}"`;
    case 'integer':
    case 'number':
      return field(counter, '0');
    case 'boolean':
      return field(counter, 'false');
    case 'array':
      return `[${field(counter, '')}]`;
    case 'object': {
      const required: string[] = Array.isArray(s.required) ? s.required : [];
      const props = isObject(s.properties) ? s.properties : {};
      const keys = required.filter((k) => k in props);
      if (!keys.length || depth > 2) {
        return `{${field(counter, '')}}`;
      }
      const inner = indent + '  ';
      const lines = keys.map((k) => `${inner}${JSON.stringify(k)}: ${valueTemplate(resolve(props[k], root), root, inner, counter, depth + 1)}`);
      return `{\n${lines.join(',\n')}\n${indent}}`;
    }
    default:
      return field(counter, 'null');
  }
}

function field(counter: { next: number }, text: string): string {
  return `\${${counter.next++}:${text}}`;
}

function escapeSnippet(text: string): string {
  return text.replace(/[{}]/g, (c) => `\\${c}`);
}

/** Plain text description of a schema for hovers and completion info. */
export function describeSchema(schema: Schema, root: Schema): string {
  const [first] = expand(schema, root);
  const s = first ?? schema;
  const lines: string[] = [];
  const description = schema.description ?? s.description;
  if (description) {
    lines.push(description);
  }
  const facts: string[] = [];
  const variants = variantsOf(resolve(schema, root), root);
  if (variants && variants.length > 1) {
    const key = discriminatorOf(variants, root);
    facts.push(
      key
        ? `one of ${key}: ${variants.map((v) => JSON.stringify(constOf(resolve(v.properties[key], root))?.value)).join(', ')}`
        : `one of ${variants.length} shapes`,
    );
  }
  if (Array.isArray(s.enum)) facts.push(`values: ${s.enum.map((v: unknown) => JSON.stringify(v)).join(', ')}`);
  if (s.default !== undefined && s.default !== null) facts.push(`default ${JSON.stringify(s.default)}`);
  if (s.minimum !== undefined) facts.push(`min ${s.minimum}`);
  if (s.maximum !== undefined) facts.push(`max ${s.maximum}`);
  if (s.minLength !== undefined) facts.push(`min length ${s.minLength}`);
  if (s.maxLength !== undefined) facts.push(`max length ${s.maxLength}`);
  if (s.pattern) facts.push(`pattern ${s.pattern}`);
  lines.push(facts.filter(Boolean).join(' · '));
  return lines.join('\n\n');
}

export function typeLabel(schema: Schema): string {
  const constant = constOf(schema);
  if (constant) {
    return `const ${JSON.stringify(constant.value)}`;
  }
  if (Array.isArray(schema.enum)) {
    return 'enum';
  }
  const types = typesOf(schema);
  if (types.includes('array') && isObject(schema.items)) {
    const union = schema.items.oneOf ?? schema.items.anyOf;
    const items = schema.items.$ref
      ? String(schema.items.$ref).split('/').pop()
      : Array.isArray(union)
        ? `(one of ${union.length})`
        : typesOf(schema.items).join(' | ') || 'any';
    return `${items}[]` + (types.includes('null') ? ' | null' : '');
  }
  const label = types.join(' | ') || (schema.$ref ? String(schema.$ref).split('/').pop()! : 'any');
  return schema.format && !types.includes('object') ? `${label} · ${schema.format}` : label;
}

function merge(base: Schema, extra: Schema): Schema {
  const out: Schema = { ...base, ...extra };
  if (isObject(base.properties) || isObject(extra.properties)) {
    out.properties = { ...(base.properties ?? {}), ...(extra.properties ?? {}) };
  }
  if (Array.isArray(base.required) || Array.isArray(extra.required)) {
    out.required = [...new Set([...(base.required ?? []), ...(extra.required ?? [])])];
  }
  return out;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
