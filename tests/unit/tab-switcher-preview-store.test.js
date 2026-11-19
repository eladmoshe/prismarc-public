import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TabSwitcherPreviewStore, previewStorageMode } from '../../tab-switcher-preview-store.js';

const image = 'data:image/jpeg;base64,' + btoa('synthetic thumbnail');

function area() {
    const values = {};
    const reads = [];
    return {
        values, reads,
        async get(key) {
            reads.push(key);
            return structuredClone(key === null ? values : { [key]: values[key] });
        },
        async getKeys() { return Object.keys(values); },
        async set(items) { Object.assign(values, structuredClone(items)); },
        async remove(keys) { for (const key of keys) delete values[key]; },
    };
}

test('reduced images use authenticated ciphertext, distinct nonces and an in-memory session key', async () => {
    const storage = { local: area(), session: area() };
    const first = new TabSwitcherPreviewStore({ storage });
    const [a, b] = await Promise.all([first.put(image, true), first.put(image, true)]);
    const c = await first.put(image, false);
    assert.equal(previewStorageMode(a), 'disk');
    assert.equal(previewStorageMode(c), 'session');
    assert.deepEqual(Object.keys(storage.local.values).sort(), [a, b].sort());
    assert.deepEqual(Object.keys(storage.local.values[a]).sort(), ['ciphertext', 'iv']);
    assert.notEqual(storage.local.values[a].iv, storage.local.values[b].iv);
    assert.notEqual(storage.local.values[a].ciphertext, storage.local.values[b].ciphertext);
    for (const area of Object.values(storage)) {
        assert.ok(!JSON.stringify(area.values).includes(image.split(',')[1]));
    }
    const awakened = new TabSwitcherPreviewStore({ storage });
    storage.local.reads.length = 0;
    assert.equal(await awakened.read(a), image);
    assert.deepEqual(storage.local.reads, [a]);
    assert.equal(await awakened.read(c), image);
    storage.local.values[b] = storage.local.values[a];
    assert.equal(await awakened.read(b), null);
    storage.local.values[a].ciphertext = 'damaged';
    assert.equal(await awakened.read(a), null);
});

test('references are scoped, evicted records are removed and unknown session ciphertext is purged', async () => {
    const storage = { local: area(), session: area() };
    const store = new TabSwitcherPreviewStore({ storage });
    storage.local.values.userPreference = true;
    const kept = await store.put(image, true);
    const staleDisk = await store.put(image, true);
    const staleMemory = await store.put(image, false);
    assert.deepEqual(await store.reconcile([kept]), new Set([kept]));
    assert.equal(await store.read(staleDisk), null);
    assert.equal(await store.read(staleMemory), null);
    await store.delete(['userPreference', 'tabSwitcherThumbnailKey', '']);
    assert.equal(await store.read('userPreference'), null);
    assert.equal(await store.read(kept), image);
    const other = await store.put(image, true);
    await store.delete([other]);
    assert.equal(await store.read(other), null);

    const nextSession = new TabSwitcherPreviewStore({ storage: { ...storage, session: area() } });
    delete storage.local.getKeys; // Chrome 116–129.
    assert.deepEqual(await nextSession.reconcile([kept]), new Set());
    assert.deepEqual(storage.local.values, { userPreference: true });
    const fresh = await nextSession.put(image, true);
    assert.equal(await nextSession.read(fresh), image);
    assert.equal(await store.read(fresh), null);
});

test('the thumbnail store rejects oversized images before writing anything', async () => {
    const storage = { local: area(), session: area() };
    const store = new TabSwitcherPreviewStore({ storage });
    await assert.rejects(store.put('data:image/png;base64,Zm9v', true));
    await assert.rejects(store.put('data:image/jpeg;base64,' + btoa('x'.repeat(40 * 1024 + 1)), true));
    assert.deepEqual(storage.local.values, {});
    assert.deepEqual(storage.session.values, {});
});
