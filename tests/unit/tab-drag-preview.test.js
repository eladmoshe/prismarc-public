import test from 'node:test';
import assert from 'node:assert/strict';
import { TabDragPreview } from '../../tab-drag-preview.js';

function fixture() {
    const listeners = {};
    const document = { addEventListener(type, listener) { listeners[type] = listener; } };
    let cancelled = 0, removed = 0, restored = 0;
    const preview = new TabDragPreview(document, () => cancelled++);
    preview.rows = [{ classList: { remove() { restored++; } } }];
    const root = { contains: () => true };
    const container = { closest: () => root };
    const before = {};
    preview.slot = { isConnected: true, parentElement: container, nextElementSibling: before,
        closest: () => root, remove() { removed++; } };
    const event = () => ({ target: { closest: () => root }, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } });
    return { preview, listeners, root, container, before, event,
        state: () => ({ cancelled, removed, restored }) };
}

test('Escape restores the preview and blocks later drops until dragend', () => {
    const f = fixture();
    f.listeners.keydown({ ...f.event(), key: 'Escape' });
    assert.equal(f.preview.cancelled, true);
    assert.deepEqual(f.state(), { cancelled: 1, removed: 1, restored: 1 });
    const drop = f.event();
    f.listeners.drop(drop);
    assert.equal(drop.prevented, true);
    assert.equal(drop.stopped, true);
    f.preview.end();
    assert.equal(f.preview.cancelled, false);
    assert.equal(f.preview.rows.length, 0);
});

test('right mouse down cancels and ordinary left mouse down does not', () => {
    const f = fixture();
    f.listeners.mousedown({ ...f.event(), button: 0 });
    assert.equal(f.preview.cancelled, undefined);
    f.listeners.mousedown({ ...f.event(), button: 2 });
    assert.equal(f.preview.cancelled, true);
    assert.equal(f.state().cancelled, 1);
    f.preview.end();
    const menu = f.event();
    f.listeners.contextmenu(menu);
    assert.equal(menu.prevented, true);
});

test('drop captures the visible destination and keeps the slot through native dragend until commit', () => {
    const f = fixture();
    assert.deepEqual(f.preview.takeDrop(f.root), { container: f.container, before: f.before });
    f.preview.end();
    assert.equal(f.state().removed, 0);
    f.preview.finish();
    assert.equal(f.state().removed, 1);
    assert.equal(f.preview.rows.length, 0);
});

test('leaving a valid target restores layout without persisting or ending the drag', () => {
    const f = fixture();
    f.listeners.dragover({ target: { closest: () => null } });
    assert.equal(f.state().removed, 1);
    assert.equal(f.preview.rows.length, 1);
    assert.equal(f.state().cancelled, 0);
});
