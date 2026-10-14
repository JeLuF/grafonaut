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

async function compileModule(file, local = {}) {
  const url = new URL(file, import.meta.url);
  const result = await transformAsync(await fs.readFile(url, 'utf8'), { filename: url.pathname, configFile: false, babelrc: false,
    plugins: [jsx, () => ({ visitor: { ImportDeclaration({ node }) {
      node.source.value = local[node.source.value] ?? (node.source.value.startsWith('.') ? new URL(node.source.value, url).href : import.meta.resolve(node.source.value));
    } } })] });
  return { code: result.code, url: `data:text/javascript,${encodeURIComponent(result.code)}` };
}
const brandUrl = (await compileModule('./brand.jsx')).url;
const brand = { './brand.jsx': brandUrl };
const mediaUrl = (await compileModule('./media.jsx')).url;
const { default: MediaCatalogView, MediaPathWidget, acceptedExtensions } = await import(mediaUrl);
const colorUrl = (await compileModule('./color.jsx')).url;
const { parseColor, formatColor, hexToHsv, hsvToHex } = await import(colorUrl);
const compiled = await compileModule('./my-graphics.jsx', { ...brand, './media.jsx': mediaUrl, './color.jsx': colorUrl });
const myGraphicsUrl = compiled.url;
const graphicDetailUrl = (await compileModule('./graphic-detail.jsx', { './my-graphics.jsx': myGraphicsUrl, ...brand })).url;
const { default: MyGraphicsView, PropertiesDialog } = await import(myGraphicsUrl);
const { default: GraphicDetail, ThumbnailCarousel, formatRequirement } = await import(graphicDetailUrl);
const rendererViewUrl = (await compileModule('./renderer-view.jsx', brand)).url;
const { default: RendererView } = await import(rendererViewUrl);
const rundownsUrl = (await compileModule('./rundowns.jsx')).url;
const { RundownPanel, useRundowns } = await import(rundownsUrl);
const privateCatalogUrl = (await compileModule('./private-catalog.jsx', brand)).url;
const { default: PrivateCatalogView } = await import(privateCatalogUrl);
const groupActionsUrl = (await compileModule('./group-actions.jsx', { './my-graphics.jsx': myGraphicsUrl })).url;
const { GroupActionsPanel } = await import(groupActionsUrl);
const { FeatureRow, HeroArt, LoginButtons, LoginProvidersContext, Logo, TwitchLogin } = await import(brandUrl);
const mainUrl = new URL('./main.jsx', import.meta.url);
const compiledMain = await transformAsync(await fs.readFile(mainUrl, 'utf8'), {
  filename: mainUrl.pathname, configFile: false, babelrc: false, plugins: [jsx, () => ({ visitor: {
    ImportDeclaration(importPath) {
      const file = importPath.node.source.value;
      if (file.endsWith('.css')) { importPath.remove(); return; }
      const local = { './my-graphics.jsx': myGraphicsUrl, './graphic-detail.jsx': graphicDetailUrl, './renderer-view.jsx': rendererViewUrl, './rundowns.jsx': rundownsUrl, './private-catalog.jsx': privateCatalogUrl, './group-actions.jsx': groupActionsUrl, './brand.jsx': brandUrl, './media.jsx': mediaUrl };
      importPath.node.source.value = local[file] ?? (file.startsWith('.') ? new URL(file, mainUrl).href : import.meta.resolve(file));
    },
    ExpressionStatement(statement) {
      const expression = statement.node.expression;
      if (expression.type === 'CallExpression' && expression.callee.type === 'MemberExpression' &&
        expression.callee.property.name === 'render' && expression.callee.object.type === 'CallExpression' &&
        expression.callee.object.callee.name === 'createRoot') statement.remove();
    }
  } })]
});
const { AddGraphicButton, Pagination, SearchBox, Toast, pageNumbers, parseRoute } = await import(`data:text/javascript,${encodeURIComponent(compiledMain.code)}`);
// Never hand DOM nodes to assert.equal/deepEqual: a failing comparison makes Node inspect and diff the whole jsdom
// object graph, which exhausts memory instead of failing (and inside waitFor's first, expected miss, it stalls the run).
const describeNode = (node) => node?.outerHTML?.slice(0, 160) ?? String(node);
const assertAbsent = (node) => assert.ok(node === null, `Expected no element, found ${describeNode(node)}`);
const assertFocused = (node) => assert.ok(document.activeElement === node,
  `Expected focus on ${describeNode(node)}, found ${describeNode(document.activeElement)}`);
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
    onReorder: async (entryIds) => { calls.push(['order', entryIds]); },
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
  assert.ok(screen.getByRole('heading', { name: 'Left' }));
  assert.ok(screen.getByRole('heading', { name: 'Right' }));
  assertAbsent(screen.queryByRole('textbox', { name: 'Label' }));
  assert.equal(screen.getAllByText('Lower third').length, 2);
  assert.equal(screen.getAllByRole('checkbox').length, 2);
  assert.equal(screen.getAllByRole('button', { name: 'Play' })[0].disabled, true);
  assert.equal(screen.getAllByText('Renderer unavailable').length, 2);
});
test('saving a label and toggling enabled only target the selected entry', async () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  assertFocused(screen.getByRole('textbox', { name: 'Label' }));
  fireEvent.change(screen.getByDisplayValue('Left'), { target: { value: 'Host A' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
  await waitFor(() => assert.deepEqual(calls[0], ['1', { label: 'Host A' }]));
  fireEvent.click(screen.getAllByRole('checkbox')[1]);
  await waitFor(() => assert.deepEqual(calls[1], ['2', { enabled: false }]));
  assert.ok(screen.getByRole('heading', { name: 'Right' }));
});

test('unchanged labels show the graphic name once and keep metadata below it', () => {
  showView({ entries: [{ ...entry, label: null }, { ...entry, entryId: '2', label: entry.display_name }] });
  for (const row of screen.getAllByRole('listitem')) {
    assert.ok(within(row).getByRole('heading', { name: 'Lower third' }));
    assertAbsent(row.querySelector('.entry-original-name'));
    assert.ok(row.querySelector('.entry-meta').textContent.includes('v1.0.0'));
  }
});

test('cancelling a label edit restores the saved heading without saving', () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Unsaved' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Label' }), { key: 'Escape' });
  assert.ok(screen.getByRole('heading', { name: 'Left' }));
  assertAbsent(screen.queryByRole('textbox', { name: 'Label' }));
  assert.equal(calls.length, 0);
});

test('clearing a label resets it to the original graphic name', async () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: ' ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
  await waitFor(() => assert.deepEqual(calls[0], ['1', { label: null }]));
});

test('a failed label save keeps the editor open with its error', async () => {
  showView({ onSave: async () => { throw new Error('Label save unavailable'); } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save label' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Label save unavailable')));
  assert.ok(screen.getByRole('textbox', { name: 'Label' }));
});

test('up and down handles move one entry and disable moves past list boundaries', async () => {
  const calls = showView();
  assert.equal(screen.getByRole('button', { name: 'Move Left up' }).disabled, true);
  assert.equal(screen.getByRole('button', { name: 'Move Right down' }).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: 'Move Left down' }));
  await waitFor(() => assert.deepEqual(calls[0], ['order', ['2', '1']]));
  await waitFor(() => assert.equal(screen.getByRole('button', { name: 'Move Right up' }).disabled, false));
  fireEvent.click(screen.getByRole('button', { name: 'Move Right up' }));
  await waitFor(() => assert.deepEqual(calls[1], ['order', ['2', '1']]));
});

