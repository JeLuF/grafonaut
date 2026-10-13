import { getDefaultFormState } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

// The initial properties of a new My Graphics entry: the schema defaults, computed exactly as the properties
// dialog (RJSF) fills them in, so playing an entry before its properties were ever saved uses the same values.
export function propertyDefaults(schema) {
  if (!isObject(schema)) return {};
  try {
    const defaults = getDefaultFormState(validator, schema, {}, schema);
    return isObject(defaults) ? defaults : {};
  } catch { return {}; }
}
