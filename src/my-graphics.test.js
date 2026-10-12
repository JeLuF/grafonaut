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
const compiled = await compileModule('./my-graphics.jsx');
const myGraphicsUrl = compiled.url;
const graphicDetailUrl = (await compileModule('./graphic-detail.jsx', { './my-graphics.jsx': myGraphicsUrl })).url;
const { default: MyGraphicsView, PropertiesDialog } = await import(myGraphicsUrl);
const { default: GraphicDetail, ThumbnailCarousel, formatRequirement } = await import(graphicDetailUrl);
const mainUrl = new URL('./main.jsx', import.meta.url);
const compiledMain = await transformAsync(await fs.readFile(mainUrl, 'utf8'), {
  filename: mainUrl.pathname, configFile: false, babelrc: false, plugins: [jsx, () => ({ visitor: {
    ImportDeclaration(importPath) {
      const file = importPath.node.source.value;
      if (file.endsWith('.css')) { importPath.remove(); return; }
      const local = { './my-graphics.jsx': myGraphicsUrl, './graphic-detail.jsx': graphicDetailUrl };
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
const { AddGraphicButton, Pagination, Toast, pageNumbers, parseRoute } = await import(`data:text/javascript,${encodeURIComponent(compiledMain.code)}`);
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
  assert.equal(screen.queryByRole('textbox', { name: 'Label' }), null);
  assert.equal(screen.getAllByText('Lower third').length, 2);
  assert.equal(screen.getAllByRole('checkbox').length, 2);
  assert.equal(screen.getAllByRole('button', { name: 'Play' })[0].disabled, true);
  assert.equal(screen.getAllByText('Renderer unavailable').length, 2);
});
test('saving a label and toggling enabled only target the selected entry', async () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  assert.equal(document.activeElement, screen.getByRole('textbox', { name: 'Label' }));
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
    assert.equal(row.querySelector('.entry-original-name'), null);
    assert.ok(row.querySelector('.entry-meta').textContent.includes('v1.0.0'));
  }
});

test('cancelling a label edit restores the saved heading without saving', () => {
  const calls = showView();
  fireEvent.click(screen.getByRole('button', { name: 'Edit label for Left' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Label' }), { target: { value: 'Unsaved' } });
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Label' }), { key: 'Escape' });
  assert.ok(screen.getByRole('heading', { name: 'Left' }));
  assert.equal(screen.queryByRole('textbox', { name: 'Label' }), null);
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
  const details = screen.getByRole('menuitem', { name: 'Show details' });
  assert.equal(document.activeElement, details);
  assert.equal(details.getAttribute('href'), '#graphic/version');
  fireEvent.keyDown(details, { key: 'ArrowDown' });
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
test('hash routes resolve catalog, my graphics and graphic detail views', () => {
  assert.deepEqual(parseRoute(''), { view: 'catalog' });
  assert.deepEqual(parseRoute('#my-graphics'), { view: 'my-graphics' });
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
  assert.equal(screen.queryByRole('navigation'), null);
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
  fireEvent.click(screen.getByRole('button', { name: 'Add to My Graphics' }));
  await waitFor(() => assert.ok(screen.getByRole('button', { name: 'Added to My Graphics' })));
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
  assert.equal(screen.getByRole('button', { name: 'Add to My Graphics' }).disabled, true);
  assert.ok(screen.getByRole('link', { name: 'Sign in to add' }));
});

test('the details menu item is only offered for available catalog graphics', () => {
  render(React.createElement(MyGraphicsView, { account: { id: 'account' }, loading: false, error: '', pending: new Set(), Preview: () => null,
    entries: [{ ...entry, origin: 'upload' }, { ...entry, entryId: '2', label: 'Gone', packageDisabled: true }],
    onRetry: () => {}, onSave: async () => {}, onAction: () => {}, onDelete: async () => {}, onReorder: async () => {}, onManifest: async () => ({}) }));
  for (const name of ['More options for Left', 'More options for Gone']) {
    fireEvent.click(screen.getByRole('button', { name }));
    assert.equal(screen.queryByRole('menuitem', { name: 'Show details' }), null);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
  }
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
  assert.equal(screen.queryByRole('dialog'), null);
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
  assert.equal(screen.queryByRole('textbox', { name: 'Instruction' }), null);
  const name = screen.getByRole('textbox', { name: 'Name' });
  const row = name.closest('.property-row');
  assert.equal(row.getAttribute('title'), 'Shown on the first line');
  assert.equal(row.firstElementChild.tagName, 'LABEL');
  assert.equal(screen.getByText('Shown on the first line').className, 'visually-hidden');
  assert.ok(name.getAttribute('aria-describedby').split(' ').includes(screen.getByText('Shown on the first line').id));
  assert.equal(screen.getByRole('checkbox', { name: 'Live' }).closest('[title]').getAttribute('title'), 'Adds a live badge');
  fireEvent.change(name, { target: { value: 'Host' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save properties' }));
  await waitFor(() => assert.deepEqual(saved, [['1', { schemaData: { instruction: 'Pick a theme first.', name: 'Host' } }]]));
});

test('the manifest dialog is wider than the other dialogs', async () => {
  const styles = await fs.readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.manifest-dialog\s*\{[^}]*width:\s*min\(1100px/);
  showView();
  fireEvent.click(screen.getByRole('button', { name: 'More options for Left' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show manifest' }));
  assert.ok(screen.getByRole('dialog').classList.contains('manifest-dialog'));
});