test('order save failures preserve the displayed order and offer a refresh', async () => {
  showView({ onReorder: async () => { throw new Error('Unable to save graphic order'); } });
  fireEvent.click(screen.getByRole('button', { name: 'Move Right up' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Unable to save graphic order')));
  assert.deepEqual(screen.getAllByRole('listitem').map((row) => within(row).getByRole('heading').textContent), ['Left', 'Right']);
  assert.ok(screen.getByRole('button', { name: 'Refresh list' }));
});

test('drag and move handles are unavailable during another entry operation', () => {
  showView({ pending: new Set(['1']) });
  for (const name of ['Drag Left to reorder', 'Drag Right to reorder', 'Move Left down', 'Move Right up']) {
    assert.equal(screen.getByRole('button', { name }).disabled, true);
  }
});

test('keyboard dragging reorders through the same save callback', async () => {
  mock.method(dom.window.HTMLElement.prototype, 'getBoundingClientRect', function () {
    const index = Array.from(document.querySelectorAll('.graphic-entry')).indexOf(this);
    const top = index < 0 ? 0 : index * 160;
    const height = index < 0 ? 640 : 160;
    return { x: 0, y: top, top, left: 0, bottom: top + height, right: 800, width: 800, height };
  });
  const calls = showView();
  const handle = screen.getByRole('button', { name: 'Drag Left to reorder' });
  handle.focus();
  fireEvent.keyDown(handle, { key: ' ', code: 'Space' });
  await waitFor(() => assert.ok(document.querySelector('.graphic-entry.is-dragging')));
  await act(async () => {});
  fireEvent.keyDown(document, { key: 'ArrowDown', code: 'ArrowDown' });
  await act(async () => {});
  fireEvent.keyDown(document, { key: ' ', code: 'Space' });
  await waitFor(() => assert.deepEqual(calls, [['order', ['2', '1']]]));
});

test('catalog preview canvases use a 16:9 aspect ratio', async () => {
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.card-art\s*\{[^}]*aspect-ratio:\s*16\s*\/\s*9\s*;/);
});

test('pointer dragging a handle saves the changed order', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  mock.method(dom.window.HTMLElement.prototype, 'getBoundingClientRect', function () {
    const index = Array.from(document.querySelectorAll('.graphic-entry')).indexOf(this);
    const top = index < 0 ? 0 : index * 160;
    const height = index < 0 ? 640 : 160;
    return { x: 0, y: top, top, left: 0, bottom: top + height, right: 800, width: 800, height };
  });
  const calls = showView();
  const handle = screen.getByRole('button', { name: 'Drag Left to reorder' });
  const down = new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 15, clientY: 60 });
  Object.defineProperty(down, 'isPrimary', { value: true });
  await act(async () => {
    fireEvent(handle, down);
    fireEvent(document, new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 15, clientY: 70 }));
  });
  assert.ok(document.querySelector('.graphic-entry.is-dragging'));
  await act(async () => fireEvent(document, new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: 15, clientY: 220 })));
  await act(async () => fireEvent(document, new dom.window.MouseEvent('pointerup', { bubbles: true, clientX: 15, clientY: 220 })));
  assert.deepEqual(calls, [['order', ['2', '1']]]);
  act(() => mock.timers.tick(100));
});
test('the property dialog includes hidden fields and saves one independent state', async () => {
  const calls = showView();
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit properties' })[1]);
  const dialog = within(screen.getByRole('dialog'));
  assert.ok(dialog.getByLabelText('Hidden value'));
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'Second host' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(calls[0], ['2', { schemaData: { name: 'Second host', hiddenValue: 1 } }]));
  await waitFor(() => assertAbsent(screen.queryByRole('dialog')));
  assert.deepEqual(entry.schemaData, { name: 'Host', hiddenValue: 1 });
});
test('cancelling properties leaves stored entry data unchanged', async () => {
  const calls = showView();
  fireEvent.click(screen.getAllByRole('button', { name: 'Edit properties' })[0]);
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByLabelText(/Name/), { target: { value: 'Unsaved' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
  assert.equal(calls.length, 0);
  assertAbsent(screen.queryByRole('dialog'));
});
test('property save failures stay visible and keep the dialog open', async () => {
  render(React.createElement(PropertiesDialog, { entry, onSave: async () => { throw new Error('Save unavailable'); }, onClose: () => {} }));
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Save unavailable')));
  assert.ok(screen.getByRole('dialog'));
});
test('signed-out and error states offer the appropriate next action', () => {
  showView({ account: null });
  assert.ok(screen.getByRole('link', { name: 'Login with Twitch' }));
  cleanup();
  showView({ error: 'Unable to load entries' });
  assert.ok(screen.getByRole('alert').textContent.includes('Unable to load entries'));
  assert.ok(screen.getByRole('button', { name: 'Retry' }));
});

test('the add button lights up green only after success and allows another addition', async () => {
  let count = 0;
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => { count += 1; } }));
  const button = screen.getByRole('button', { name: 'Add Lower third to rundown' });
  fireEvent.click(button);
  assert.equal(button.disabled, true);
  await waitFor(() => assert.ok(button.classList.contains('is-added')));
  assert.equal(button.disabled, false);
  fireEvent.click(button);
  await waitFor(() => assert.equal(count, 2));
});

test('failed additions never light up green', async () => {
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => { throw new Error('Unavailable'); } }));
  const button = screen.getByRole('button', { name: 'Add Lower third to rundown' });
  fireEvent.click(button);
  await waitFor(() => assert.equal(button.disabled, false));
  assert.equal(button.classList.contains('is-added'), false);
});

test('success feedback clears after two seconds', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  render(React.createElement(AddGraphicButton, { item: entry, disabled: false, onAdd: async () => {} }));
  const button = screen.getByRole('button', { name: 'Add Lower third to rundown' });
  await act(async () => fireEvent.click(button));
  assert.ok(button.classList.contains('is-added'));
  act(() => mock.timers.tick(2000));
  assert.equal(button.classList.contains('is-added'), false);
});

test('toast announces success and supports dismissal and automatic expiry', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const dismissals = [];
  render(React.createElement(Toast, { toast: { id: 1, kind: 'success', message: 'Lower third added to Sunday show' }, onDismiss: (value) => dismissals.push(value) }));
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
  const details = screen.getByRole('menuitem', { name: 'Show details' });
  assertFocused(details);
  assert.equal(details.getAttribute('href'), '#graphic/version');
  fireEvent.keyDown(details, { key: 'ArrowDown' });
  const manifest = screen.getByRole('menuitem', { name: 'Show manifest' });
  assertFocused(manifest);
  fireEvent.keyDown(manifest, { key: 'ArrowDown' });
  assertFocused(screen.getByRole('menuitem', { name: 'Duplicate' }));
  fireEvent.keyDown(document.activeElement, { key: 'ArrowDown' });
  assertFocused(screen.getByRole('menuitem', { name: 'Delete' }));
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  assertAbsent(screen.queryByRole('menu'));
  assertFocused(trigger);
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
  await waitFor(() => assertAbsent(screen.queryByRole('dialog')));
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
test('hash routes resolve catalog, my graphics and graphic detail views', () => {
  assert.deepEqual(parseRoute(''), { view: 'catalog' });
  assert.deepEqual(parseRoute('#rundown'), { view: 'rundown' });
  assert.deepEqual(parseRoute('#my-graphics'), { view: 'rundown' });
  assert.deepEqual(parseRoute('#private'), { view: 'private' });
  assert.deepEqual(parseRoute('#renderer'), { view: 'renderer' });
  assert.deepEqual(parseRoute('#graphic/abc%2Fdef'), { view: 'graphic', versionId: 'abc/def' });
  assert.deepEqual(parseRoute('#graphic/%E0%A4%A'), { view: 'catalog' });
});

test('page numbers collapse long ranges around the current page', () => {
  assert.deepEqual(pageNumbers(3, 0), [0, 1, 2]);
  assert.deepEqual(pageNumbers(12, 0), [0, 1, null, 11]);
  assert.deepEqual(pageNumbers(12, 5), [0, null, 4, 5, 6, null, 11]);
  assert.deepEqual(pageNumbers(12, 11), [0, null, 10, 11]);
});

test('pagination shows the visible range and switches pages without navigation', () => {
  const pages = [];
  render(React.createElement(Pagination, { page: 0, pageCount: 3, total: 14, onChange: (page) => pages.push(page) }));
  assert.ok(screen.getByText('1–6 of 14'));
  assert.equal(screen.getByRole('button', { name: 'Previous page' }).disabled, true);
  assert.equal(screen.getByRole('button', { name: 'Page 1' }).getAttribute('aria-current'), 'page');
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  fireEvent.click(screen.getByRole('button', { name: 'Page 3' }));
  assert.deepEqual(pages, [1, 2]);
  cleanup();
  render(React.createElement(Pagination, { page: 0, pageCount: 1, total: 4, onChange: () => {} }));
  assertAbsent(screen.queryByRole('navigation'));
});

test('catalog descriptions are clamped to three lines', async () => {
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.card-description\s*\{[^}]*-webkit-line-clamp:\s*3;[^}]*line-clamp:\s*3;/);
});

test('the carousel cycles through every thumbnail by button, strip and keyboard', () => {
  const images = [1, 2, 3].map((index) => ({ url: `/thumb/${index}`, width: 1280, height: 720, animated: index === 3 }));
  render(React.createElement(ThumbnailCarousel, { images, name: 'Scoreboard', fallback: null }));
  const current = () => screen.getByRole('img').getAttribute('src');
  assert.equal(current(), '/thumb/1');
  fireEvent.click(screen.getByRole('button', { name: 'Previous thumbnail' }));
  assert.equal(current(), '/thumb/3');
  assert.ok(screen.getByText('1280 × 720 · Animated'));
  fireEvent.click(screen.getByRole('button', { name: 'Next thumbnail' }));
  assert.equal(current(), '/thumb/1');
  fireEvent.click(screen.getByRole('button', { name: 'Show thumbnail 2' }));
  assert.equal(current(), '/thumb/2');
  fireEvent.keyDown(screen.getByRole('region'), { key: 'ArrowRight' });
  assert.equal(current(), '/thumb/3');
  assert.ok(screen.getByText('3 / 3'));
});

