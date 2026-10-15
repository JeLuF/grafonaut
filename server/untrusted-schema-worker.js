import { parentPort } from 'node:worker_threads';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { getDefaultFormState } from '@rjsf/utils';
import validator from '@rjsf/validator-ajv8';

// Runs JSON Schema work on schemas from uploaded manifests (see untrusted-schema.js).
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

const tasks = {
  validate(schema, data) {
    let validate;
    try { validate = ajv.compile(schema); }
    catch { return { invalidSchema: true }; }
    finally { ajv.removeSchema(schema); }
    const valid = validate(data);
    return { valid, errors: valid ? [] : JSON.parse(JSON.stringify(validate.errors ?? [])) };
  },
  // The schema defaults, computed exactly as the properties dialog (RJSF) fills them in.
  defaults(schema) {
    if (!isObject(schema)) return {};
    const defaults = getDefaultFormState(validator, schema, {}, schema);
    return isObject(defaults) ? defaults : {};
  }
};

parentPort.on('message', ({ id, task, args }) => {
  try { parentPort.postMessage({ id, result: tasks[task](...args) }); }
  catch (error) { parentPort.postMessage({ id, error: String(error?.message ?? error) }); }
});
parentPort.postMessage({ ready: true });
