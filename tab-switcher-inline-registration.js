import { INLINE_SWITCHER } from './tab-switcher-inline-settings.js';

export const INLINE_SCRIPT = 'tab-switcher-inline';
export const INLINE_SCRIPT_FILE = 'tab-switcher-inline.js';
export const INLINE_MESSAGE = 'recent-tabs-inline';
const WEB_MATCHES = ['http://*/*', 'https://*/*'];
const STORE_ORIGINS = new Set(['https://chrome.google.com', 'https://chromewebstore.google.com']);

export function inlinePage(url) {
    if (!/^https?:\/\//i.test(url)) return false;
    try { return !STORE_ORIGINS.has(new URL(url).origin); } catch { return false; }
}

export function attachInlineListener(chromeApi, tabId, allFrames = false) {
    return chromeApi.scripting.executeScript({ target: allFrames ? { tabId, allFrames: true } : { tabId, frameIds: [0] },
        files: [INLINE_SCRIPT_FILE], injectImmediately: true });
}

export function registerInlineSwitcher(chromeApi, permissionChanged) {
    let work = Promise.resolve();
    async function configure(rearm) {
        const tabs = () => chromeApi.tabs.query({}).then(tabs => tabs.filter(tab => !tab.incognito && inlinePage(tab.url)));
        if (rearm) {
            await Promise.allSettled((await tabs()).map(tab =>
                chromeApi.tabs.sendMessage(tab.id, { type: INLINE_MESSAGE, action: 'off' })));
        }
        if (!chromeApi.scripting) return;
        const [settings, available, platform] = await Promise.all([
            chromeApi.storage.local.get(INLINE_SWITCHER),
            chromeApi.permissions.contains({ permissions: ['scripting'] }),
            chromeApi.runtime.getPlatformInfo(),
        ]);
        if (!available) return;
        const registrations = await chromeApi.scripting.getRegisteredContentScripts({ ids: [INLINE_SCRIPT] });
        if (settings[INLINE_SWITCHER] !== true) {
            if (registrations.length) await chromeApi.scripting.unregisterContentScripts({ ids: [INLINE_SCRIPT] });
            return;
        }
        if (!registrations.length) {
            await chromeApi.scripting.registerContentScripts([{
                id: INLINE_SCRIPT, js: [INLINE_SCRIPT_FILE], matches: WEB_MATCHES, allFrames: platform.os === 'mac',
                excludeMatches: ['https://chrome.google.com/*', 'https://chromewebstore.google.com/*'],
                runAt: 'document_start', persistAcrossSessions: false,
            }]);
        }
        if (!registrations.length || rearm) {
            await Promise.allSettled((await tabs()).map(async tab => {
                if (platform.os !== 'mac') return attachInlineListener(chromeApi, tab.id);
                try { await attachInlineListener(chromeApi, tab.id, true); } catch { await attachInlineListener(chromeApi, tab.id); }
            }));
        }
    }
    function schedule(changed = false, rearm = changed) {
        if (changed) permissionChanged();
        work = work.then(() => configure(rearm)).catch(() => {});
    }
    chromeApi.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[INLINE_SWITCHER]) schedule(true);
    });
    chromeApi.permissions.onAdded.addListener(({ permissions, origins }) => {
        if (permissions?.includes('scripting') || origins?.length) schedule(false, true);
    });
    chromeApi.permissions.onRemoved.addListener(({ permissions, origins }) => {
        if (permissions?.includes('scripting') || origins?.length) schedule(true);
    });
    schedule();
}
