// Validates JSON documents against tool input schemas for the webview editor's diagnostics.
// Runs in the extension host: Ajv generates code at runtime, which the webview CSP forbids.
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { childSchema, constOf, discriminatorOf, resolve, schemasAt, variantsOf, type PathSegment, type Schema } from './webview/schemaAssist';

export interface SchemaIssue {
  path: PathSegment[];
  message: string;
  target: 'value' | 'key' | 'container';
}

const MAX_CACHE = 50;
const cache = new Map<string, ValidateFunction | Error>();

function compile(schema: Schema): ValidateFunction | Error {
  const key = JSON.stringify(schema);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  let result: ValidateFunction | Error;
  try {
    const dialect = String(schema.$schema ?? '');
    const options = { allErrors: true, strict: false, validateSchema: false, logger: false } as const;
    const ajv = dialect.includes('2020-12') ? new Ajv2020(options) : dialect.includes('2019-09') ? new Ajv2019(options) : new Ajv(options);
    addFormats(ajv);
    // The dialect is already chosen; drop $schema so unknown meta-schemas don't fail compilation.
    const { $schema: _dialect, ...body } = schema;
    result = ajv.compile(body);
  } catch (err) {
    result = err instanceof Error ? err : new Error(String(err));
  }
  if (cache.size >= MAX_CACHE) {
    cache.delete(cache.keys().next().value!);
  }
  cache.set(key, result);
  return result;
}

/** Schema issues of `text`; empty when it is valid, not JSON, or the schema cannot be compiled. */
export function validateJson(schema: Schema, text: string): SchemaIssue[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const validate = compile(schema);
  if (validate instanceof Error || validate(data)) {
    return [];
  }
  return toIssues(validate.errors ?? [], data, schema);
}

/**
 * Converts Ajv errors into editor issues. For `oneOf`/`anyOf` failures it keeps only the errors of
 * the variant selected by the discriminator (e.g. `"type": "click"`) instead of every variant's.
 */
export function toIssues(errors: ErrorObject[], data: unknown, root: Schema): SchemaIssue[] {
  let remaining = [...errors];
  const unionFailures = errors
    .filter((e) => e.keyword === 'oneOf' || e.keyword === 'anyOf')
    .sort((a, b) => b.instancePath.length - a.instancePath.length);
  const replacements: SchemaIssue[] = [];

  for (const failure of unionFailures) {
    const prefix = `${failure.schemaPath}/`;
    // schemaPath is relative to the compiled (possibly $ref'd) schema, so errors of this union are
    // identified by schemaPath prefix *and* instance location.
    const belongs = (e: ErrorObject) =>
      e.schemaPath.startsWith(prefix) && (e.instancePath === failure.instancePath || e.instancePath.startsWith(`${failure.instancePath}/`));
    const path = pointerSegments(failure.instancePath, data);
    const union = unionAt(root, path, data);
    const variants = union ? variantsOf(union, root) : undefined;
    const value = valueAt(data, path);
    const key = variants ? discriminatorOf(variants, root) : undefined;
    const index =
      key && isObject(value) && key in value
        ? variants!.findIndex((v) => JSON.stringify(constOf(resolve(v.properties[key], root))?.value) === JSON.stringify(value[key]))
        : -1;

    if (index >= 0) {
      const chosen = `${prefix}${index}/`;
      remaining = remaining.filter((e) => e === failure || !belongs(e) || e.schemaPath.startsWith(chosen));
      // Errors of $ref'd sub-schemas have their own schemaPath; any error under this instance explains the failure.
      const within = (e: ErrorObject) => e.instancePath === failure.instancePath || e.instancePath.startsWith(`${failure.instancePath}/`);
      if (remaining.some((e) => e !== failure && within(e))) {
        remaining = remaining.filter((e) => e !== failure);
      }
      continue;
    }

    remaining = remaining.filter((e) => e !== failure && !belongs(e));
    if (key && variants) {
      const allowed = variants.map((v) => JSON.stringify(constOf(resolve(v.properties[key], root))?.value)).join(', ');
      replacements.push(
        isObject(value) && key in value
          ? { path: [...path, key], target: 'value', message: `"${key}" must be one of: ${allowed}` }
          : { path, target: 'container', message: `missing "${key}" (one of: ${allowed})` },
      );
    } else {
      replacements.push({ path, target: 'value', message: `must match ${failure.keyword === 'oneOf' ? 'exactly one' : 'at least one'} of the allowed shapes` });
    }
  }

  const issues = [...replacements, ...remaining.map((e) => toIssue(e, data))];
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const id = `${JSON.stringify(issue.path)}|${issue.target}|${issue.message}`;
    return !seen.has(id) && !!seen.add(id);
  });
}

function toIssue(error: ErrorObject, data: unknown): SchemaIssue {
  const path = pointerSegments(error.instancePath, data);
  const name = path.length ? String(path[path.length - 1]) : 'value';
  switch (error.keyword) {
    case 'required':
      return { path, target: 'container', message: `missing required property "${(error.params as { missingProperty: string }).missingProperty}"` };
    case 'additionalProperties': {
      const extra = (error.params as { additionalProperty: string }).additionalProperty;
      return { path: [...path, extra], target: 'key', message: `unknown property "${extra}"` };
    }
    case 'enum':
      return {
        path,
        target: 'value',
        message: `${name} must be one of: ${((error.params as { allowedValues: unknown[] }).allowedValues ?? []).map((v) => JSON.stringify(v)).join(', ')}`,
      };
    case 'const':
      return { path, target: 'value', message: `${name} must be ${JSON.stringify((error.params as { allowedValue: unknown }).allowedValue)}` };
    default:
      return { path, target: 'value', message: `${name} ${error.message ?? 'is invalid'}` };
  }
}

/** JSON pointer → path segments, using numbers for array indices. */
function pointerSegments(pointer: string, data: unknown): PathSegment[] {
  if (!pointer) {
    return [];
  }
  const out: PathSegment[] = [];
  let node = data;
  for (const raw of pointer.slice(1).split('/')) {
    const part = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    const segment: PathSegment = Array.isArray(node) && /^\d+$/.test(part) ? Number(part) : part;
    out.push(segment);
    node = isObject(node) || Array.isArray(node) ? (node as Record<string | number, unknown>)[segment] : undefined;
  }
  return out;
}

function valueAt(data: unknown, path: PathSegment[]): unknown {
  return path.reduce<unknown>((node, segment) => (isObject(node) || Array.isArray(node) ? (node as Record<string | number, unknown>)[segment] : undefined), data);
}

/** The `oneOf`/`anyOf` schema that applies at `path` (refs resolved), if any. */
function unionAt(root: Schema, path: PathSegment[], data: unknown): Schema | undefined {
  const raws = path.length
    ? schemasAt(root, path.slice(0, -1), data).map((parent) => childSchema(parent, path[path.length - 1]))
    : [root];
  return raws.map((raw) => resolve(raw, root)).find((schema) => Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf));
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