test('render requirements are summarized in plain language', () => {
  assert.equal(formatRequirement({ width: { exact: 1920 }, height: { exact: 1080 }, frameRate: { exact: 25 } }), '1920 × 1080 px @ 25 fps');
  assert.equal(formatRequirement({ width: { min: 600, max: 4000, ideal: 1920 }, height: null, frameRate: null }), '600–4000 (ideal 1920) × any px');
  assert.equal(formatRequirement({ width: null, height: null, frameRate: null }), 'No constraints');
});

test('the detail page shows full description, creator, actions and properties', async () => {
  const detail = { versionId: 'v1', versionLabel: '1.0.0', display_name: 'Scoreboard', description: 'Line one\nLine two',
    source: 'seed_builtin', manifestId: 'scoreboard', author: { name: 'EBU', email: 'ograf@example.org', url: 'https://ebu.io/' },
    supportsRealTime: true, supportsNonRealTime: false, stepCount: 5, manifestVersion: '1.0.0',
    actions: [{ type: 'playAction', duration: 1500 }, { type: 'updateAction', duration: null }, { type: 'stopAction', duration: null }],
    customActions: [{ id: 'goal', name: 'Goal (Home)', description: 'Adds a goal.', hasParameters: false, duration: null }],
    renderRequirements: [], properties: [{ key: 'home', title: 'Home team', type: 'string', description: null }],
    thumbnails: [{ url: '/t/0', width: 1280, height: 720, animated: false }] };
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ item: detail }));
  const added = [];
  render(React.createElement(GraphicDetail, { versionId: 'v1', summary: { versionId: 'v1', display_name: 'Scoreboard', versionLabel: '1.0.0' },
    account: { id: 'account' }, Preview: () => null, AddButton: AddGraphicButton, onAdd: async (item) => { added.push(item.versionId); } }));
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Scoreboard' }));
  await waitFor(() => assert.ok(screen.getByText('Goal (Home)')));
  assert.equal(fetchMock.mock.calls[0].arguments[0], '/api/catalog/v1');
  assert.equal(screen.getByText(/Line one/).textContent, 'Line one\nLine two');
  assert.equal(screen.getByRole('link', { name: 'ebu.io' }).getAttribute('href'), 'https://ebu.io/');
  assert.equal(screen.getByRole('link', { name: 'ograf@example.org' }).getAttribute('href'), 'mailto:ograf@example.org');
  assert.ok(screen.getByText('Animates the graphic in and advances through 5 steps.'));
  assert.ok(screen.getByText('1.5 s'));
  assert.ok(screen.getByText('Home team'));
  assert.ok(screen.getByText('Built-in library'));
  fireEvent.click(screen.getByRole('button', { name: 'Add to rundown' }));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Added to rundown' })));
  assert.deepEqual(added, ['v1']);
});

test('the detail page reports unknown graphics and requires sign-in to add', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Graphic not found' }, { status: 404 }));
  render(React.createElement(GraphicDetail, { versionId: 'missing', summary: undefined, account: null,
    Preview: () => null, AddButton: AddGraphicButton, onAdd: async () => {} }));
  await waitFor(() => assert.ok(screen.getByText('Graphic not found')));
  assert.ok(screen.getByRole('link', { name: 'Back to catalog' }));
  cleanup();
  render(React.createElement(GraphicDetail, { versionId: 'missing', summary: { versionId: 'missing', display_name: 'Old', versionLabel: '1' }, account: null,
    Preview: () => null, AddButton: AddGraphicButton, onAdd: async () => {} }));
  assert.equal(screen.getByRole('button', { name: 'Add to rundown' }).disabled, true);
  assert.equal(screen.getByRole('link', { name: 'Login with Twitch' }).getAttribute('href'), '/api/auth/twitch');
});

test('the details menu item is offered for catalog and uploaded graphics but not disabled packages', () => {
  render(React.createElement(MyGraphicsView, { account: { id: 'account' }, loading: false, error: '', pending: new Set(), Preview: () => null,
    entries: [{ ...entry, origin: 'upload' }, { ...entry, entryId: '2', label: 'Gone', packageDisabled: true }],
    onRetry: () => {}, onSave: async () => {}, onAction: () => {}, onDelete: async () => {}, onReorder: async () => {}, onManifest: async () => ({}) }));
  fireEvent.click(screen.getByRole('button', { name: 'More options for Left' }));
  assert.equal(screen.getByRole('menuitem', { name: 'Show details' }).getAttribute('href'), '#graphic/version');
  fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  fireEvent.click(screen.getByRole('button', { name: 'More options for Gone' }));
  assertAbsent(screen.queryByRole('menuitem', { name: 'Show details' }));
});

test('property dialog actions stay pinned to the bottom while the form scrolls', async () => {
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.properties-form \.dialog-actions\s*\{[^}]*position:\s*sticky;[^}]*bottom:\s*0;/);
  render(React.createElement(PropertiesDialog, { entry, onSave: async () => {}, onClose: () => {} }));
  assert.ok(screen.getByRole('button', { name: 'Save properties' }).closest('.properties-form'));
});

