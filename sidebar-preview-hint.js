import { enableVisitPreviews, shouldOfferVisitPreviewHint, TAB_PREVIEW_HINT_DISMISSED, TAB_PREVIEW_HINT_PREFS } from './tab-switcher-preview-settings.js';

export async function setupSidebarPreviewHint(currentWindow) {
    if (currentWindow.type !== 'normal' || currentWindow.incognito) return;

    const hint = document.getElementById('tabPreviewHint');
    const enable = document.getElementById('tabPreviewHintEnable');
    const dismiss = document.getElementById('tabPreviewHintDismiss');
    const message = document.getElementById('tabPreviewHintMessage');
    let busy = false;
    let declinedHere = false;
    let dismissedHere = false;
    let revision = 0;

    async function refresh() {
        const request = ++revision;
        const settings = await chrome.storage.local.get(TAB_PREVIEW_HINT_PREFS);
        if (request !== revision) return;
        const eligible = !dismissedHere && shouldOfferVisitPreviewHint(settings, declinedHere);
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
        if (area === 'local' && TAB_PREVIEW_HINT_PREFS.some(key => changes[key])) refresh().catch(() => {});
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
