import { releaseSwitcherHostAccess, SWITCHER_SETTINGS_LOCK } from './tab-switcher-inline-settings.js';
import {
    allowsPreviewUrl,
    eligiblePage,
    TAB_SWITCHER_CAPTURE_ON_VISIT,
    TAB_SWITCHER_PAGE_PREVIEWS,
    TAB_SWITCHER_VISIT_PERMISSION,
} from './tab-switcher-previews.js';

export const TAB_PREVIEW_HINT_DISMISSED = 'tabSwitcherPreviewHintDismissed';
export const TAB_PREVIEW_HINT_PREFS = [TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_PREVIEW_HINT_DISMISSED];
// Chrome Web Store origins require a user invocation grant for capture.
const shortcutOnlyOrigins = new Set(['https://chromewebstore.google.com', 'https://chrome.google.com']);

export function shouldOfferVisitPreviewHint(settings, ignoreDismissal = false) {
    return settings[TAB_SWITCHER_PAGE_PREVIEWS] !== false && settings[TAB_SWITCHER_CAPTURE_ON_VISIT] === undefined &&
        (ignoreDismissal || settings[TAB_PREVIEW_HINT_DISMISSED] !== true);
}

export function isBrowsingPreviewCandidate(tab, excludedDomains) {
    return eligiblePage(tab) && !shortcutOnlyOrigins.has(new URL(tab.url).origin) &&
        allowsPreviewUrl(tab.url, excludedDomains);
}

export async function enableVisitPreviews(chromeApi, previousChoice, locks = navigator.locks) {
    // Chrome needs this call in the trusted click's user gesture, before waiting for the lock.
    const granted = await chromeApi.permissions.request(TAB_SWITCHER_VISIT_PERMISSION).catch(() => false);
    if (!granted) return 'denied';

    return locks.request(SWITCHER_SETTINGS_LOCK, async () => {
        const storage = chromeApi.storage.local;
        try {
            const settings = await storage.get([TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT]);
            const choice = settings[TAB_SWITCHER_CAPTURE_ON_VISIT];
            if (settings[TAB_SWITCHER_PAGE_PREVIEWS] === false || (choice !== true && choice !== previousChoice)) {
                await releaseSwitcherHostAccess(chromeApi);
                return 'disabled';
            }
            if (!await chromeApi.permissions.contains(TAB_SWITCHER_VISIT_PERMISSION)) return 'denied';
            if (choice !== true) await storage.set({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
            return 'enabled';
        } catch (error) {
            await releaseSwitcherHostAccess(chromeApi).catch(() => {});
            throw error;
        }
    });
}

export function setPreviewPreferences(chromeApi, preferences, locks = navigator.locks) {
    return locks.request(SWITCHER_SETTINGS_LOCK, async () => {
        await chromeApi.storage.local.set(preferences);
        if (preferences[TAB_SWITCHER_CAPTURE_ON_VISIT] === false) {
            await releaseSwitcherHostAccess(chromeApi);
        }
    });
}
