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

export function registerInlineSwitcher(chromeApi, permissionChanged) {
    let work = Promise.resolve();
    async function configure(rearm) {
        const tabs = () => chromeApi.tabs.query({}).then(tabs => tabs.filter(tab => !tab.incognito && inlinePage(tab.url)));
        if (rearm) {
            await Promise.allSettled((await tabs()).map(tab =>
                chromeApi.tabs.sendMessage(tab.id, { type: INLINE_MESSAGE, action: 'off' })));
        }
        if (!chromeApi.scripting || (await chromeApi.runtime.getPlatformInfo()).os !== 'mac') return;
        const [settings, available] = await Promise.all([
            chromeApi.storage.local.get(INLINE_SWITCHER),
            chromeApi.permissions.contains({ permissions: ['scripting'] }),
        ]);
        if (!available) return;
        const registrations = await chromeApi.scripting.getRegisteredContentScripts({ ids: [INLINE_SCRIPT] });
        if (settings[INLINE_SWITCHER] !== true) {
            if (registrations.length) await chromeApi.scripting.unregisterContentScripts({ ids: [INLINE_SCRIPT] });
            return;
        }
        if (!registrations.length) {
            await chromeApi.scripting.registerContentScripts([{
                id: INLINE_SCRIPT, js: [INLINE_SCRIPT_FILE], matches: WEB_MATCHES, allFrames: true,
                excludeMatches: ['https://chrome.google.com/*', 'https://chromewebstore.google.com/*'],
                runAt: 'document_start', persistAcrossSessions: false,
            }]);
        }
        if (!registrations.length || rearm) {
            await Promise.allSettled((await tabs()).map(async tab => {
                const target = { tabId: tab.id };
                const inject = fields => chromeApi.scripting.executeScript({
                    target: { ...target, ...fields }, files: [INLINE_SCRIPT_FILE], injectImmediately: true,
                });
                try { await inject({ allFrames: true }); } catch { await inject({}); }
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
