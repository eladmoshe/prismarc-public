import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { getContextTabIds } from '../../tab-selection.js';

const source = readFileSync(new URL('../../sidebar.js', import.meta.url), 'utf8');
const handlers = source.slice(source.indexOf('function setupTabDragHandlers('),
    source.indexOf('// A tab dropped on a folder header'));

function element(id = '') {
    const classes = new Set();
    const listeners = new Map();
    return { dataset: { tabId: id }, closest: () => null,
        classList: { add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name) },
        addEventListener: (type, handler) => listeners.set(type, handler),
        fire: (type, event = {}) => listeners.get(type)(event),
    };
}

function fixture() {
    const tabs = [element('1'), element('2')];
    let refreshes = 0;
    let previewsEnded = 0;
    let foldersRestored = 0;
    const document = { activeElement: null, querySelectorAll: () => tabs };
    const context = { document, getContextTabIds, selectedTabIds: new Set([1, 2]), tabDropCommitting: false, pendingMutationCount: 0,
        getOrderedTabElementsById: ids => tabs.filter(tab => ids.includes(Number(tab.dataset.tabId))),
        refreshCoordinator: { schedule: () => refreshes++ } };
    context.tabDragPreview = { start() {}, end() {} };
    context.tabPointerDrag = { prepare() {} };
    context.addDragListener = (element, type, listener) => element.addEventListener(type, listener);
    context.hideAllDropIndicators = () => {};
    context.clearFolderOpenTimer = () => {};
    context.endSpaceDragPreview = () => previewsEnded++;
    context.restoreDragFolders = () => foldersRestored++;
    const api = runInNewContext(`'use strict'; let isDraggingTab = false; let draggingTabIds = [];
        ${handlers}
        ({ setupTabDragHandlers, setupFolderDragHandlers,
           state: () => ({ isDraggingTab, draggingTabIds }) });`, context);
    const data = [];
    const dataTransfer = { setData: (...args) => data.push(args) };
    return { api, tabs, document, dataTransfer, data, refreshes: () => refreshes,
        previewsEnded: () => previewsEnded, foldersRestored: () => foldersRestored };
}

test('tab drag starts and ends in module strict mode, clears multi-selection styling, and resumes refresh', () => {
    const f = fixture();
    f.api.setupTabDragHandlers(f.tabs[0]);
    f.tabs[0].fire('dragstart', { dataTransfer: f.dataTransfer });
    assert.equal(f.api.state().isDraggingTab, true);
    assert.deepEqual([...f.api.state().draggingTabIds], [1, 2]);
    assert.ok(f.tabs.every(tab => tab.classList.contains('multi-dragging')));
    assert.deepEqual(f.data, [['text/plain', '1']]);
    f.tabs[0].fire('dragend');
    assert.equal(f.api.state().isDraggingTab, false);
    assert.deepEqual([...f.api.state().draggingTabIds], []);
    assert.ok(f.tabs.every(tab => !tab.classList.contains('dragging') && !tab.classList.contains('multi-dragging')));
    assert.equal(f.previewsEnded(), 1);
    assert.equal(f.foldersRestored(), 1);
    assert.equal(f.refreshes(), 1);
});

test('folder drag starts and ends without undeclared state and resumes refresh', () => {
    const f = fixture();
    const header = element();
    header.querySelector = () => ({});
    const folder = element();
    folder.dataset.bookmarkId = 'folder';
    folder.querySelector = () => header;
    folder.parentElement = { closest: () => null };
    f.api.setupFolderDragHandlers(folder);
    header.fire('dragstart', { target: header, dataTransfer: f.dataTransfer });
    assert.equal(f.api.state().isDraggingTab, true);
    assert.equal(folder.classList.contains('dragging'), true);
    assert.deepEqual(f.data, [['text/plain', 'folder']]);
    header.fire('dragend');
    assert.equal(f.api.state().isDraggingTab, false);
    assert.equal(folder.classList.contains('dragging'), false);
    assert.equal(f.refreshes(), 1);
});

test('folder header ignores bubbled child drags and prevents dragging an active name editor', () => {
    const f = fixture();
    const header = element(), editor = {};
    header.querySelector = () => editor;
    const folder = element();
    folder.querySelector = () => header;
    f.api.setupFolderDragHandlers(folder);
    header.fire('dragstart', { target: {} });
    assert.equal(f.api.state().isDraggingTab, false);
    f.document.activeElement = editor;
    let prevented = false;
    header.fire('dragstart', { target: header, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.api.state().isDraggingTab, false);
});
