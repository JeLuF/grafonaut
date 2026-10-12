import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, afterEach, test } from 'node:test';
import React from 'react';
import { transformAsync } from '@babel/core';
import jsx from '@babel/plugin-transform-react-jsx';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
const { render, fireEvent, screen, within, cleanup, waitFor } = await import('@testing-library/react');

const sourceUrl = new URL('./my-graphics.jsx', import.meta.url);
const source = await fs.readFile(sourceUrl, 'utf8');
const compiled = await transformAsync(source, { filename: sourceUrl.pathname, configFile: false, babelrc: false,
  plugins: [jsx, () => ({ visitor: { ImportDeclaration({ node }) {
    node.source.value = node.source.value.startsWith('.') ? new URL(node.source.value, sourceUrl).href : import.meta.resolve(node.source.value);
  } } })] });
const { default: MyGraphicsView, PropertiesDialog } = await import(`data:text/javascript,${encodeURIComponent(compiled.code)}`);
afterEach(cleanup);
after(() => dom.window.close());

const entry = { entryId: '1', versionId: 'version', versionLabel: '1.0.0', display_name: 'Lower third',
  label: 'Left', enabled: true, packageDisabled: false, origin: 'catalog', schemaData: { name: 'Host', hiddenValue: 1 },
  schema: { type: 'object', required: ['name'], properties: {
    name: { type: 'string', title: 'Name', minLength: 1 }, hiddenValue: { type: 'integer', title: 'Hidden value', hidden: true }
  } } };

function showView(overrides = {}) {
  const calls = [];
  render(React.createElement(MyGraphicsView, { account: { id: 'account' }, entries: [entry, { ...entry, entryId: '2', label: 'Right' }],
    loading: false, error: '', pending: new Set(), Preview: () => null, onRetry: () => {},
    onSave: async (...args) => { calls.push(args); }, onAction: (...args) => { calls.push(args); }, ...overrides }));
  return calls;
}

test('both frontend JSX files compile', async () => {
  const main = await transformAsync(await fs.readFile(new URL('./main.jsx', import.meta.url), 'utf8'), {
    configFile: false, babelrc: false, plugins: [jsx]
  });
  assert.ok(main.code.includes('MyGraphicsView'));
  assert.ok(compiled.code.includes('PropertiesDialog'));
});
test('duplicate package entries render independent labels and enabled states', () => {
  showView();
  assert.equal(screen.getAllByRole('listitem').length, 2);
  assert.equal(screen.getByDisplayValue('Left').id, 'label-1');
  assert.equal(screen.getByDisplayValue('Right').id, 'label-2');
  assert.equal(screen.getAllByRole('checkbox').length, 2);
  assert.equal(screen.getAllByRole('button', { name: 'Play' })[0].disabled, true);
  assert.equal(screen.getAllByText('Renderer unavailable').length, 2);
});
test('saving a label and toggling enabled only target the selected entry', async () => {
  const calls = showView();
  fireEvent.change(screen.getByDisplayValue('Left'), { target: { value: 'Host A' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save label' })[0]);
  await waitFor(() => assert.deepEqual(calls[0], ['1', { label: 'Host A' }]));
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
  await waitFor(() => assert.deepEqual(calls[1], ['2', { enabled: false }]));
  assert.equal(screen.getByDisplayValue('Right').value, 'Right');
});
test('the property dialog includes hidden fields and saves one independent state', async () => {
  const calls = showView();
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit properties' })[1]);
  const dialog = within(screen.getByRole('dialog'));
  assert.ok(dialog.getByLabelText('Hidden value'));
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'Second host' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(calls[0], ['2', { schemaData: { name: 'Second host', hiddenValue: 1 } }]));
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
  assert.deepEqual(entry.schemaData, { name: 'Host', hiddenValue: 1 });
});
test('cancelling properties leaves stored entry data unchanged', async () => {
  const calls = showView();
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit properties' })[0]);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'Unsaved' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  assert.equal(calls.length, 0);
  assert.equal(screen.queryByRole('dialog'), null);
});
test('property save failures stay visible and keep the dialog open', async () => {
  render(React.createElement(PropertiesDialog, { entry, onSave: async () => { throw new Error('Save unavailable'); }, onClose: () => {} }));
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Save unavailable')));
  assert.ok(screen.getByRole('dialog'));
});
test('signed-out and error states offer the appropriate next action', () => {
  showView({ account: null });
  assert.ok(screen.getByRole('link', { name: 'Sign in with Twitch' }));
  cleanup();
  showView({ error: 'Unable to load entries' });
  assert.ok(screen.getByRole('alert').textContent.includes('Unable to load entries'));
  assert.ok(screen.getByRole('button', { name: 'Retry' }));
});