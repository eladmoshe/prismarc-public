import { LocalStorage } from './localstorage.js';

// Read only: setup should describe the actual bookmark tree without creating spaces.
export async function readBookmarkSpaces() {
    const root = await LocalStorage.getArcifyFolder();
    if (!root) return { folderId: null, names: [] };
    const children = await chrome.bookmarks.getChildren(root.id);
    return { folderId: root.id, names: children.filter(node => !node.url).map(node => node.title) };
}
