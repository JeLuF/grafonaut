import { untrustedSchemas } from './untrusted-schema.js';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// The initial properties of a new My Graphics entry: the schema defaults, computed exactly as the properties
// dialog (RJSF) fills them in, so playing an entry before its properties were ever saved uses the same values.
// Computed in the schema worker (the schema comes from an uploaded manifest); without a result the entry starts empty.
export async function propertyDefaults(schema, runner = untrustedSchemas) {
  if (!isObject(schema)) return {};
  try {
    const defaults = await runner.run('defaults', schema);
    return isObject(defaults) ? defaults : {};
  } catch { return {}; }
}
