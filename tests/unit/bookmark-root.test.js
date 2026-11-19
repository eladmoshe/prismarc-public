import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStorage, BOOKMARK_ROOT_KEY } from '../../localstorage.js';

function fixture(data, roots) {
    const created = [];
    const removed = [];
    const nodes = [...roots];
    for (const node of nodes) nodes.push(...(node.children || []));
    globalThis.chrome = {
        storage: { local: {
            get: async keys => Object.fromEntries([keys].flat().filter(key => key in data).map(key => [key, data[key]])),
            set: async update => { Object.assign(data, update); }
        } },
        bookmarks: {
            get: async id => nodes.filter(node => node.id === id),
            getTree: async () => roots,
            create: async ({ title }) => {
                const folder = { id: `new-${created.length}`, title };
                created.push(folder);
                nodes.push(folder);
                return folder;
            },
            remove: async id => removed.push(id)
        }
    };
    return { created, removed };
}

const browserTree = children => [{
    id: '0', children: [{ id: '2', parentId: '0', title: 'Other Bookmarks', children }]
}];

test('migrates the root containing saved space folders and follows later title changes', async () => {
    const root = { id: 'ours', parentId: '2', title: 'My renamed root', children: [{ id: 'space', title: 'Work' }] };
    const other = { id: 'unrelated', parentId: '2', title: 'Arcify', children: [{ id: 'other-space', title: 'Work' }] };
    const data = { spaceRegistry: { space: { spaceUuid: 'uuid' } } };
    const { created } = fixture(data, browserTree([other, root]));
    assert.equal((await LocalStorage.getOrCreateArcifyFolder()).id, root.id);
    assert.equal(data[BOOKMARK_ROOT_KEY], root.id);
    root.title = 'Another new title';
    chrome.bookmarks.getTree = () => assert.fail('Known root must be read by ID');
    assert.equal((await LocalStorage.getArcifyFolder()).title, 'Another new title');
    assert.deepEqual(created, []);
});

test('legacy names can identify the old default-location root with no durable space IDs', async () => {
    const data = { spaces: [{ name: 'Work' }] };
    const arcify = { id: 'legacy', parentId: '2', title: 'Arcify', children: [{ id: 'work', title: 'Work' }] };
    fixture(data, browserTree([arcify]));
    assert.equal((await LocalStorage.getOrCreateArcifyFolder()).id, arcify.id);
});

test('creates one PrismArc root instead of attaching to a title-only duplicate', async () => {
    const data = {};
    const { created } = fixture(data, browserTree([{ id: 'other', title: 'Arcify', parentId: '2' }]));
    const roots = await Promise.all([LocalStorage.getOrCreateArcifyFolder(), LocalStorage.getOrCreateArcifyFolder()]);
    assert.deepEqual(created.map(node => node.title), ['PrismArc']);
    assert.deepEqual(roots.map(root => root.id), ['new-0', 'new-0']);
    assert.equal(data[BOOKMARK_ROOT_KEY], 'new-0');
});

test('root creation rolls back and reports a storage failure if saving its ID exceeds quota', async () => {
    const { removed } = fixture({}, browserTree([]));
    chrome.storage.local.set = async () => { throw new Error('QUOTA_BYTES'); };
    await assert.rejects(LocalStorage.getOrCreateArcifyFolder(), { code: 'space_storage_unavailable' });
    assert.deepEqual(removed, ['new-0']);
});

test('bookmark permission failures have a separate error code', async () => {
    fixture({}, browserTree([]));
    chrome.bookmarks.create = async () => { throw new Error('Bookmarks unavailable'); };
    await assert.rejects(LocalStorage.getOrCreateArcifyFolder(), { code: 'bookmark_folder_unavailable' });
});
