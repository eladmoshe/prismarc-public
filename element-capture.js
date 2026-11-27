export const ELEMENT_CAPTURE_COMMAND = 'captureElement';

const PICKER_FILE = 'capture-picker.js';
const PICKER_TYPE = 'elementCapturePicker';
const SELECTION_TYPE = 'elementCaptureSelection';
const CANCEL_TYPE = 'elementCaptureCancel';
const ACTIVITY_TYPE = 'elementCaptureActivity';
const PICKER_LIFETIME_MS = 25_000;
const SCRIPTING = { permissions: ['scripting'] };
const PNG_PREFIX = 'data:image/png;base64,';
const MAX_SIDE = 16_384;
const MAX_PIXELS = 40_000_000;
const MAX_ENCODED_LENGTH = 48 * 1024 * 1024;
const CAPTURE_ERROR = 'Could not capture this selection.';

function eligibleTab(tab) {
    if (!tab || !Number.isInteger(tab.id) || tab.id < 0 ||
        !Number.isInteger(tab.windowId) || tab.windowId < 0 || tab.discarded ||
        (tab.pendingUrl && tab.pendingUrl !== tab.url)) return false;
    try {
        const url = new URL(tab.url);
        return (url.protocol === 'https:' || url.protocol === 'http:') &&
            url.hostname !== 'chromewebstore.google.com' &&
            !(url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'));
    } catch {
        return false;
    }
}

function boundedSize(width, height) {
    return Number.isInteger(width) && Number.isInteger(height) &&
        width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE && width * height <= MAX_PIXELS;
}

function clippedSelection(rect, viewport) {
    const { width, height } = viewport ?? {};
    if (!boundedSize(width, height) || !rect ||
        ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
        Math.abs(rect.x) > MAX_SIDE || Math.abs(rect.y) > MAX_SIDE ||
        rect.width <= 0 || rect.height <= 0 || rect.width > MAX_SIDE || rect.height > MAX_SIDE) {
        throw new Error(CAPTURE_ERROR);
    }
    const x = Math.max(0, rect.x);
    const y = Math.max(0, rect.y);
    const cropWidth = Math.min(width, rect.x + rect.width) - x;
    const cropHeight = Math.min(height, rect.y + rect.height) - y;
    if (cropWidth <= 0 || cropHeight <= 0) throw new Error(CAPTURE_ERROR);
    return { x, y, width: cropWidth, height: cropHeight };
}

export function captureCrop(rect, viewport, bitmap) {
    const crop = clippedSelection(rect, viewport);
    if (!boundedSize(bitmap?.width, bitmap?.height)) throw new Error(CAPTURE_ERROR);
    // Use the actual bitmap dimensions to account for page zoom, display
    // scaling, and independent rounding of the captured viewport edges.
    const x = Math.round(crop.x * bitmap.width / viewport.width);
    const y = Math.round(crop.y * bitmap.height / viewport.height);
    const right = Math.round((crop.x + crop.width) * bitmap.width / viewport.width);
    const bottom = Math.round((crop.y + crop.height) * bitmap.height / viewport.height);
    if (right <= x || bottom <= y) throw new Error(CAPTURE_ERROR);
    return { x, y, width: right - x, height: bottom - y };
}

async function cropPng(screenshot, rect, viewport) {
    if (typeof screenshot !== 'string' || !screenshot.startsWith(PNG_PREFIX) ||
        screenshot.length > MAX_ENCODED_LENGTH) throw new Error(CAPTURE_ERROR);
    const encoded = screenshot.slice(PNG_PREFIX.length);
    // PNG's IHDR gives the dimensions before decoding can allocate pixels.
    const header = Uint8Array.from(atob(encoded.slice(0, 32)), char => char.charCodeAt(0));
    const dimensions = new DataView(header.buffer);
    if (dimensions.getUint32(12) !== 0x49484452 ||
        !boundedSize(dimensions.getUint32(16), dimensions.getUint32(20))) throw new Error(CAPTURE_ERROR);

    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = binary.charCodeAt(index);
    }
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    try {
        const { x, y, width, height } = captureCrop(rect, viewport, bitmap);
        const canvas = new OffscreenCanvas(width, height);
        canvas.getContext('2d').drawImage(bitmap, x, y, width, height, 0, 0, width, height);
        const png = await canvas.convertToBlob({ type: 'image/png' });
        if (Math.ceil(png.size / 3) * 4 > MAX_ENCODED_LENGTH) throw new Error(CAPTURE_ERROR);
        const output = new Uint8Array(await png.arrayBuffer());
        let cropped = '';
        for (let offset = 0; offset < output.length; offset += 0x8000) {
            cropped += String.fromCharCode(...output.subarray(offset, offset + 0x8000));
        }
        return btoa(cropped);
    } finally {
        bitmap.close();
    }
}

