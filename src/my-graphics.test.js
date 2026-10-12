import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, afterEach, mock, test } from 'node:test';
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
const { render, fireEvent, screen, within, cleanup, waitFor, act } = await import('@testing-library/react');

const sourceUrl = new URL('./my-graphics.jsx', import.meta.url);
const source = await fs.readFile(sourceUrl, 'utf8');
const compiled = await transformAsync(source, { filename: sourceUrl.pathname, configFile: false, babelrc: false,
  plugins: [jsx, () => ({ visitor: { ImportDeclaration({ node }) {
    node.source.value = node.source.value.startsWith('.') ? new URL(node.source.value, sourceUrl).href : import.meta.resolve(node.source.value);
  } } })] });
const myGraphicsUrl = `data:text/javascript,${encodeURIComponent(compiled.code)}`;
const { default: MyGraphicsView, PropertiesDialog } = await import(myGraphicsUrl);
const mainUrl = new URL('./main.jsx', import.meta.url);
const compiledMain = await transformAsync(await fs.readFile(mainUrl, 'utf8'), {
  filename: mainUrl.pathname, configFile: false, babelrc: false, plugins: [jsx, () => ({ visitor: {
    ImportDeclaration(importPath) {
      const file = importPath.node.source.value;
      if (file.endsWith('.css')) { importPath.remove(); return; }
      importPath.node.source.value = file === './my-graphics.jsx' ? myGraphicsUrl : file.startsWith('.') ? new URL(file, mainUrl).href : import.meta.resolve(file);
    },
    ExpressionStatement(statement) {
      const expression = statement.node.expression;
      if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' &&
        expression.callee.property.name === 'render' && expression.callee.object.type === 'CallExpression' &&
        expression.callee.object.callee.name === 'createRoot') statement.remove();
    }
  } })]
});
const { AddGraphicButton, Toast } = await import(`data:text/javascript,${encodeURIComponent(compiledMain.code)}`);
afterEach(() => { cleanup(); mock.restoreAll(); mock.timers.reset(); });
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
    onSave: async (...args) => { calls.push(args); }, onAction: (...args) => { calls.push(args); },
    onDelete: async (item) => { calls.push(['delete', item.entryId]); },
    onManifest: async (item) => { calls.push(['manifest', item.entryId]); return { id: 'lower-third', version: '1.0.0', name: item.label, main: 'main.mjs' }; }, ...overrides }));
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

test('the add button lights up green only after success and allows another addition', async () => {
  let count = 0;
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => { count += 1; } }));
  const button = screen.getByRole('button', { name: 'Add Lower third to My Graphics' });
  fireEvent.click(button);
  assert.equal(button.disabled, true);
  await waitFor(() => assert.ok(button.classList.contains('is-added')));
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  await waitFor(() => assert.equal(count, 2));
});

test('failed additions never light up green', async () => {
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => { throw new Error('Unavailable'); } }));
  const button = screen.getByRole('button', { name: 'Add Lower third to My Graphics' });
  fireEvent.click(button);
  await waitFor(() => assert.equal(button.disabled, false));
  assert.equal(button.classList.contains('is-added'), false);
});

test('success feedback clears after two seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => {} }));
  const button = screen.getByRole('button', { name: 'Add Lower third to My Graphics' });
  await act(async () => fireEvent.click(button));
  assert.ok(button.classList.contains('is-added'));
  act(() => mock.timers.tick(2000));
  assert.equal(button.classList.contains('is-added'), false);
});

test('toast announces success and supports dismissal and automatic expiry', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const dismissals = [];
  render(React.createElement(Toast, { toast: { id: 1, kind: 'success', message: 'Lower third added to My Graphics' }, onDismiss: (value) => dismissals.push(value) }));
  assert.ok(screen.getByRole('status').textContent.includes('Lower third added'));
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  assert.deepEqual(dismissals, [null]);
  act(() => mock.timers.tick(5000));
  assert.deepEqual(dismissals, [null, null]);
});

test('the menu opens, supports keyboard navigation and closes on Escape', () => {
  showView();
  const trigger = screen.getByRole('button', { name: 'More options for Left' });
  fireEvent.click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  const manifest = screen.getByRole('menuitem', { name: 'Show manifest' });
  assert.equal(document.activeElement, manifest);
  fireEvent.keyDown(manifest, { key: 'ArrowDown' });
  assert.equal(document.activeElement, screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  assert.equal(screen.queryByRole('menu'), null);
  assert.equal(document.activeElement, trigger);
});

test('delete requires confirmation and targets only the selected entry', async () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'More options for Right' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  assert.equal(calls.length, 0);
  let dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  assert.equal(calls.length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'More options for Right' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(calls, [['delete', '2']]));
  await waitFor(() => assert.equal(screen.queryByRole('dialog'), null));
});

test('show manifest displays the selected entry manifest as formatted JSON', async () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'More options for Right' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show manifest' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog').textContent.includes('"name": "Right"')));
  assert.deepEqual(calls, [['manifest', '2']]);
});

test('delete and manifest failures stay visible in their dialogs', async () => {
  showView({ onDelete: async () => { throw new Error('Unable to delete'); }, onManifest: async () => { throw new Error('Unable to load manifest'); } });
  fireEvent.click(screen.getByRole('button', { name: 'More options for Left' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Unable to delete')));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'More options for Left' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show manifest' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Unable to load manifest')));
});