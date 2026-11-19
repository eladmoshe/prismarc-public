import {
    TAB_SWITCHER_CAPTURE_ON_VISIT,
    TAB_SWITCHER_PAGE_PREVIEWS,
    TAB_SWITCHER_VISIT_PERMISSION,
} from './tab-switcher-previews.js';

const previewSettingsLock = 'tabSwitcherPreviewSettings';

export async function enableVisitPreviews(chromeApi, previousChoice, locks = navigator.locks) {
    // Chrome needs this call in the trusted click's user gesture, before waiting for the lock.
    const granted = await chromeApi.permissions.request(TAB_SWITCHER_VISIT_PERMISSION).catch(() => false);
    if (!granted) return 'denied';

    return locks.request(previewSettingsLock, async () => {
        const storage = chromeApi.storage.local;
        try {
            const settings = await storage.get([TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT]);
            const choice = settings[TAB_SWITCHER_CAPTURE_ON_VISIT];
            if (settings[TAB_SWITCHER_PAGE_PREVIEWS] === false || (choice !== true && choice !== previousChoice)) {
                await chromeApi.permissions.remove(TAB_SWITCHER_VISIT_PERMISSION);
                return 'disabled';
            }
            if (!await chromeApi.permissions.contains(TAB_SWITCHER_VISIT_PERMISSION)) return 'denied';
            if (choice !== true) await storage.set({ [TAB_SWITCHER_CAPTURE_ON_VISIT]: true });
            return 'enabled';
        } catch (error) {
            await chromeApi.permissions.remove(TAB_SWITCHER_VISIT_PERMISSION).catch(() => {});
            throw error;
        }
    });
}

export function setPreviewPreferences(chromeApi, preferences, locks = navigator.locks) {
    return locks.request(previewSettingsLock, async () => {
        await chromeApi.storage.local.set(preferences);
        if (preferences[TAB_SWITCHER_CAPTURE_ON_VISIT] === false) {
            await chromeApi.permissions.remove(TAB_SWITCHER_VISIT_PERMISSION);
        }
    });
}
