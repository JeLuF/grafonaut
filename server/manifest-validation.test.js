import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkManifest } from './manifest-validation.js';

const manifest = (extra = {}) => ({ $schema: 'https://ograf.ebu.io/v1/specification/json-schemas/graphics/schema.json',
  id: 'wheel', name: 'Wheel', main: 'graphic.mjs', supportsRealTime: true, supportsNonRealTime: false, ...extra });
const withProperties = (properties) => manifest({ schema: { type: 'object', properties } });

test('a select without labels is valid with the enum values as labels, also nested and in action payloads', () => {
  const result = checkManifest(manifest({
    schema: { type: 'object', properties: {
      layout: { type: 'string', gddType: 'select', enum: ['proportional', 'distributed'] },
      team: { type: 'object', properties: { side: { type: 'integer', gddType: 'select', enum: [1, 2], gddOptions: {} } } }
    } },
    customActions: [{ id: 'spin', name: 'Spin', schema: { type: 'object', properties: { speed: { type: 'string', gddType: 'select', enum: ['slow', 'fast'] } } } }]
  }));
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.warnings, [
    'property "layout": gddType "select" without gddOptions.labels; the enum values are used as labels',
    'property "team.side": gddType "select" without gddOptions.labels; the enum values are used as labels',
    'property "spin payload.speed": gddType "select" without gddOptions.labels; the enum values are used as labels'
  ]);
});

test('labelled selects pass without notes and the manifest itself is not changed', () => {
  const input = withProperties({ position: { type: 'string', gddType: 'select', enum: ['left'], gddOptions: { labels: { left: 'Left' } } },
    layout: { type: 'string', gddType: 'select', enum: ['a'] } });
  const before = JSON.stringify(input);
  assert.deepEqual(checkManifest(input).warnings.length, 1);
  assert.equal(JSON.stringify(input), before);
});

test('errors name the property, leave out the schema\'s conditional "then" errors and appear once', () => {
  const { problems } = checkManifest(withProperties({ layout: { type: 'string', gddType: 'select' } }));
  assert.deepEqual(problems, ['property "layout" must have required property \'gddOptions\'', 'property "layout" must have required property \'enum\'']);
  assert.ok(problems.every((problem) => !problem.includes('"then"')));
  assert.deepEqual(checkManifest(manifest({ main: 5 })).problems, ['main must be string']);
  assert.ok(checkManifest({ id: 'x' }).problems.includes('manifest must have required property \'name\''));
});
