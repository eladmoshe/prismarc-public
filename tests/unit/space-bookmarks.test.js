import test from 'node:test';
import assert from 'node:assert/strict';
import { editSpacePin, forgetRemovedSpacePinNames, getSpaceBookmarkById, getSpaceBookmarkFolder, getSpaceBookmarkTree,
    removeSpacePin, restoreSpacePin } from '../../space-bookmarks.js';
import { BookmarkUtils } from '../../bookmark-utils.js';
function mock() {
    const removed = [];
    const tree = { root: [{ id: 'space', parentId: 'root', title: 'Renamed' }, { id: 'other', parentId: 'root', title: 'Old name' }], space: [{ id: 'folder', parentId: 'space', title: 'Nested' }], folder: [
        { id: 'first', title: 'Twin', url: 'https://saved.test/' }, { id: 'bound', title: 'Saved', url: 'https://saved.test/' }
    ] };
    const pins = { 1: { bookmarkId: 'bound', pinnedUrl: 'https://saved.test/' } };
    const local = { arcifyBookmarkRootId: 'root', pinnedTabStatesById: pins };
    globalThis.chrome = {
        storage: { local: { async get() { return structuredClone(local); }, async set(items) { Object.assign(local, items); } } },
        runtime: { async sendMessage() { return { success: true, spaces: [{ id: 's', spaceBookmarks: [1], temporaryTabs: [2] }] }; } },
        tabs: { async query() { return [{ id: 1, url: 'https://navigated.test/' }, { id: 2, url: 'https://saved.test/' }]; } },
        bookmarks: { async get(id) {
            return id === 'root' ? [{ id, title: 'PrismArc' }] : Object.values(tree).flat().filter(node => node.id === id);
        }, async getChildren(id) { return tree[id] || []; }, async remove(id) { removed.push(id); } } };
    return { removed, tree, local };
}
test('unpin removes the bound nested bookmark after navigation, preserving URL twins', async () => {
    const { removed } = mock();
    const space = { bookmarkFolderId: 'space', name: 'Old name' };
    assert.equal((await getSpaceBookmarkFolder(space)).id, 'space');
    await removeSpacePin(space, { id: 1, url: 'https://navigated.test/' });
    assert.deepEqual(removed, ['bound']);
});
test('startup bookmark binding preserves navigated pins and does not steal their URL twin', async () => {
    mock();
    const bindings = [];
    const ids = await BookmarkUtils.matchTabsWithBookmarks({ id: 'space' }, 's', null,
        async (id, binding) => bindings.push([id, binding]), null, url => url);
    assert.deepEqual(ids, [1]);
    assert.equal(bindings.find(([id]) => id === 1)[1].bookmarkId, 'bound');
});

test('a stale binding never deletes the first URL twin', async () => {
    const { removed } = mock();
    await removeSpacePin({ bookmarkFolderId: 'space' }, { bookmarkId: 'missing', url: 'https://saved.test/' });
    assert.deepEqual(removed, []);
});

test('an unbound temporary tab cannot delete a same-URL favorite', async () => {
    const { removed } = mock();
    await assert.rejects(removeSpacePin({ bookmarkFolderId: 'space' }, { id: 2, url: 'https://saved.test/' }), /identity/);
    assert.deepEqual(removed, []);
});

test('closed favorites delete their exact node and preserve a duplicate sibling', async () => {
    const { removed } = mock();
    await removeSpacePin({ bookmarkFolderId: 'space' }, { bookmarkId: 'bound' });
    assert.deepEqual(removed, ['bound']);
});

test('missing folder identity never falls back to a same-named folder', async () => {
    mock();
    await assert.rejects(getSpaceBookmarkFolder({ name: 'Old name', bookmarkFolderId: 'missing' }), /unavailable/);
    await assert.rejects(getSpaceBookmarkFolder({ name: 'Old name' }), /association/);
});

test('bookmark identity is accepted only inside the associated space subtree', async () => {
    mock();
    assert.equal((await getSpaceBookmarkById({ bookmarkFolderId: 'space' }, 'bound')).id, 'bound');
    assert.equal(await getSpaceBookmarkById({ bookmarkFolderId: 'space' }, 'url-twin'), null);
});

test('bookmark tree loading is all-or-nothing and performs no recovery writes', async () => {
    const { tree } = mock();
    const writes = [];
    globalThis.chrome.bookmarks.create = async (...args) => writes.push(['create', ...args]);
    globalThis.chrome.bookmarks.update = async (...args) => writes.push(['update', ...args]);
    globalThis.chrome.bookmarks.move = async (...args) => writes.push(['move', ...args]);
    const loaded = await getSpaceBookmarkTree({ bookmarkFolderId: 'space' });
    assert.equal(loaded.id, 'space');
    assert.equal(loaded.children[0].id, 'folder');
    assert.deepEqual(loaded.children[0].children.map(node => node.id), ['first', 'bound']);
    assert.deepEqual(writes, []);

    const original = globalThis.chrome.bookmarks.getChildren;
    globalThis.chrome.bookmarks.getChildren = async id => {
        if (id === 'folder') throw new Error('injected read failure');
        return original(id);
    };
    await assert.rejects(getSpaceBookmarkTree({ bookmarkFolderId: 'space' }), /injected read failure/);
    assert.deepEqual(writes, []);
    assert.equal(tree.folder.length, 2);
});

