import { Utils } from './utils.js';
import { LocalStorage } from './localstorage.js';
import { Logger } from './logger.js';

export const SPACE_PIN_NAME_DEFAULTS = 'spacePinNameDefaults';

export async function getSpacePinNameDefaults() {
    const { [SPACE_PIN_NAME_DEFAULTS]: defaults = {} } = await chrome.storage.local.get(SPACE_PIN_NAME_DEFAULTS);
    return defaults;
}

function withPinNames(operation) {
    const locks = globalThis.navigator?.locks;
    return locks ? locks.request(SPACE_PIN_NAME_DEFAULTS, operation) : operation();
}

async function saveNameDefault(defaults, id, title) {
    const next = { ...defaults };
    if (title === null) delete next[id];
    else next[id] = title;
    await chrome.storage.local.set({ [SPACE_PIN_NAME_DEFAULTS]: next });
}

// The bookmark holds the visible name. The original title proves a user edit
// and supplies the automatic title when an alias is cleared while away.
export function editSpacePin(space, bookmarkId, update) {
    return withPinNames(async () => {
        const defaults = await getSpacePinNameDefaults();
        const bookmark = await getSpaceBookmarkById(space, bookmarkId);
        if (!bookmark) throw new Error('The favorite binding is no longer valid for this space.');
        const original = typeof defaults[bookmark.id] === 'string' ? defaults[bookmark.id] : null;
        const { changes, nameDefault = original } = update(bookmark, original);
        if (nameDefault !== original) await saveNameDefault(defaults, bookmark.id, nameDefault);
        try {
            if (nameDefault !== original && !await getSpaceBookmarkById(space, bookmarkId)) {
                throw new Error('The favorite binding is no longer valid for this space.');
            }
            const updated = await chrome.bookmarks.update(bookmark.id, changes);
            return nameDefault === null ? '' : updated.title;
        } catch (error) {
            if (nameDefault !== original) await chrome.storage.local.set({ [SPACE_PIN_NAME_DEFAULTS]: defaults });
            throw error;
        }
    });
}

export async function restoreSpacePin({ parentId, index, title, url, nameDefault }) {
    const siblings = await chrome.bookmarks.getChildren(parentId);
    const bookmark = await chrome.bookmarks.create({ parentId, title, url, index: Math.min(index, siblings.length) });
    if (typeof nameDefault === 'string') {
        await withPinNames(async () => saveNameDefault(await getSpacePinNameDefaults(), bookmark.id, nameDefault))
            .catch(error => Logger.warn('The bookmark was restored, but its automatic title could not be saved.', error));
    }
    return bookmark;
}

export function forgetRemovedSpacePinNames(id, node) {
    const removedIds = [id];
    const descendants = [...(node?.children || [])];
    while (descendants.length) {
        const child = descendants.pop();
        removedIds.push(child.id);
        if (child.children) descendants.push(...child.children);
    }
    return withPinNames(async () => {
        const defaults = await getSpacePinNameDefaults();
        const removed = removedIds.filter(id => Object.hasOwn(defaults, id));
        if (!removed.length) return;
        for (const id of removed) delete defaults[id];
        await chrome.storage.local.set({ [SPACE_PIN_NAME_DEFAULTS]: defaults });
    });
}

export async function getSpaceBookmarkFolder(space) {
    if (!space?.bookmarkFolderId) throw new Error('This space has no bookmark folder association.');
    const [folder] = await chrome.bookmarks.get(space.bookmarkFolderId);
    if (!folder || folder.url) throw new Error('The bookmark folder for this space is unavailable.');
    const root = await LocalStorage.getArcifyFolder();
    if (!root || String(folder.parentId) !== String(root.id)) {
        throw new Error('The bookmark folder is no longer inside the PrismArc bookmark folder.');
    }
    return folder;
}

export async function isFolderInBookmarkRoot(folderId, rootId) {
    while (folderId && folderId !== rootId) {
        const [folder] = await chrome.bookmarks.get(folderId);
        if (!folder || folder.url) return false;
        folderId = folder.parentId;
    }
    return Boolean(rootId) && folderId === rootId;
}

export async function getSpaceBookmarkTree(space) {
    const folder = await getSpaceBookmarkFolder(space);
    const read = async node => ({
        ...node,
        children: await Promise.all((await chrome.bookmarks.getChildren(node.id)).map(child =>
            child.url ? Promise.resolve({ ...child }) : read(child)))
    });
    return read(folder);
}

export async function getSpaceBookmarkById(space, bookmarkId) {
    if (!bookmarkId) return null;
    const folder = await getSpaceBookmarkFolder(space);
    async function find(parentId) {
        for (const node of await chrome.bookmarks.getChildren(parentId)) {
            if (String(node.id) === String(bookmarkId)) return node.url ? node : null;
            if (!node.url) {
                const match = await find(node.id);
                if (match) return match;
            }
        }
        return null;
    }
    return find(folder.id);
}

export function removeSpacePin(space, tab) {
    return withPinNames(async () => {
        const binding = tab.id ? await Utils.getPinnedTabState(tab.id) : null;
        const bookmarkId = tab.bookmarkId || binding?.bookmarkId;
        if (!bookmarkId) throw new Error('Cannot remove a favorite without its bookmark identity.');
        const nameDefault = (await getSpacePinNameDefaults())[bookmarkId];
        const bookmark = await getSpaceBookmarkById(space, bookmarkId);
        if (!bookmark) return null;
        const { parentId, index, title, url } = bookmark;
        await chrome.bookmarks.remove(bookmark.id);
        // Keep the bookmark details because Chrome cannot recover them after deletion.
        return { parentId, index, title, url, ...(typeof nameDefault === 'string' && { nameDefault }) };
    });
}
