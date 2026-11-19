export const INLINE_SWITCHER = 'tabSwitcherInline';
export const SWITCHER_HOST_ACCESS = { origins: ['<all_urls>'] };
export const INLINE_ACCESS = { ...SWITCHER_HOST_ACCESS, permissions: ['scripting'] };
export const SWITCHER_SETTINGS_LOCK = 'tabSwitcherPreviewSettings';

export async function setInlineSwitcher(chromeApi, enabled, previousChoice, locks = navigator.locks) {
    if (enabled && !await chromeApi.permissions.request(INLINE_ACCESS).catch(() => false)) return false;
    return locks.request(SWITCHER_SETTINGS_LOCK, async () => {
        const storage = chromeApi.storage.local;
        const current = (await storage.get(INLINE_SWITCHER))[INLINE_SWITCHER];
        if (!enabled) {
            await storage.set({ [INLINE_SWITCHER]: false });
            await releaseInlineAccess(chromeApi);
            return true;
        }
        try {
            if ((current !== true && current !== previousChoice) || !await chromeApi.permissions.contains(INLINE_ACCESS)) {
                if (current !== true) await releaseInlineAccess(chromeApi);
                return false;
            }
            if (current !== true) await storage.set({ [INLINE_SWITCHER]: true });
            return true;
        } catch (error) {
            if (current !== true) await releaseInlineAccess(chromeApi).catch(() => {});
            throw error;
        }
    });
}

async function releaseInlineAccess(chromeApi) {
    await chromeApi.permissions.remove({ permissions: INLINE_ACCESS.permissions });
    await releaseSwitcherHostAccess(chromeApi);
}

export async function releaseSwitcherHostAccess(chromeApi) {
    const settings = await chromeApi.storage.local.get([INLINE_SWITCHER, 'tabSwitcherCaptureOnVisit']);
    if (settings[INLINE_SWITCHER] !== true && settings.tabSwitcherCaptureOnVisit !== true) {
        await chromeApi.permissions.remove(SWITCHER_HOST_ACCESS);
    }
}
