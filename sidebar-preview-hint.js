import { enableVisitPreviews } from './tab-switcher-preview-settings.js';
import { TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_PAGE_PREVIEWS } from './tab-switcher-previews.js';

export const TAB_PREVIEW_HINT_DISMISSED = 'tabSwitcherPreviewHintDismissed';

export async function setupSidebarPreviewHint(currentWindow) {
    if (currentWindow.type !== 'normal' || currentWindow.incognito) return;

    const hint = document.getElementById('tabPreviewHint');
    const enable = document.getElementById('tabPreviewHintEnable');
    const dismiss = document.getElementById('tabPreviewHintDismiss');
    const message = document.getElementById('tabPreviewHintMessage');
    const keys = [TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_PREVIEW_HINT_DISMISSED];
    let busy = false;
    let declinedHere = false;
    let dismissedHere = false;
    let revision = 0;

    async function refresh() {
        const request = ++revision;
        const settings = await chrome.storage.local.get(keys);
        if (request !== revision) return;
        const eligible = !dismissedHere && settings[TAB_SWITCHER_PAGE_PREVIEWS] !== false &&
            settings[TAB_SWITCHER_CAPTURE_ON_VISIT] === undefined &&
            (declinedHere || settings[TAB_PREVIEW_HINT_DISMISSED] !== true);
        const moveFocus = !eligible && hint.contains(document.activeElement);
        hint.hidden = !eligible;
        if (moveFocus) document.getElementById('quickSwitcherBtn').focus({ preventScroll: true });
    }

    function setBusy(value) {
        busy = value;
        enable.setAttribute('aria-disabled', String(value));
        dismiss.setAttribute('aria-disabled', String(value));
    }

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && keys.some(key => changes[key])) refresh().catch(() => {});
    });
    dismiss.addEventListener('click', async () => {
        if (busy || hint.hidden) return;
        setBusy(true);
        try {
            await chrome.storage.local.set({ [TAB_PREVIEW_HINT_DISMISSED]: true });
            dismissedHere = true;
            await refresh();
        } catch {
            message.textContent = 'Could not save dismissal. Try again.';
        } finally {
            setBusy(false);
        }
    });
    enable.addEventListener('click', async event => {
        if (!event.isTrusted || busy || declinedHere || hint.hidden) return;
        setBusy(true);
        try {
            const result = await enableVisitPreviews(chrome, undefined);
            if (result === 'denied') {
                declinedHere = true;
                if (document.activeElement === enable) dismiss.focus({ preventScroll: true });
                enable.hidden = true;
                message.textContent = 'Chrome didn’t grant access. Shortcut previews are still on.';
                await chrome.storage.local.set({ [TAB_PREVIEW_HINT_DISMISSED]: true });
            }
            await refresh();
        } catch {
            message.textContent = 'Could not enable previews as you browse. Try again in Settings.';
        } finally {
            setBusy(false);
        }
    });
    await refresh();
}
