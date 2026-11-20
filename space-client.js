import { APPEARANCE_THEME_KEY, isAppearanceTheme } from './space-colors.js';

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

async function requestAppearance(action, payload) {
    const response = await chrome.runtime.sendMessage({ type: 'appearanceTheme', action, ...payload });
    if (!response?.success || !isAppearanceTheme(response.theme)) {
        throw new Error(response?.error || 'Appearance settings are unavailable.');
    }
    return response.theme;
}

export async function getAppearanceTheme(windowId, tabId) {
    const stored = await chrome.storage.local.get(APPEARANCE_THEME_KEY);
    if (isAppearanceTheme(stored[APPEARANCE_THEME_KEY])) return stored[APPEARANCE_THEME_KEY];
    return requestAppearance('get', { windowId, tabId });
}

export function setAppearanceTheme(theme) {
    return requestAppearance('set', { theme });
}

export async function watchAppearance(windowId, tabId) {
    const root = document.documentElement;
    let receivedChange = false;
    chrome.storage.onChanged.addListener((changes, area) => {
        const theme = changes[APPEARANCE_THEME_KEY]?.newValue;
        if (area !== 'local' || !isAppearanceTheme(theme)) return;
        receivedChange = true;
        root.dataset.appearance = theme;
    });
    try {
        const theme = await getAppearanceTheme(windowId, tabId);
        if (!receivedChange) root.dataset.appearance = theme;
    } catch { /* The popup may close before storage responds. CSS defaults to dark. */ }
}