test('removing a favorite returns the snapshot needed to undo it', async () => {
    const { removed, tree } = mock();
    tree.folder[1] = { ...tree.folder[1], parentId: 'folder', index: 1 };
    const snapshot = await removeSpacePin({ bookmarkFolderId: 'space' }, { bookmarkId: 'bound' });
    assert.deepEqual(removed, ['bound']);
    assert.deepEqual(snapshot, { parentId: 'folder', index: 1, title: 'Saved', url: 'https://saved.test/' });
    assert.equal(await removeSpacePin({ bookmarkFolderId: 'space' }, { bookmarkId: 'missing' }), null);
});

test('an explicitly confirmed bookmark name retains its original title for rename and Undo', async () => {
    const { local, tree } = mock();
    const space = { bookmarkFolderId: 'space' };
    globalThis.chrome.bookmarks.update = async (id, changes) => {
        const node = tree.folder.find(node => node.id === id);
        Object.assign(node, changes);
        return node;
    };
    const confirmed = await editSpacePin(space, 'bound', bookmark => ({
        changes: { title: bookmark.title }, nameDefault: bookmark.title,
    }));
    assert.equal(confirmed, 'Saved');
    assert.deepEqual(local.spacePinNameDefaults, { bound: 'Saved' });
    const renamed = await editSpacePin(space, 'bound', () => ({ changes: { title: 'Chosen name' } }));
    assert.equal(renamed, 'Chosen name');
    Object.assign(tree.folder.find(node => node.id === 'bound'), { parentId: 'folder', index: 1 });
    const removed = await removeSpacePin(space, { bookmarkId: 'bound' });
    assert.equal(removed.title, 'Chosen name');
    assert.equal(removed.nameDefault, 'Saved');
    await forgetRemovedSpacePinNames('bound');
    globalThis.chrome.bookmarks.create = async details => ({ ...details, id: 'restored' });
    const restored = await restoreSpacePin(removed);
    assert.deepEqual(restored, { id: 'restored', parentId: 'folder', title: 'Chosen name', index: 1, url: 'https://saved.test/' });
    assert.deepEqual(local.spacePinNameDefaults, { restored: 'Saved' });
});

test('a rejected native bookmark rename leaves the existing alias metadata intact', async () => {
    const { local } = mock();
    local.spacePinNameDefaults = { first: 'Another prior title' };
    globalThis.chrome.bookmarks.update = async () => { throw new Error('Write rejected'); };
    await assert.rejects(editSpacePin({ bookmarkFolderId: 'space' }, 'bound', bookmark => ({
        changes: { title: 'New name' }, nameDefault: bookmark.title,
    })), /Write rejected/);
    assert.deepEqual(local.spacePinNameDefaults, { first: 'Another prior title' });
});

test('removing a bookmark folder prunes only the aliases in its removed tree', async () => {
    const { local } = mock();
    local.spacePinNameDefaults = { first: 'Retained name', bound: 'Removed name' };
    await forgetRemovedSpacePinNames('folder', { children: [{ id: 'nested', children: [{ id: 'bound' }] }] });
    assert.deepEqual(local.spacePinNameDefaults, { first: 'Retained name' });
});

test('unpin leaves a bookmark alone if it moves while reading name metadata', async () => {
    const { removed, tree } = mock();
    const storage = globalThis.chrome.storage.local;
    const get = storage.get;
    storage.get = async key => {
        if (key === 'spacePinNameDefaults') tree.other = [tree.folder.pop()];
        return get(key);
    };
    assert.equal(await removeSpacePin({ bookmarkFolderId: 'space' }, { bookmarkId: 'bound' }), null);
    assert.equal(tree.other[0].id, 'bound');
    assert.deepEqual(removed, []);
});

test('rename checks bookmark ownership again after persisting new name provenance', async () => {
    const { tree, local } = mock();
    const storage = globalThis.chrome.storage.local;
    const set = storage.set;
    storage.set = async items => {
        await set(items);
        if (Object.hasOwn(items.spacePinNameDefaults, 'bound')) tree.other = [tree.folder.pop()];
    };
    globalThis.chrome.bookmarks.update = async () => assert.fail('must not update the moved bookmark');
    await assert.rejects(editSpacePin({ bookmarkFolderId: 'space' }, 'bound', bookmark => ({
        changes: { title: 'New name' }, nameDefault: bookmark.title,
    })), /no longer valid/);
    assert.equal(tree.other[0].title, 'Saved');
    assert.deepEqual(local.spacePinNameDefaults, {});
});

test('Undo returns the restored native bookmark if restoring its alias metadata fails', async () => {
    mock();
    globalThis.chrome.bookmarks.create = async details => ({ ...details, id: 'restored' });
    globalThis.chrome.storage.local.set = async () => { throw new Error('Storage unavailable'); };
    const restored = await restoreSpacePin({ parentId: 'folder', index: 1, title: 'Alias', url: 'https://saved.test/', nameDefault: 'Home' });
    assert.equal(restored.id, 'restored');
    assert.equal(restored.title, 'Alias');
});
