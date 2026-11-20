import { validPopupToken } from './popup-renderer.js';

const popupKey = incognito => incognito ? 'privateQuickSwitcherWindow' : 'quickSwitcherWindow';
const popupPage = chromeApi => `chrome-extension://${chromeApi.runtime.id}/quick-switcher.html`;
const popupUrl = (chromeApi, windowId, nonce) => `${popupPage(chromeApi)}?windowId=${windowId}&invocation=${nonce}`;

// Serialize toggles and bind a new palette before its renderer starts reading.
let pending = Promise.resolve();
let deletionPrompt;

export function forgetQuickSwitcherPrompt(windowId) {
    if (deletionPrompt?.popupId === windowId) deletionPrompt = undefined;
}

export async function authorizeQuickSwitcherWindow(chromeApi, sender) {
    if (sender.id !== chromeApi.runtime.id || sender.documentLifecycle !== 'active' || sender.frameId !== 0 ||
        !sender.tab || !sender.url?.startsWith(`${popupPage(chromeApi)}?`)) return {};
    await pending;
    const incognito = Boolean(sender.tab.incognito);
    const key = popupKey(incognito);
    const [stored, window] = await Promise.all([
        chromeApi.storage.session.get(key), chromeApi.windows.get(sender.tab.windowId),
    ]);
    const state = stored[key];
    if (!validPopupToken(state?.nonce) || window.type !== 'popup' || state.popupId !== sender.tab.windowId ||
        sender.url !== popupUrl(chromeApi, state.windowId, state.nonce)) return {};
    const response = { windowId: state.windowId, incognito };
    if (!incognito && deletionPrompt?.nonce === state.nonce) {
        response.deletion = deletionPrompt.draft;
        deletionPrompt = undefined;
    }
    return response;
}

function run(operation) {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
}

function findPickerTab(chromeApi, window) {
    const page = popupPage(chromeApi);
    return window.tabs?.find(tab => tab.url === page || tab.url?.startsWith(`${page}?`));
}

async function findPopup(chromeApi, source) {
    const popups = await chromeApi.windows.getAll({ windowTypes: ['popup'], populate: true });
    return popups.find(window => Boolean(window.incognito) === Boolean(source.incognito) && findPickerTab(chromeApi, window));
}

async function openNative(chromeApi, source, existing, draft) {
    if (!source.incognito) deletionPrompt = undefined;
    const nonce = crypto.randomUUID();
    const url = popupUrl(chromeApi, source.id, nonce);
    if (existing) {
        // Refresh the renderer even when opening from the same window again.
        await chromeApi.tabs.update(findPickerTab(chromeApi, existing).id, { url });
    }

    const width = Math.min(640, source.width ?? 640);
    const height = Math.min(560, source.height ?? 560);
    const bounds = {
        width, height,
        left: (source.left ?? 0) + Math.round(((source.width ?? width) - width) / 2),
        top: (source.top ?? 0) + Math.round(((source.height ?? height) - height) / 2),
        focused: true,
    };
    const open = options => existing
        ? chromeApi.windows.update(existing.id, options)
        : chromeApi.windows.create({ url, type: 'popup', incognito: Boolean(source.incognito), ...options });
    let opened;
    try {
        opened = await open(bounds);
    } catch (error) {
        // A disconnected display or a virtual test screen can invalidate the bounds.
        if (!/bounds.*visible screen space/i.test(error.message)) throw error;
        opened = await open({ width, height, focused: true });
    }
    const popupId = existing?.id ?? opened?.id;
    if (!Number.isInteger(popupId)) return false;
    try {
        await chromeApi.storage.session.set({ [popupKey(source.incognito)]: { windowId: source.id, nonce, popupId } });
    } catch (error) {
        await chromeApi.windows.remove(popupId).catch(() => {});
        throw error;
    }
    if (draft) deletionPrompt = { nonce, draft, popupId };
    return true;
}

export function confirmQuickSwitcherDeletion(chromeApi, tab, draft, verify) {
    return run(async () => {
        const source = await chromeApi.windows.get(tab.windowId).catch(() => null);
        if (!source?.focused || source.incognito || source.type !== 'normal') return false;
        const existing = await findPopup(chromeApi, source);
        if (!await verify()) return false;
        return openNative(chromeApi, source, existing, { ...draft, source: { id: tab.id, url: tab.url } });
    });
}

export function toggleQuickSwitcher(chromeApi = globalThis.chrome, sourceWindowId, overlay) {
    return run(async () => {
        let source;
        if (Number.isInteger(sourceWindowId) && sourceWindowId >= 0) {
            try { source = await chromeApi.windows.get(sourceWindowId, { populate: true }); } catch { /* Window closed before invocation. */ }
        }
        source ||= await chromeApi.windows.getLastFocused({ populate: true });
        const existing = await findPopup(chromeApi, source);

        if (existing?.id === source.id) {
            await chromeApi.windows.remove(existing.id);
            return;
        }

        const active = source.focused && source.type === 'normal' && source.tabs?.find(tab => tab.active);
        if (overlay && active) {
            if (await overlay.openSearch(active).catch(() => false)) {
                if (existing) await chromeApi.windows.remove(existing.id).catch(() => {});
                return;
            }
            const latest = await chromeApi.windows.get(source.id, { populate: true }).catch(() => null);
            if (!latest?.focused || !latest.tabs?.some(tab => tab.active && tab.id === active.id)) return;
        }

        return openNative(chromeApi, source, existing);
    });
}
