import fs from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Validates graphic manifests against the official OGraf v1 schema (vendored in ./schemas/ograf).
const schemaFiles = ['lib/action.json', 'lib/constraints/number.json', 'lib/constraints/boolean.json',
  'gdd/basic-types.json', 'gdd/gdd-types.json', 'gdd/object.json', 'graphics/schema.json'];
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const file of schemaFiles) ajv.addSchema(JSON.parse(fs.readFileSync(new URL(`./schemas/ograf/${file}`, import.meta.url), 'utf8')));
const validate = ajv.getSchema('https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json');

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// Readable location of an error: "/schema/properties/layout" becomes 'property "layout"'.
function describePath(instancePath) {
  if (!instancePath) return 'manifest';
  const property = /^\/schema((?:\/(?:properties\/[^/]+|items))+)(.*)$/.exec(instancePath);
  if (property) {
    const name = property[1].split('/').filter((part) => part && part !== 'properties').map((part) => part === 'items' ? '[]' : part).join('.').replace(/\.\[\]/g, '[]');
    return `property "${name}"${property[2] ? ` (${property[2].slice(1)})` : ''}`;
  }
  return instancePath.slice(1).replace(/\//g, '.');
}

// Being lenient with GDD details that do not affect playback: a "select" without gddOptions.labels gets its enum
// values as labels. Works on a copy; returns it and notes what was assumed.
function lenientSchema(node, path, warnings) {
  if (Array.isArray(node)) return node.map((item) => lenientSchema(item, path, warnings));
  if (!isObject(node)) return node;
  const copy = { ...node };
  if (isObject(node.properties)) {
    copy.properties = Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key, lenientSchema(value, path ? `${path}.${key}` : key, warnings)]));
  }
  if (node.items) copy.items = lenientSchema(node.items, `${path}[]`, warnings);
  if (node.gddType === 'select' && Array.isArray(node.enum) && !isObject(node.gddOptions?.labels)) {
    copy.gddOptions = { ...(isObject(node.gddOptions) ? node.gddOptions : {}), labels: Object.fromEntries(node.enum.map((value) => [String(value), String(value)])) };
    warnings.push(`property "${path}": gddType "select" without gddOptions.labels; the enum values are used as labels`);
  }
  return copy;
}

// Checks a manifest against the official OGraf schema, leniently (see lenientSchema). Returns the problems that
// reject it and warnings about what was assumed. The conditional ("if ... then") errors of the schema only repeat
// that a more specific rule failed, so they are left out, and repeated messages are reported once.
export function checkManifest(manifest) {
  const warnings = [];
  const lenient = isObject(manifest) ? { ...manifest } : manifest;
  if (isObject(manifest) && isObject(manifest.schema)) lenient.schema = lenientSchema(manifest.schema, '', warnings);
  if (isObject(manifest) && Array.isArray(manifest.customActions)) {
    lenient.customActions = manifest.customActions.map((action) => isObject(action) && isObject(action.schema)
      ? { ...action, schema: lenientSchema(action.schema, `${action.id ?? 'action'} payload`, warnings) } : action);
  }
  if (validate(lenient)) return { problems: [], warnings };
  const specific = validate.errors.filter((error) => error.keyword !== 'if');
  const messages = (specific.length ? specific : validate.errors).map((error) => {
    const detail = error.params?.additionalProperty ? ` (${error.params.additionalProperty})` : '';
    return `${describePath(error.instancePath)} ${error.message}${detail}`;
  });
  return { problems: [...new Set(messages)].slice(0, 10), warnings };
}

export const validateManifest = (manifest) => checkManifest(manifest).problems;
