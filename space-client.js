import { LIGHT_SPACE_COLOR } from './space-colors.js';

export async function spaceRequest(action, payload = {}) {
    let response;
    try {
        response = await chrome.runtime.sendMessage({ type: 'spaceStore', action, ...payload });
    } catch (error) {
        throw Object.assign(new Error('Space storage is unavailable.', { cause: error }), { code: 'space_storage_unavailable' });
    }
    if (!response?.success) {
        throw Object.assign(new Error(response?.error || 'Space storage is unavailable.'),
            { code: response?.code || 'space_storage_unavailable' });
    }
    return response.spaces;
}

export async function getSpaceTabs(spaceId) {
    const spaces = await spaceRequest('get', { discoverBookmarks: false });
    const space = spaces.find(s => s.id === spaceId);
    const tabs = new Map((await chrome.tabs.query({})).map(t => [t.id, t]));
    return [...(space?.spaceBookmarks || []), ...(space?.temporaryTabs || [])].map(id => tabs.get(id)).filter(Boolean);
}

// Theme resolution is independent of drawing results and handling keys. A
// worker restart or unavailable space data leaves the normal dark palette.
export async function applyPopupSpaceTheme(windowId, tabId) {
    try {
        const response = await chrome.runtime.sendMessage({ type: 'popupSpaceTheme', windowId, tabId });
        if (response?.success && response.light) document.documentElement.dataset.spaceColor = LIGHT_SPACE_COLOR;
    } catch { /* The popup can be dismissed before the response arrives. */ }
}
