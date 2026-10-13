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

export function validateManifest(manifest) {
  if (validate(manifest)) return [];
  return validate.errors.slice(0, 10).map((error) => {
    const where = error.instancePath || '(manifest)';
    const detail = error.params?.additionalProperty ? ` (${error.params.additionalProperty})`
      : error.params?.missingProperty ? ` (${error.params.missingProperty})` : '';
    return `${where} ${error.message}${detail}`;
  });
}