function senderMatchesOrigin(sender, expectedUrl) {
    if (sender.url === expectedUrl) return true;
    try {
        // Chrome can report the original URL after a same-document route change.
        // The bound document and its live route are still checked before capture.
        const origin = new URL(expectedUrl).origin;
        return sender.origin === origin && new URL(sender.url).origin === origin;
    } catch {
        return false;
    }
}

export class ElementCapture {
    #session;
    #attempt = 0;
    #coverVersion = 0;

    constructor(chromeApi, { canStart = () => true, getAppearance = async () => 'dark' } = {}) {
        this.chrome = chromeApi;
        this.canStart = canStart;
        this.getAppearance = getAppearance;
    }

    get coverVersion() {
        return this.#coverVersion;
    }

    coversTab(tabId) {
        return this.#session?.tabId === tabId;
    }

    register() {
        const { tabs, windows, permissions } = this.chrome;
        tabs.onActivated?.addListener(({ tabId, windowId }) => {
            const session = this.#session;
            if (session?.windowId === windowId && session.tabId !== tabId) this.#retire(session, true);
        });
        tabs.onUpdated?.addListener((tabId, change) => {
            if (change.url !== undefined || change.status === 'loading' || change.discarded) this.#invalidateTab(tabId);
        });
        tabs.onDetached?.addListener(tabId => this.#invalidateTab(tabId));
        tabs.onRemoved?.addListener(tabId => this.#invalidateTab(tabId));
        tabs.onReplaced?.addListener((_, tabId) => this.#invalidateTab(tabId));
        windows.onFocusChanged?.addListener(windowId => {
            const session = this.#session;
            if (session && session.windowId !== windowId) this.#retire(session, true);
        });
        permissions.onRemoved?.addListener(({ permissions: removed }) => {
            if (this.#session && removed?.includes('scripting')) this.#retire(this.#session, true);
        });
    }

    async start(tab) {
        const attempt = ++this.#attempt;
        const previous = this.#session;
        if (previous) {
            this.#retire(previous, true);
            if (tab?.id === previous.tabId || tab === undefined) return true;
        }
        if (tab && (!eligibleTab(tab) || !this.canStart(tab.id))) return false;
        let session;
        try {
            // Native extension commands and menu clicks carry the user gesture.
            // Also honor an existing grant if Chrome does not forward it here.
            const permitted = await this.chrome.permissions.request(SCRIPTING)
                .catch(() => this.chrome.permissions.contains(SCRIPTING));
            if (this.#attempt !== attempt) return true;
            if (!permitted) return false;
            tab ??= (await this.chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
            if (this.#attempt !== attempt) return true;
            if (!eligibleTab(tab) || !this.canStart(tab.id)) return false;
            session = { token: crypto.randomUUID(), tabId: tab.id, windowId: tab.windowId, url: tab.url };
            this.#session = session;
            this.#coverVersion++;
            const theme = await this.getAppearance(session.windowId, session.tabId).catch(() => 'dark');
            if (!await this.#isForeground(session)) throw new Error(CAPTURE_ERROR);

            const [result] = await this.chrome.scripting.executeScript({
                target: { tabId: session.tabId },
                files: [PICKER_FILE],
                world: 'ISOLATED',
            });
            if (!result?.documentId || result.frameId !== 0 ||
                !await this.#isForeground(session)) throw new Error(CAPTURE_ERROR);
            session.documentId = result.documentId;
            this.#renew(session);
            const response = await this.#messagePicker(session, 'start', { theme });
            if (response?.success !== true) throw new Error(CAPTURE_ERROR);
            return true;
        } catch {
            if (session) {
                const wasCancelled = this.#session !== session;
                this.#retire(session, true);
                if (wasCancelled) return true;
            }
            return false;
        }
    }

    receive(message, sender) {
        const session = this.#session;
        if (!session?.documentId || session.selecting ||
            !message || typeof message !== 'object' || Array.isArray(message) ||
            ![SELECTION_TYPE, CANCEL_TYPE, ACTIVITY_TYPE].includes(message.type) ||
            message.token !== session.token || sender?.id !== this.chrome.runtime.id ||
            sender.frameId !== 0 || sender.documentId !== session.documentId ||
            sender.documentLifecycle !== 'active' || sender.tab?.id !== session.tabId ||
            sender.tab?.windowId !== session.windowId || !senderMatchesOrigin(sender, session.url)) return;
        if (message.type === CANCEL_TYPE) {
            this.#retire(session);
            return Promise.resolve({ success: true });
        }
        this.#renew(session);
        if (message.type === ACTIVITY_TYPE) return Promise.resolve({ success: true });
        session.selecting = true;
        return this.#capture(session, message);
    }

    #renew(session) {
        clearTimeout(session.timer);
        session.timer = setTimeout(() => this.#retire(session, true), PICKER_LIFETIME_MS);
    }

    #invalidateTab(tabId) {
        if (this.#session?.tabId === tabId) this.#retire(this.#session, true);
    }

    #retire(session, dismiss = false) {
        if (this.#session !== session) return;
        this.#session = undefined;
        this.#coverVersion++;
        clearTimeout(session.timer);
        if (dismiss && session.documentId) this.#messagePicker(session, 'cancel').catch(() => {});
    }

    #messagePicker(session, action, options = {}) {
        return this.chrome.tabs.sendMessage(session.tabId, { type: PICKER_TYPE, action, token: session.token, ...options },
            { documentId: session.documentId });
    }

    async #isForeground(session) {
        if (this.#session !== session || !this.canStart(session.tabId)) return false;
        const window = await this.chrome.windows.get(session.windowId, { populate: true });
        const tab = window.tabs?.find(candidate => candidate.active);
        return this.#session === session && this.canStart(session.tabId) && window.focused && window.type === 'normal' &&
            eligibleTab(tab) && tab.id === session.tabId && tab.windowId === session.windowId && tab.url === session.url;
    }

    async #verifySource(session, viewport) {
        if (!await this.#isForeground(session)) throw new Error(CAPTURE_ERROR);
        const [result] = await this.chrome.scripting.executeScript({
            target: { tabId: session.tabId, documentIds: [session.documentId] },
            world: 'ISOLATED',
            func: () => ({ width: window.innerWidth, height: window.innerHeight, url: window.location.href }),
        });
        if (result?.frameId !== 0 || result.documentId !== session.documentId ||
            result.result?.width !== viewport.width || result.result?.height !== viewport.height ||
            result.result?.url !== session.url ||
            !await this.#isForeground(session)) throw new Error(CAPTURE_ERROR);
    }

    async #capture(session, message) {
        try {
            const viewport = { width: message.viewportWidth, height: message.viewportHeight };
            const rect = clippedSelection(message.rect, viewport);
            await this.#verifySource(session, viewport);
            const screenshot = await this.chrome.tabs.captureVisibleTab(session.windowId, { format: 'png' });
            await this.#verifySource(session, viewport);
            const png = await cropPng(screenshot, rect, viewport);
            await this.#verifySource(session, viewport);
            return { success: true, png };
        } catch {
            return { success: false, error: CAPTURE_ERROR };
        } finally {
            this.#retire(session);
        }
    }
}
