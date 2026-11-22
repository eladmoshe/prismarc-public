/**
 * ChromeHelper - Chrome API wrapper and utility functions
 * 
 * Purpose: Provides simplified, promise-based wrappers around Chrome extension APIs
 * Key Functions: Tab creation and opening Chrome's keyboard shortcut settings
 * Architecture: Static utility object with async methods for Chrome API operations
 * 
 * Critical Notes:
 * - Wraps callback-based Chrome APIs in promises for easier async/await usage
 * - Handles Chrome API error checking and reporting
 * - Used primarily by sidebar.js for tab creation
 * - Abstracts complex Chrome API interactions into simple method calls
 */

const KEYBOARD_SHORTCUTS_URL = 'chrome://extensions/shortcuts';
const KEYBOARD_SHORTCUTS_ERROR = 'Could not open keyboard shortcut settings. Enter chrome://extensions/shortcuts in the address bar.';
const openingKeyboardShortcuts = new Map();

async function openKeyboardShortcuts(windowId) {
    const targetWindowId = windowId ?? (await chrome.windows.getCurrent()).id;
    const pending = openingKeyboardShortcuts.get(targetWindowId);
    if (pending) return pending;
    const request = (async () => {
        const tabs = await chrome.tabs.query({ windowId: targetWindowId });
        const existing = tabs.find(tab => (tab.pendingUrl || tab.url) === KEYBOARD_SHORTCUTS_URL);
        if (existing) return chrome.tabs.update(existing.id, { active: true });
        return chrome.tabs.create({ windowId: targetWindowId, url: KEYBOARD_SHORTCUTS_URL, active: true });
    })().finally(() => { openingKeyboardShortcuts.delete(targetWindowId); });
    openingKeyboardShortcuts.set(targetWindowId, request);
    return request;
}

const ChromeHelper = {
    createNewTab: async function () {
        const newTab = await new Promise((resolve, reject) => {
            chrome.tabs.create({ active: true }, (tab) => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                } else {
                    resolve(tab);
                }
            });
        });
        return newTab;
    },
}

export { ChromeHelper, KEYBOARD_SHORTCUTS_ERROR, openKeyboardShortcuts };
