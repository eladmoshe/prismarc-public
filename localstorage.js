/**
 * LocalStorage - Bookmark-based persistence and Chrome storage utilities
 * 
 * Purpose: Manages space bookmarks and provides legacy storage compatibility
 * Key Functions: Arcify bookmark folder management, space bookmark operations, storage synchronization
 * Architecture: Static utility object for bookmark-based data persistence
 * 
 * Critical Notes:
 * - Tracks PrismArc’s bookmark root by Chrome bookmark ID
 * - Provides bookmark-based storage as alternative to chrome.storage
 * - Used for space bookmark functionality (separate from main space data in chrome.storage)
 * - Handles bookmark folder creation and organization automatically
 */

export const BOOKMARK_ROOT_KEY = 'arcifyBookmarkRootId';
let rootWork;

async function bookmarkRootStorage(operation) {
    try {
        return await operation();
    } catch (error) {
        throw Object.assign(new Error('Could not read or save the PrismArc bookmark folder ID.', { cause: error }),
            { code: 'space_storage_unavailable' });
    }
}

async function readBookmarkRoot() {
    const { [BOOKMARK_ROOT_KEY]: savedId } = await bookmarkRootStorage(() => chrome.storage.local.get(BOOKMARK_ROOT_KEY));
    return { savedId, folder: await discoverBookmarkRoot(savedId) };
}

async function discoverBookmarkRoot(savedId) {
    if (typeof savedId === 'string') {
        const node = await chrome.bookmarks.get(savedId).then(([folder]) => folder, () => null);
        if (node && !node.url) return node;
    }

    // The previous installation stored the IDs of its space folders, but not
    // their root. Match the parent using durable IDs, independent of its title.
    const { spaces = [], spaceRegistry = {} } = await bookmarkRootStorage(() => chrome.storage.local.get(['spaces', 'spaceRegistry']));
    const knownIds = new Set([...Object.keys(spaceRegistry),
        ...spaces.flatMap(space => space.bookmarkFolderId ? [String(space.bookmarkFolderId)] : [])]);
    const legacyNames = new Set(spaces.map(space => space.name));
    if (!savedId && !knownIds.size && !legacyNames.size) return null;

    const roots = await chrome.bookmarks.getTree();
    const candidates = new Set();
    const legacyCandidates = new Set();
    const folders = [...roots];
    for (const folder of folders) {
        if (folder.id === savedId && !folder.url) return folder;
        const children = folder.children || [];
        const childFolders = children.filter(child => !child.url);
        if (folder.parentId && folder.parentId !== '0' && !folder.folderType && childFolders.some(child => knownIds.has(child.id))) {
            candidates.add(folder);
        }
        // Legacy, pre-registry models stored names only. The old create call
        // used Other Bookmarks as parent. Require corroborating space names.
        if (!savedId && !knownIds.size && (folder.folderType === 'other' || folder.id === '2')) {
            for (const child of childFolders) {
                if (child.title === 'Arcify' && child.children?.some(node => !node.url && legacyNames.has(node.title))) {
                    legacyCandidates.add(child);
                }
            }
        }
        folders.push(...childFolders);
    }
    if (candidates.size === 1) return [...candidates][0];
    return candidates.size === 0 && legacyCandidates.size === 1 ? [...legacyCandidates][0] : null;
}