test('file list properties render as a select of the package files and save the chosen path', async () => {
  const saved = [];
  const themes = { ...entry, schemaData: { theme: './themes/Default.css' }, schema: { type: 'object', properties: {
    theme: { type: 'string', title: 'Visual Theme', default: './themes/Default.css', v_spx: { ftype: 'filelist', extension: 'css', assetfolder: './themes/' },
      oneOf: [{ const: './themes/Bank.css', title: 'Bank.css' }, { const: './themes/Default.css', title: 'Default.css' }] }
  } } };
  render(React.createElement(PropertiesDialog, { entry: themes, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const select = screen.getByRole('combobox', { name: 'Visual Theme' });
  assert.deepEqual(within(select).getAllByRole('option').map((option) => option.textContent).filter(Boolean), ['Bank.css', 'Default.css']);
  fireEvent.change(select, { target: { value: within(select).getByRole('option', { name: 'Bank.css' }).value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved, [['1', { schemaData: { theme: './themes/Bank.css' } }]]));
});

test('the detail page menu shows the graphic manifest', async () => {
  const manifest = { id: 'scoreboard', name: 'Scoreboard', main: 'graphic.mjs' };
  const fetchMock = mock.method(globalThis, 'fetch', async (url) => url.endsWith('/manifest') ? Response.json({ manifest })
    : Response.json({ error: 'Detail unavailable' }, { status: 503 }));
  render(React.createElement(GraphicDetail, { versionId: 'v1', summary: { versionId: 'v1', display_name: 'Scoreboard', versionLabel: '1.0.0' },
    account: null, Preview: () => null, AddButton: AddGraphicButton, onAdd: async () => {} }));
  fireEvent.click(screen.getByRole('button', { name: 'More options for Scoreboard' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show manifest' }));
  await waitFor(() => assert.ok(screen.getByRole('dialog').textContent.includes('"main": "graphic.mjs"')));
  assert.ok(fetchMock.mock.calls.some(({ arguments: [url] }) => url === '/api/catalog/v1/manifest'));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }));
  assertAbsent(screen.queryByRole('dialog'));
});

test('properties show inline labels, description tooltips and SPX instructions as text', async () => {
  const saved = [];
  const described = { ...entry, schemaData: {}, schema: { type: 'object', properties: {
    instruction: { type: 'string', title: 'Instruction', default: 'Pick a theme first.', v_spx: { ftype: 'instruction' } },
    name: { type: 'string', title: 'Name', description: 'Shown on the first line' },
    live: { type: 'boolean', title: 'Live', description: 'Adds a live badge' }
  } } };
  render(React.createElement(PropertiesDialog, { entry: described, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const instruction = screen.getByText('Pick a theme first.');
  assert.equal(instruction.tagName, 'P');
  assertAbsent(screen.queryByRole('textbox', { name: 'Instruction' }));
  const name = screen.getByRole('textbox', { name: 'Name' });
  const row = name.closest('.property-row');
  assert.equal(row.firstElementChild.tagName, 'LABEL');
  assertAbsent(row.querySelector('.property-tooltip'));
  fireEvent.mouseEnter(row);
  assert.equal(row.querySelector('.property-tooltip').textContent, 'Shown on the first line');
  fireEvent.mouseLeave(row);
  assertAbsent(row.querySelector('.property-tooltip'));
  fireEvent.focus(name);
  assert.ok(row.querySelector('.property-tooltip'));
  fireEvent.blur(name);
  assertAbsent(row.querySelector('.property-tooltip'));
  assert.equal(screen.getByText('Shown on the first line').className, 'visually-hidden');
  assert.ok(name.getAttribute('aria-describedby').split(' ').includes(screen.getByText('Shown on the first line').id));
  const live = screen.getByRole('checkbox', { name: 'Live' }).closest('[data-has-tooltip]');
  fireEvent.mouseEnter(live);
  assert.equal(live.querySelector('.property-tooltip').textContent, 'Adds a live badge');
  fireEvent.mouseLeave(live);
  fireEvent.change(name, { target: { value: 'Host' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved, [['1', { schemaData: { instruction: 'Pick a theme first.', name: 'Host' } }]]));
});

test('the manifest dialog is wider than the other dialogs', async () => {
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.manifest-dialog\s*\{[^}]*width:\s*min\(1100px/);
  assert.match(styles, /\.properties-dialog\s*\{[^}]*width:\s*min\(880px/);
  assert.match(styles, /\.property-tooltip\s*\{[^}]*position:\s*fixed;[^}]*font:\s*15px/);
  showView();
  fireEvent.click(screen.getByRole('button', { name: 'More options for Left' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show manifest' }));
  assert.ok(screen.getByRole('dialog').classList.contains('manifest-dialog'));
});

const tokenUrls = { renderer: 'https://app.example.com/render/old/', api: 'https://app.example.com/api-old/ograf/v1/' };
function mockTokenApi({ failGet = {} } = {}) {
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const kind = url.split('/').at(-1);
    requests.push([url, options.method ?? 'GET']);
    if (options.method === 'POST') return Response.json({ url: tokenUrls[kind].replace('old', 'new') });
    if (failGet[kind]) return Response.json({ error: failGet[kind] }, { status: 409 });
    return Response.json({ url: tokenUrls[kind] });
  });
  return requests;
}

test('the renderer page shows the renderer and API URLs with open and copy actions', async () => {
  const requests = mockTokenApi();
  const copied = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { copied.push(text); } } });
  render(React.createElement(RendererView, { account: { id: 'account' }, authLoading: false }));
  await waitFor(() => assert.ok(screen.getByText(tokenUrls.api)));
  assert.ok(screen.getByText(tokenUrls.renderer));
  assert.deepEqual(requests.map(([url]) => url).sort(), ['/api/tokens/api', '/api/tokens/renderer']);
  for (const [name, url] of [['Open renderer', tokenUrls.renderer], ['Open API', tokenUrls.api]]) {
    const link = screen.getByRole('link', { name });
    assert.equal(link.getAttribute('href'), url);
    assert.equal(link.getAttribute('target'), '_blank');
    assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  }
  assert.equal(screen.getByRole('link', { name: 'interactive API documentation' }).getAttribute('href'), '/api-docs/');
  fireEvent.click(screen.getByRole('button', { name: 'Copy renderer URL' }));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Renderer URL copied' })));
  fireEvent.click(screen.getByRole('button', { name: 'Copy API URL' }));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'API URL copied' })));
  assert.deepEqual(copied, [tokenUrls.renderer, tokenUrls.api]);
  delete navigator.clipboard;
});

test('the renderer page asks signed-out users to sign in and reports lookup failures', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Sign-in required' }, { status: 401 }));
  render(React.createElement(RendererView, { account: null, authLoading: false }));
  assert.ok(screen.getByText('Sign in to get your renderer URL.'));
  assert.equal(screen.getByRole('link', { name: 'Login with Twitch' }).getAttribute('href'), '/api/auth/twitch');
  assertAbsent(screen.queryByRole('button', { name: 'New renderer token' }));
  assert.equal(fetchMock.mock.callCount(), 0);
  cleanup();
  render(React.createElement(RendererView, { account: { id: 'account' }, authLoading: false }));
  await waitFor(() => assert.equal(screen.getAllByRole('alert').length, 2));
  assertAbsent(screen.queryByRole('link', { name: 'Open renderer' }));
  assertAbsent(screen.queryByRole('link', { name: 'Open API' }));
});

test('creating a new token requires confirmation and only replaces that token', async () => {
  const requests = mockTokenApi();
  render(React.createElement(RendererView, { account: { id: 'account' }, authLoading: false }));
  await waitFor(() => assert.ok(screen.getByText(tokenUrls.api)));
  fireEvent.click(screen.getByRole('button', { name: 'New renderer token' }));
  assert.ok(screen.getByText('All renderer URLs with the current token stop working.'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  assert.equal(requests.filter(([, method]) => method === 'POST').length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'New renderer token' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create new token' }));
  await waitFor(() => assert.ok(screen.getByText('https://app.example.com/render/new/')));
  assert.deepEqual(requests.at(-1), ['/api/tokens/renderer', 'POST']);
  assert.equal(screen.getByRole('link', { name: 'Open renderer' }).getAttribute('href'), 'https://app.example.com/render/new/');
  assert.ok(screen.getByText('New URL created. Update your browser sources.'));
  assert.ok(screen.getByText(tokenUrls.api));
  fireEvent.click(screen.getByRole('button', { name: 'New API token' }));
  assert.ok(screen.getByText('Controllers using the current API URL stop working.'));
  fireEvent.click(screen.getByRole('button', { name: 'Create new token' }));
  await waitFor(() => assert.ok(screen.getByText('https://app.example.com/api-new/ograf/v1/')));
  assert.deepEqual(requests.at(-1), ['/api/tokens/api', 'POST']);
  assert.ok(screen.getByText('New API URL created. Update your controllers.'));
});

test('an unreadable token can still be replaced', async () => {
  mockTokenApi({ failGet: { api: 'This token cannot be read with the current encryption key. Create a new token.' } });
  render(React.createElement(RendererView, { account: { id: 'account' }, authLoading: false }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('cannot be read')));
  assert.ok(screen.getByText(tokenUrls.renderer));
  fireEvent.click(screen.getByRole('button', { name: 'New API token' }));
  fireEvent.click(screen.getByRole('button', { name: 'Create new token' }));
  await waitFor(() => assert.ok(screen.getByText('https://app.example.com/api-new/ograf/v1/')));
  assertAbsent(screen.queryByRole('alert'));
});

test('my graphics shows a sandboxed renderer preview scaled from 1920x1080 to 640x360', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ url: 'https://render.example.com/render/token/' }));
  const { RendererPreview } = await import(rendererViewUrl);
  showView({ rendererPreview: React.createElement(RendererPreview, { account: { id: 'account' } }) });
  const frame = await waitFor(() => screen.getByTitle('Renderer preview'));
  assert.equal(frame.getAttribute('src'), 'https://render.example.com/render/token/');
  assert.equal(frame.getAttribute('width'), '1920');
  assert.equal(frame.getAttribute('height'), '1080');
  assert.equal(frame.style.transform, `scale(${640 / 1920})`);
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(screen.getByRole('link', { name: 'Open renderer' }).getAttribute('href'), 'https://render.example.com/render/token/');
  fireEvent.click(screen.getByRole('button', { name: 'Reload preview' }));
  assert.ok(screen.getByTitle('Renderer preview') !== frame, 'Reload should replace the frame');
  assert.equal(screen.getAllByRole('listitem').length, 2);
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.renderer-preview\s*\{[^}]*width:\s*min\(640px, 100%\);/);
  // The app is dark; without a light scheme on the iframe the browser paints an opaque white canvas behind the renderer.
  assert.match(styles, /\.renderer-preview-frame iframe\s*\{[^}]*color-scheme:\s*light;/);
  assert.match(styles, /\.renderer-preview-frame\s*\{[^}]*aspect-ratio:\s*16 \/ 9;/);
});

test('the renderer preview reports a missing URL instead of an empty frame', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Renderer URL unavailable' }, { status: 503 }));
  const { RendererPreview } = await import(rendererViewUrl);
  render(React.createElement(RendererPreview, { account: { id: 'account' } }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('Renderer URL unavailable')));
  assertAbsent(screen.queryByTitle('Renderer preview'));
  cleanup();
  render(React.createElement(RendererPreview, { account: null }));
  assertAbsent(screen.queryByRole('heading', { name: 'Renderer preview' }));
});