const LocalStorage = {
    // Durable space IDs anchored to bookmark folders. SpaceStore owns live membership;
    // this registry keeps the folder association stable through migration and restart.
    _registryChain: Promise.resolve(),
    _serializeRegistryOp: function (op) {
        const run = this._registryChain.then(op, op);
        this._registryChain = run.then(() => { }, () => { });
        return run;
    },
    getSpaceRegistry: async function () {
        const result = await chrome.storage.local.get('spaceRegistry');
        return result.spaceRegistry || {};
    },
    saveSpaceRegistry: async function (registry) {
        await chrome.storage.local.set({ spaceRegistry: registry || {} });
    },
    // Get the durable entry for a space's bookmark folder, creating it (with a fresh
    // spaceUuid) on first sight. On creation the passed name/color seed the entry.
    getOrCreateSpaceRegistryEntry: async function (bookmarkFolderId, attrs = {}) {
        if (!bookmarkFolderId) return null;
        return this._serializeRegistryOp(async () => {
            const registry = await this.getSpaceRegistry();
            let entry = registry[bookmarkFolderId];
            if (!entry) {
                const spaceUuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `space-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                entry = {
                    spaceUuid,
                    bookmarkFolderId,
                    name: attrs.name ?? null,
                    color: attrs.color ?? null,
                    order: attrs.order ?? 0,
                };
                registry[bookmarkFolderId] = entry;
                await this.saveSpaceRegistry(registry);
            }
            return entry;
        });
    },
    removeSpaceRegistryEntry: async function (bookmarkFolderId) {
        if (!bookmarkFolderId) return;
        return this._serializeRegistryOp(async () => {
            const registry = await this.getSpaceRegistry();
            if (registry[bookmarkFolderId]) {
                delete registry[bookmarkFolderId];
                await this.saveSpaceRegistry(registry);
            }
        });
    },
    // Update a registry entry's mutable attributes (name/color/order) so the durable record
    // tracks the user's renames/recolors. No-op if the entry doesn't exist yet.
    updateSpaceRegistryEntry: async function (bookmarkFolderId, attrs = {}) {
        if (!bookmarkFolderId) return;
        return this._serializeRegistryOp(async () => {
            const registry = await this.getSpaceRegistry();
            const entry = registry[bookmarkFolderId];
            if (!entry) return;
            if (attrs.name !== undefined) entry.name = attrs.name;
            if (attrs.color !== undefined) entry.color = attrs.color;
            if (attrs.order !== undefined) entry.order = attrs.order;
            await this.saveSpaceRegistry(registry);
        });
    },

    // The saved space model is authoritative. Repair backups from older
    // versions that only persisted recoloring in that model.
    syncSpaceRegistryColors: async function (spaces) {
        await this._serializeRegistryOp(async () => {
            const registry = await this.getSpaceRegistry();
            let changed = false;
            for (const { id, bookmarkFolderId, color } of spaces) {
                const entry = registry[bookmarkFolderId];
                if (!entry || entry.spaceUuid !== id || !color || entry.color === color) continue;
                entry.color = color;
                changed = true;
            }
            if (changed) await this.saveSpaceRegistry(registry);
        });
    },

    getArcifyFolder: async function () {
        return (await readBookmarkRoot()).folder;
    },

    getOrCreateArcifyFolder: function () {
        if (rootWork) return rootWork;
        const ensureRoot = async () => {
            const { savedId, folder } = await readBookmarkRoot();
            const root = folder || await chrome.bookmarks.create({ title: 'PrismArc' });
            if (root.id !== savedId) {
                try {
                    await bookmarkRootStorage(() => chrome.storage.local.set({ [BOOKMARK_ROOT_KEY]: root.id }));
                } catch (error) {
                    if (!folder) await chrome.bookmarks.remove(root.id).catch(() => {});
                    throw error;
                }
            }
            return root;
        };
        const locks = globalThis.navigator?.locks;
        const work = locks ? locks.request('prismarc-bookmark-root', ensureRoot) : ensureRoot();
        rootWork = work.catch(error => {
            if (error.code === 'space_storage_unavailable') throw error;
            throw Object.assign(new Error('Could not access the PrismArc bookmark folder.', { cause: error }),
                { code: 'bookmark_folder_unavailable' });
        }).finally(() => { rootWork = undefined; });
        return rootWork;
    },
    getOrCreateSpaceFolder: async function (spaceName) {
        const arcifyFolder = await this.getOrCreateArcifyFolder();
        const children = await chrome.bookmarks.getChildren(arcifyFolder.id);
        let spaceFolder = children.find((f) => !f.url && f.title === spaceName);

        if (!spaceFolder) {
            spaceFolder = await chrome.bookmarks.create({
                parentId: arcifyFolder.id,
                title: spaceName
            });
        }
        return spaceFolder;
    },

    async getSpaceNames() {
        const root = await this.getOrCreateArcifyFolder();
        const children = await chrome.bookmarks.getChildren(root.id);
        return [...new Set(children.filter(node => !node.url).map(node => node.title))].sort();
    }
};

export { LocalStorage };