test('GDD labels name the property fields and their enum options', async () => {
  const { displaySchema } = await import(myGraphicsUrl);
  const saved = [];
  const weather = { ...entry, schemaData: { _darkText: 0 }, schema: { type: 'object', properties: {
    _darkText: { enum: [0, 1], type: 'integer', label: 'Cityname Color', order: 0, default: 0, gddType: 'select',
      gddOptions: { labels: { 0: 'Light Text', 1: 'Dark Text' } } },
    city: { type: 'string', title: 'City', label: 'Ignored label' },
    plain: { type: 'string' }
  } } };
  render(React.createElement(PropertiesDialog, { entry: weather, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const select = screen.getByRole('combobox', { name: 'Cityname Color' });
  assert.deepEqual(within(select).getAllByRole('option').map((option) => option.textContent).filter(Boolean), ['Light Text', 'Dark Text']);
  assert.ok(screen.getByRole('textbox', { name: 'City' }));
  assertAbsent(screen.queryByText('_darkText'));
  fireEvent.change(select, { target: { value: within(select).getByRole('option', { name: 'Dark Text' }).value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved, [['1', { schemaData: { _darkText: 1 } }]]));
  assert.deepEqual(displaySchema({ type: 'string', enum: ['a'], gddOptions: { labels: { b: 'B' } } }).oneOf, [{ const: 'a', title: 'a' }]);
  assert.deepEqual(displaySchema({ type: 'string', enum: ['a'] }).enum, ['a']);
  assert.equal('title' in weather.schema.properties._darkText, false);
});

test('entries show their live renderer state and the heading counts renderer connections', () => {
  const control = { apiBaseUrl: 'https://app.example.com/t/ograf/v1/', rendererId: 'main', renderTarget: { entryId: '1' }, graphicId: 'version' };
  const live = [{ ...entry, control, live: { playing: true } }, { ...entry, entryId: '2', label: 'Right', control: { ...control, renderTarget: { entryId: '2' } }, live: { playing: false } },
    { ...entry, entryId: '3', label: 'Third', control: { ...control, renderTarget: { entryId: '3' } } },
    { ...entry, entryId: '4', label: 'Sting', control: { ...control, renderTarget: { entryId: '4' } }, live: { playing: false, ended: true } }];
  showView({ entries: live, rendererStatus: { connections: 2, instances: new Map() } });
  assert.ok(screen.getByText('2 renderers connected'));
  assert.ok(screen.getByText('On air').classList.contains('is-on-air'));
  assert.ok(screen.getByText('Loaded'));
  assert.ok(screen.getByText('Ready'));
  assert.ok(screen.getByText('Played'));
  assert.equal(screen.getAllByRole('button', { name: 'Play' })[0].disabled, false);
  cleanup();
  showView({ entries: [{ ...entry, control }], rendererStatus: { connections: 0, instances: new Map() } });
  assert.equal(screen.getAllByText('No renderer connected').length, 2);
});

function mockRundownApi({ onAir = 0 } = {}) {
  const state = { current: '1', rundowns: [{ id: '1', name: 'Default rundown', entryCount: 2 }, { id: '2', name: 'Sunday show', entryCount: 0 }], requests: [] };
  mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.requests.push([options.method ?? 'GET', url, body]);
    if (url === '/api/rundowns' && !options.method) return Response.json({ currentRundownId: state.current, rundowns: state.rundowns });
    if (url === '/api/rundowns' && options.method === 'POST') return Response.json({ rundown: { id: '3', name: body.name, entryCount: 0 } }, { status: 201 });
    if (url === '/api/rundowns/current') {
      if (onAir && !body.force) return Response.json({ error: `${onAir} graphics are on air in the current rundown`, code: 'ON_AIR', onAir }, { status: 409 });
      state.current = body.rundownId;
      return Response.json({ currentRundownId: body.rundownId });
    }
    if (url.startsWith('/api/rundowns/') && options.method === 'DELETE') return Response.json({ ok: true });
    if (url.startsWith('/api/rundowns/') && options.method === 'PATCH') {
      if (body.name === 'Default rundown') return Response.json({ error: 'A rundown with this name already exists' }, { status: 409 });
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected ${url}`);
  });
  return state;
}
const rundownAccount = { id: 'account' };
function RundownHarness({ onSwitched, onDeleted }) {
  const state = useRundowns(rundownAccount);
  return React.createElement(RundownPanel, { state, onSwitched, onDeleted });
}

test('the rundown panel lists rundowns, marks the current one and switches on click', async () => {
  const api = mockRundownApi();
  const switched = [];
  render(React.createElement(RundownHarness, { onSwitched: (rundown) => switched.push(rundown.name) }));
  const current = await waitFor(() => screen.getByRole('button', { name: /^Default rundown/ }));
  assert.equal(current.getAttribute('aria-current'), 'true');
  fireEvent.click(screen.getByRole('button', { name: /^Sunday show/ }));
  await waitFor(() => assert.equal(screen.getByRole('button', { name: /^Sunday show/ }).getAttribute('aria-current'), 'true'));
  assert.deepEqual(api.requests.at(-1), ['PUT', '/api/rundowns/current', { rundownId: '2', force: false }]);
  assert.deepEqual(switched, ['Sunday show']);
});

test('switching while graphics are on air asks for confirmation first', async () => {
  const api = mockRundownApi({ onAir: 2 });
  const switched = [];
  render(React.createElement(RundownHarness, { onSwitched: (rundown) => switched.push(rundown.name) }));
  fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /^Sunday show/ })));
  const confirm = await waitFor(() => screen.getByRole('group', { name: 'Confirm rundown switch' }));
  assert.match(confirm.textContent, /2 graphics are on air in the current rundown\. Switching to Sunday show takes them off air\./);
  assert.deepEqual(switched, []);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  assertAbsent(screen.queryByRole('group', { name: 'Confirm rundown switch' }));
  fireEvent.click(screen.getByRole('button', { name: /^Sunday show/ }));
  fireEvent.click(within(await waitFor(() => screen.getByRole('group', { name: 'Confirm rundown switch' }))).getByRole('button', { name: 'Switch' }));
  await waitFor(() => assert.deepEqual(switched, ['Sunday show']));
  assert.deepEqual(api.requests.at(-1), ['PUT', '/api/rundowns/current', { rundownId: '2', force: true }]);
});

test('rundowns can be created and renamed from the sidebar', async () => {
  const api = mockRundownApi();
  render(React.createElement(RundownHarness, { onSwitched: () => {} }));
  await waitFor(() => screen.getByRole('button', { name: /^Default rundown/ }));
  fireEvent.click(screen.getByRole('button', { name: 'New rundown' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'New rundown name' }), { target: { value: 'Monday news' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create rundown' }));
  await waitFor(() => screen.getByRole('button', { name: /^Monday news/ }));
  assert.deepEqual(api.requests.at(-1), ['POST', '/api/rundowns', { name: 'Monday news' }]);
  assert.equal(screen.getByRole('button', { name: /^Default rundown/ }).getAttribute('aria-current'), 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Rename Sunday show' }));
  const input = screen.getByRole('textbox', { name: 'Rundown name' });
  assert.equal(input.value, 'Sunday show');
  fireEvent.change(input, { target: { value: 'Default rundown' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => assert.ok(screen.getByRole('alert').textContent.includes('already exists')));
  fireEvent.change(screen.getByRole('textbox', { name: 'Rundown name' }), { target: { value: 'Sunday special' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => screen.getByRole('button', { name: /^Sunday special/ }));
  assert.deepEqual(api.requests.at(-1), ['PATCH', '/api/rundowns/2', { name: 'Sunday special' }]);
});

test('the rundown view is headed by the current rundown name', () => {
  showView({ rundownName: 'Sunday show' });
  assert.ok(screen.getByRole('heading', { level: 1, name: 'Sunday show' }));
  assert.ok(screen.getByText('RUNDOWN'));
});

test('rundowns other than the current one can be deleted after confirmation', async () => {
  const api = mockRundownApi();
  api.rundowns[1].entryCount = 3;
  const deleted = [];
  render(React.createElement(RundownHarness, { onSwitched: () => {}, onDeleted: (rundown) => deleted.push(rundown.name) }));
  await waitFor(() => screen.getByRole('button', { name: /^Sunday show/ }));
  assertAbsent(screen.queryByRole('button', { name: 'Delete Default rundown' }));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Sunday show' }));
  const confirm = screen.getByRole('group', { name: 'Confirm rundown deletion' });
  assert.match(confirm.textContent, /Delete Sunday show and its 3 graphics\? This cannot be undone\./);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
  assert.equal(api.requests.filter(([method]) => method === 'DELETE').length, 0);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Sunday show' }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Confirm rundown deletion' })).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assertAbsent(screen.queryByRole('button', { name: /^Sunday show/ })));
  assert.deepEqual(api.requests.at(-1), ['DELETE', '/api/rundowns/2', undefined]);
  assert.deepEqual(deleted, ['Sunday show']);
});

test('uploading a package shows what was imported and refreshes the private catalog', async () => {
  const requests = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push([url, options.method, options.headers['Content-Type'], options.body.name]);
    return Response.json({ saved: [{ name: 'Lower third', versionLabel: '1.2.0' }], skipped: [{ name: 'Clock', versionLabel: '1.0.0' }] }, { status: 201 });
  });
  let refreshed = 0;
  const { container } = render(React.createElement(PrivateCatalogView, { account: { id: 'account' }, authLoading: false, count: 0, maxZipBytes: 10485760,
    loading: false, error: '', onUploaded: async () => { refreshed += 1; } }));
  assert.ok(screen.getByText(/up to 10 MB/));
  assert.ok(screen.getByText('No uploads yet.'));
  const file = new dom.window.File(['zip'], 'graphics.ograf.zip', { type: 'application/zip' });
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
  await waitFor(() => assert.ok(screen.getByText('Uploaded Lower third v1.2.0.')));
  assert.ok(screen.getByText('Already uploaded: Clock v1.0.0.'));
  assert.deepEqual(requests, [['/api/private/packages', 'POST', 'application/zip', 'graphics.ograf.zip']]);
  assert.equal(refreshed, 1);
});

test('rejected uploads list every problem the server found', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'The package is not a valid OGraf package.',
    details: ['a.ograf.json: (manifest) must have required property \'main\'', 'tool.exe: File type not allowed'] }, { status: 422 }));
  let refreshed = 0;
  const { container } = render(React.createElement(PrivateCatalogView, { account: { id: 'account' }, authLoading: false, count: 2,
    loading: false, error: '', onUploaded: async () => { refreshed += 1; } }, React.createElement('p', null, 'cards')));
  fireEvent.drop(container.querySelector('.upload-zone'), { dataTransfer: { files: [new dom.window.File(['x'], 'bad.zip')] } });
  const alert = await waitFor(() => screen.getByRole('alert'));
  assert.match(alert.textContent, /bad\.zip: The package is not a valid OGraf package\./);
  assert.deepEqual(within(alert).getAllByRole('listitem').map((item) => item.textContent), ['a.ograf.json: (manifest) must have required property \'main\'', 'tool.exe: File type not allowed']);
  assert.equal(refreshed, 0);
  assert.ok(screen.getByText('cards'));
  assert.ok(screen.getByText('2 graphics'));
});

test('the private catalog asks signed-out visitors to sign in', () => {
  render(React.createElement(PrivateCatalogView, { account: null, authLoading: false, count: 0, loading: false, error: '', onUploaded: async () => {} }));
  assert.ok(screen.getByText('Sign in to upload your own graphics.'));
  assertAbsent(screen.queryByRole('button', { name: 'Choose file' }));
});

test('clicking a rundown opens the rundown view, switching first when needed', async () => {
  mockRundownApi();
  const opened = [];
  function Panel() {
    const state = useRundowns(rundownAccount);
    return React.createElement(RundownPanel, { state, viewing: true, onOpen: (rundown) => opened.push(rundown.name) });
  }
  render(React.createElement(Panel));
  const current = await waitFor(() => screen.getByRole('button', { name: /^Default rundown/ }));
  assert.ok(current.classList.contains('is-viewing'));
  fireEvent.click(current);
  assert.deepEqual(opened, ['Default rundown']);
  fireEvent.click(screen.getByRole('button', { name: /^Sunday show/ }));
  await waitFor(() => assert.deepEqual(opened, ['Default rundown', 'Sunday show']));
});

test('private graphics are marked as such on the detail page', async () => {
  mock.method(globalThis, 'fetch', async () => Response.json({ error: 'offline' }, { status: 503 }));
  render(React.createElement(GraphicDetail, { versionId: 'v9', summary: { versionId: 'v9', display_name: 'Mine', versionLabel: '2.0', isPrivate: true },
    account: { id: 'account' }, Preview: () => null, AddButton: AddGraphicButton, onAdd: async () => {} }));
  assert.ok(screen.getByText('PRIVATE GRAPHIC · v2.0'));
  assert.equal(screen.getByRole('link', { name: 'Back to private catalog' }).getAttribute('href'), '#private');
});

test('custom actions run from the entry menu, asking for a payload when the action has a schema', async () => {
  const control = { apiBaseUrl: 'https://app.example.com/t/ograf/v1/', rendererId: 'main', renderTarget: { entryId: '1' }, graphicId: 'version' };
  const customActions = [{ id: 'highlight', name: 'Highlight', description: 'Flash the name', schema: null },
    { id: 'setColor', name: 'Set color', description: null, schema: { type: 'object', properties: { color: { type: 'string', title: 'Color', default: 'red' } } } }];
  const runs = [];
  let fail = false;
  showView({ entries: [{ ...entry, control, customActions }, { ...entry, entryId: '2', label: 'Right', control }, { ...entry, entryId: '3', label: 'Off', customActions }],
    onCustomAction: async (item, action, payload) => {
      if (fail) throw new Error('The payload does not match the custom action\'s schema.');
      runs.push([item.entryId, action.id, payload]);
    } });
  assertAbsent(screen.queryByRole('button', { name: 'Custom actions for Right' }));
  assert.equal(screen.getByRole('button', { name: 'Custom actions for Off' }).disabled, true);
  fireEvent.click(screen.getByRole('button', { name: 'Custom actions for Left' }));
  const highlight = screen.getByRole('menuitem', { name: 'Highlight' });
  assert.equal(highlight.getAttribute('title'), 'Flash the name');
  fireEvent.click(highlight);
  await waitFor(() => assert.deepEqual(runs, [['1', 'highlight', {}]]));
  fireEvent.click(screen.getByRole('button', { name: 'Custom actions for Left' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Set color' }));
  const dialog = within(screen.getByRole('dialog'));
  assert.ok(dialog.getByRole('heading', { name: 'Set color' }));
  fail = true;
  fireEvent.change(dialog.getByRole('textbox', { name: 'Color' }), { target: { value: 'blue' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Run action' }));
  await waitFor(() => assert.match(dialog.getByRole('alert').textContent, /does not match/));
  fail = false;
  fireEvent.click(dialog.getByRole('button', { name: 'Run action' }));
  await waitFor(() => assertAbsent(screen.queryByRole('dialog')));
  assert.deepEqual(runs.at(-1), ['1', 'setColor', { color: 'blue' }]);
});

const groupEntries = [{ ...entry, entryId: '1', label: 'Left' },
  { ...entry, entryId: '2', label: 'Ticker', customActions: [{ id: 'speed', name: 'Set speed', schema: { type: 'object', properties: { speed: { type: 'number', title: 'Speed', default: 1 } } } },
    { id: 'pause', name: 'Pause', schema: null }] }];
function showGroups(props = {}) {
  const calls = [];
  render(React.createElement(GroupActionsPanel, { groups: [], entries: groupEntries, error: '', running: new Set(), disabled: false,
    onRun: (group) => calls.push(['run', group.id]), onSave: async (group, data) => { calls.push(['save', group?.id ?? null, data]); },
    onDelete: async (group) => { calls.push(['delete', group.id]); }, ...props }));
  return calls;
}

test('group actions show a run button and a pencil each', () => {
  const calls = showGroups({ groups: [{ id: '4', name: 'Opener', steps: [{ type: 'play', entryId: '1' }] }], running: new Set(['5']) });
  fireEvent.click(screen.getByRole('button', { name: 'Run Opener' }));
  assert.deepEqual(calls, [['run', '4']]);
  assert.equal(screen.getByRole('button', { name: 'Run Opener' }).getAttribute('title'), '1 step');
  fireEvent.click(screen.getByRole('button', { name: 'Edit Opener' }));
  const dialog = within(screen.getByRole('dialog'));
  assert.equal(dialog.getByRole('textbox', { name: 'Name' }).value, 'Opener');
  assert.equal(dialog.getByRole('combobox', { name: 'Step 1 type' }).value, 'play');
});

test('a new group action is built from play, sleep and custom action steps', async () => {
  const calls = showGroups();
  fireEvent.click(screen.getByRole('button', { name: 'New group action' }));
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.change(dialog.getByRole('textbox', { name: 'Name' }), { target: { value: 'Break' } });
  fireEvent.change(dialog.getByRole('combobox', { name: 'Step 1 type' }), { target: { value: 'stop' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Add step' }));
  fireEvent.change(dialog.getByRole('combobox', { name: 'Step 2 type' }), { target: { value: 'sleep' } });
  fireEvent.change(dialog.getByRole('spinbutton', { name: 'Step 2 seconds' }), { target: { value: '1.5' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Add step' }));
  fireEvent.change(dialog.getByRole('combobox', { name: 'Step 3 type' }), { target: { value: 'custom' } });
  assert.ok(dialog.getByText('This graphic has no custom actions'));
  fireEvent.change(dialog.getByRole('combobox', { name: 'Step 3 graphic' }), { target: { value: '2' } });
  assert.equal(dialog.getByRole('combobox', { name: 'Step 3 custom action' }).value, 'speed');
  fireEvent.change(dialog.getByRole('spinbutton', { name: 'Speed' }), { target: { value: '3' } });
  fireEvent.click(dialog.getByRole('button', { name: 'Move step 3 up' }));
  fireEvent.click(dialog.getByRole('button', { name: 'Save group action' }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0], ['save', null, { name: 'Break', steps: [{ type: 'stop', entryId: '1' },
    { type: 'custom', entryId: '2', actionId: 'speed', payload: { speed: 3 } }, { type: 'sleep', ms: 1500 }] }]);
  await waitFor(() => assertAbsent(screen.queryByRole('dialog')));
});

test('server validation problems stay visible and group actions can be deleted', async () => {
  const group = { id: '4', name: 'Opener', steps: [{ type: 'play', entryId: '99' }] };
  let attempts = 0;
  const calls = showGroups({ groups: [group], onSave: async () => {
    attempts += 1;
    throw Object.assign(new Error('The group action has invalid steps'), { payload: { details: ['Step 1: the graphic is not in the current rundown'] } });
  } });
  fireEvent.click(screen.getByRole('button', { name: 'Edit Opener' }));
  const dialog = within(screen.getByRole('dialog'));
  assert.equal(dialog.getByRole('combobox', { name: 'Step 1 graphic' }).value, '');
  assert.ok(dialog.getByRole('option', { name: 'Missing graphic' }));
  fireEvent.click(dialog.getByRole('button', { name: 'Save group action' }));
  await waitFor(() => assert.match(dialog.getByRole('alert').textContent, /Step 1: the graphic is not in the current rundown/));
  assert.equal(attempts, 1);
  fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
  const confirm = within(dialog.getByRole('group', { name: 'Confirm group action deletion' }));
  fireEvent.click(confirm.getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(calls, [['delete', '4']]));
});

test('new group actions need graphics in the rundown', () => {
  showGroups({ entries: [] });
  assert.equal(screen.getByRole('button', { name: 'New group action' }).disabled, true);
});

test('the landing page elements render: logo, Twitch login, hero art and the feature row', () => {
  render(React.createElement('div', null, React.createElement(Logo), React.createElement(TwitchLogin), React.createElement(HeroArt), React.createElement(FeatureRow)));
  assert.equal(screen.getByRole('link', { name: 'Login with Twitch' }).getAttribute('href'), '/api/auth/twitch');
  assert.deepEqual(screen.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
    ['Works with OBS & vMix', 'Controller ready', 'Customizable & extensible', 'Built on an open standard', 'Log in and go']);
  const hero = screen.getByRole('img', { name: /astronaut on a moon/ });
  assert.equal(hero.getAttribute('src'), '/brand/hero-astronaut-1536.webp');
  assert.match(hero.getAttribute('srcset'), /hero-astronaut-768\.webp 768w/);
});

test('the entry menu duplicates only the selected entry', async () => {
  const duplicated = [];
  showView({ onDuplicate: async (item) => { duplicated.push(item.entryId); } });
  fireEvent.click(screen.getByRole('button', { name: 'More options for Right' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Duplicate' }));
  await waitFor(() => assert.deepEqual(duplicated, ['2']));
  assertAbsent(screen.queryByRole('menu'));
});

test('properties are shown in GDD order: lower values first, unordered ones after in manifest order', async () => {
  const { displaySchema } = await import(myGraphicsUrl);
  const wheel = { ...entry, schemaData: {}, schema: { type: 'object', properties: {
    line1: { type: 'string', title: 'Line 1', order: 5 },
    notes: { type: 'string', title: 'Notes' },
    position: { type: 'string', title: 'Position', order: 2 },
    extra: { type: 'string', title: 'Extra' },
    title: { type: 'string', title: 'Title', order: 1 },
    nested: { type: 'object', title: 'Nested', order: 3, properties: { b: { type: 'string', title: 'B', order: 2 }, a: { type: 'string', title: 'A', order: 1 } } }
  } } };
  assert.deepEqual(Object.keys(displaySchema(wheel.schema).properties), ['title', 'position', 'nested', 'line1', 'notes', 'extra']);
  render(React.createElement(PropertiesDialog, { entry: wheel, onSave: async () => {}, onClose: () => {} }));
  const labels = [...screen.getByRole('dialog').querySelectorAll('input[type="text"], input:not([type])')].map((input) =>
    screen.getByRole('dialog').querySelector(`label[for="${input.id}"]`)?.textContent.replace(/\\*$/, ''));
  assert.deepEqual(labels, ['Title', 'Position', 'A', 'B', 'Line 1', 'Notes', 'Extra']);
});

test('the YouTube login is only offered when the server has Google configured', () => {
  const buttons = (providers) => render(React.createElement(LoginProvidersContext.Provider, { value: providers }, React.createElement(LoginButtons)));
  buttons({ twitch: true, google: false });
  assert.ok(screen.getByRole('link', { name: 'Login with Twitch' }));
  assertAbsent(screen.queryByRole('link', { name: 'Login with YouTube' }));
  cleanup();
  buttons({ twitch: true, google: true });
  assert.equal(screen.getByRole('link', { name: 'Login with YouTube' }).getAttribute('href'), '/api/auth/google');
  cleanup();
  buttons({ twitch: false, google: true });
  assertAbsent(screen.queryByRole('link', { name: 'Login with Twitch' }));
});

test('the catalog search can be cleared with the x button or Escape', () => {
  function Harness() {
    const [value, setValue] = React.useState('lower');
    return React.createElement(SearchBox, { value, onChange: setValue });
  }
  render(React.createElement(Harness));
  const input = screen.getByRole('textbox', { name: 'Search graphics' });
  assert.equal(input.value, 'lower');
  fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
  assert.equal(input.value, '');
  assertFocused(input);
  assertAbsent(screen.queryByRole('button', { name: 'Clear search' }));
  fireEvent.change(input, { target: { value: 'clock' } });
  assert.ok(screen.getByRole('button', { name: 'Clear search' }));
  fireEvent.keyDown(input, { key: 'Escape' });
  assert.equal(input.value, '');
});

function fakeMedia(items) {
  const calls = [];
  const media = { items: [...items], maxBytes: 20971520, extensions: ['png', 'jpg', 'mp4'], error: '', loading: false, reload: async () => {},
    upload: async (file) => { calls.push(['upload', file.name]); const item = { id: 'new', name: file.name, extension: 'png', size: 3, usage: 0,
      url: 'https://render.example.com/render/media/new.png', previewUrl: '/api/media/new/content' }; media.items.unshift(item); return item; },
    replace: async (item, file) => { calls.push(['replace', item.id, file.name]); },
    rename: async (item, name) => { calls.push(['rename', item.id, name]); },
    remove: async (item) => { calls.push(['remove', item.id]); } };
  return { media, calls };
}
const libraryItems = [
  { id: 'a', name: 'Hannover.jpg', extension: 'jpg', size: 2048, usage: 2, url: 'https://render.example.com/render/media/a.jpg', previewUrl: '/api/media/a/content' },
  { id: 'b', name: 'Intro.mp4', extension: 'mp4', size: 4096, usage: 0, url: 'https://render.example.com/render/media/b.mp4', previewUrl: '/api/media/b/content' }
];
const imageEntry = { ...entry, schemaData: { _image: './lib/images/image_0.jpg' }, schema: { type: 'object', properties: {
  _image: { type: 'string', label: 'image', default: './lib/images/image_0.jpg', gddType: 'file-path/image-path', gddOptions: { extensions: ['jpg', 'png'] } }
} } };

test('image properties offer the default, the media library (filtered by extension) and uploading', async () => {
  const { media, calls } = fakeMedia(libraryItems);
  const saved = [];
  render(React.createElement(PropertiesDialog, { entry: imageEntry, media, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const dialog = within(screen.getByRole('dialog'));
  const current = () => screen.getByRole('dialog').querySelector('.media-field-label').textContent;
  assert.equal(current(), 'Defaultimage_0.jpg');
  assert.equal(dialog.getByRole('button', { name: 'Default' }).disabled, true);
  fireEvent.click(dialog.getByRole('button', { name: 'Media library' }));
  const options = dialog.getAllByRole('option');
  assert.deepEqual(options.map((option) => option.textContent), ['Hannover.jpg']);
  fireEvent.click(options[0]);
  assert.equal(current(), 'Hannover.jpgMedia library');
  fireEvent.click(dialog.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved.at(-1), ['1', { schemaData: { _image: 'https://render.example.com/render/media/a.jpg' } }]));
  cleanup();
  render(React.createElement(PropertiesDialog, { entry: { ...imageEntry, schemaData: { _image: libraryItems[0].url } }, media, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const second = within(screen.getByRole('dialog'));
  const input = screen.getByRole('dialog').querySelector('input[type="file"]');
  assert.equal(input.getAttribute('accept'), '.jpg,.png');
  fireEvent.change(input, { target: { files: [new dom.window.File(['img'], 'Berlin.png', { type: 'image/png' })] } });
  await waitFor(() => assert.equal(screen.getByRole('dialog').querySelector('.media-field-label').textContent, 'Berlin.pngMedia library'));
  assert.deepEqual(calls, [['upload', 'Berlin.png']]);
  fireEvent.click(second.getByRole('button', { name: 'Default' }));
  fireEvent.click(second.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved.at(-1), ['1', { schemaData: { _image: './lib/images/image_0.jpg' } }]));
});

test('file fields accept the listed extensions, images by default for image paths, anything otherwise', () => {
  assert.deepEqual(acceptedExtensions({ gddOptions: { extensions: ['.PNG', 'jpg'] } }), ['png', 'jpg']);
  assert.ok(acceptedExtensions({ gddType: 'file-path/image-path' }).includes('webp'));
  assert.equal(acceptedExtensions({ gddType: 'file-path' }), null);
});

test('the media catalog lists files and lets the owner rename, replace and delete them', async () => {
  const { media, calls } = fakeMedia(libraryItems);
  render(React.createElement(MediaCatalogView, { account: { id: 'account' }, authLoading: false, media }));
  assert.ok(screen.getByRole('heading', { level: 3, name: 'Hannover.jpg' }));
  assert.ok(screen.getByText('.jpg · 2.0 KB · used by 2 entries'));
  assert.ok(screen.getByText('.mp4 · 4.0 KB · not used'));
  fireEvent.click(screen.getByRole('button', { name: 'Rename Hannover.jpg' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'File name' }), { target: { value: 'City.jpg' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
  await waitFor(() => assert.deepEqual(calls.at(-1), ['rename', 'a', 'City.jpg']));
  fireEvent.change(screen.getByLabelText('Replacement for Hannover.jpg'), { target: { files: [new dom.window.File(['x'], 'new.jpg')] } });
  await waitFor(() => assert.deepEqual(calls.at(-1), ['replace', 'a', 'new.jpg']));
  fireEvent.click(screen.getByRole('button', { name: 'Delete Hannover.jpg' }));
  const confirm = screen.getByRole('group', { name: 'Confirm deleting Hannover.jpg' });
  assert.match(confirm.textContent, /2 rundown entries use it/);
  fireEvent.click(within(confirm).getByRole('button', { name: 'Delete' }));
  await waitFor(() => assert.deepEqual(calls.at(-1), ['remove', 'a']));
  fireEvent.change(screen.getByLabelText('Choose files to upload'), { target: { files: [new dom.window.File(['1'], 'a.png'), new dom.window.File(['2'], 'b.png')] } });
  await waitFor(() => assert.deepEqual(calls.slice(-2), [['upload', 'a.png'], ['upload', 'b.png']]));
});

const colorEntry = { ...entry, schemaData: {}, schema: { type: 'object', properties: {
  homeColor: { type: 'string', label: 'Home colour', gddType: 'color-rrggbb', default: '#005ca9', pattern: '^#[0-9a-f]{6}$' },
  shade: { type: 'string', label: 'Shade', gddType: 'color-rrggbbaa', default: '#00000080' }
} } };

test('the colour picker shows the picker area, the hue bar and the last 8 colours picked in one panel', async () => {
  const saved = [];
  render(React.createElement(PropertiesDialog, { entry: colorEntry, onSave: async (...args) => { saved.push(args); }, onClose: () => {} }));
  const dialog = within(screen.getByRole('dialog'));
  const hex = dialog.getByLabelText('Home colour');
  const swatch = dialog.getByRole('button', { name: 'Pick Home colour' });
  assert.equal(hex.value, '#005ca9');
  const panel = () => within(dialog.getByRole('group', { name: 'Home colour picker' }));
  const recent = () => panel().queryAllByRole('button', { name: /^Use / }).map((button) => button.title);
  fireEvent.click(swatch);
  assert.equal(swatch.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(recent(), []);
  // Moving in the panel changes the value; only closing the panel marks the colour as picked.
  const area = panel().getByRole('slider', { name: 'Saturation and brightness' });
  const hue = panel().getByRole('slider', { name: 'Hue' });
  fireEvent.keyDown(hue, { key: 'Home' });
  for (let press = 0; press < 4; press += 1) fireEvent.keyDown(area, { key: 'ArrowUp', shiftKey: true });
  assert.equal(hex.value, '#ff0000');
  fireEvent.keyDown(area, { key: 'ArrowLeft', shiftKey: true });
  assert.equal(hex.value, '#ff1919');
  assert.deepEqual(recent(), []);
  fireEvent.click(swatch);
  assert.equal(dialog.queryByRole('group', { name: 'Home colour picker' }), null);
  // Typed colours count when the field is left; shorthand and upper case are normalized.
  fireEvent.change(hex, { target: { value: '#ABC' } });
  fireEvent.blur(hex);
  assert.equal(hex.value, '#aabbcc');
  for (const color of ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666', '#777777']) {
    fireEvent.change(hex, { target: { value: color } });
    fireEvent.blur(hex);
  }
  fireEvent.click(swatch);
  assert.deepEqual(recent(), ['#777777', '#666666', '#555555', '#444444', '#333333', '#222222', '#111111', '#aabbcc']);
  assert.equal(panel().getByRole('button', { name: 'Use #777777' }).getAttribute('aria-pressed'), 'true');
  fireEvent.click(panel().getByRole('button', { name: 'Use #aabbcc' }));
  assert.equal(hex.value, '#aabbcc');
  // Escape closes the panel (and records the pick), not the dialog.
  fireEvent.keyDown(panel().getByRole('button', { name: 'Use #aabbcc' }), { key: 'Escape' });
  assert.equal(dialog.queryByRole('group', { name: 'Home colour picker' }), null);
  assert.ok(screen.getByRole('dialog').open);
  fireEvent.click(swatch);
  assert.equal(recent()[0], '#aabbcc');
  fireEvent.pointerDown(document.body);
  assert.equal(dialog.queryByRole('group', { name: 'Home colour picker' }), null);
  // Fields with opacity keep it when a colour is picked.
  const shade = dialog.getByLabelText('Shade');
  assert.equal(shade.value, '#00000080');
  fireEvent.click(dialog.getByRole('button', { name: 'Pick Shade' }));
  fireEvent.click(within(dialog.getByRole('group', { name: 'Shade picker' })).getByRole('button', { name: 'Use #777777' }));
  assert.equal(shade.value, '#77777780');
  fireEvent.change(dialog.getByRole('slider', { name: 'Opacity' }), { target: { value: '100' } });
  assert.equal(shade.value, '#777777ff');
  fireEvent.change(hex, { target: { value: 'nonsense' } });
  fireEvent.blur(hex);
  assert.equal(hex.value, '#aabbcc');
  fireEvent.click(dialog.getAllByRole('button', { name: 'Default' })[0]);
  fireEvent.click(dialog.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved.at(-1), ['1', { schemaData: { homeColor: '#005ca9', shade: '#777777ff' } }]));
});

test('colours are parsed leniently and written in the form the field pattern expects', () => {
  assert.deepEqual(parseColor('ABC'), { rgb: '#aabbcc', alpha: 'ff' });
  assert.deepEqual(parseColor('#00112233'), { rgb: '#001122', alpha: '33' });
  assert.equal(parseColor('#12345'), null);
  for (const color of ['#005ca9', '#ffffff', '#000000', '#ff0000', '#7a1fa2', '#00a651']) assert.equal(hsvToHex(hexToHsv(color)), color);
  assert.deepEqual(hexToHsv('#ff0000'), { h: 0, s: 1, v: 1 });
  assert.equal(formatColor({ gddType: 'color-rrggbb' }, { rgb: '#aabbcc', alpha: '80' }), '#aabbcc');
  assert.equal(formatColor({ gddType: 'color-rrggbbaa' }, { rgb: '#aabbcc', alpha: '80' }), '#aabbcc80');
  assert.equal(formatColor({ gddType: 'color-rrggbb', pattern: '^#[0-9A-F]{6}$' }, { rgb: '#aabbcc', alpha: 'ff' }), '#AABBCC');
});
