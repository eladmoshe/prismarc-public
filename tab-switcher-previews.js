import { previewStorageMode, TabSwitcherPreviewStore } from './tab-switcher-preview-store.js';

export const TAB_SWITCHER_PAGE_PREVIEWS = 'tabSwitcherPagePreviews';
export const TAB_SWITCHER_PREVIEW_CACHE = 'tabSwitcherPreviewCache';
export const TAB_SWITCHER_CAPTURE_ON_VISIT = 'tabSwitcherCaptureOnVisit';
export const TAB_SWITCHER_VISIT_PERMISSION = { origins: ['<all_urls>'] };

export const TAB_SWITCHER_EXCLUDED_DOMAINS = 'tabSwitcherExcludedDomains';

export function parsePreviewDomains(value) {
    const domains = value.toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (domains.length > 250 || domains.some(domain => domain.length > 253 ||
        !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) {
        throw new Error('Enter up to 250 domain names, such as example.com, without paths or wildcards.');
    }
    return [...new Set(domains)];
}

const JPEG = 'data:image/jpeg;base64,';
const HANDOFF_BUDGET_MS = 35;
const PREVIEW_WAIT_MS = 300;
const CAPTURE_WINDOW_MS = 1000;
const CAPTURE_LIMIT = 2;
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_EXPIRY_ALARM = 'tabSwitcherPreviewExpiry';
const CAPTURE_WORK_MS = 1000;
const VISIT_SUBMISSION_MS = 250;
const PREVIEW_LIMIT = 5;
const VISIT_DWELL_MS = 200;
const VISIT_REPEAT_MS = 2500;
const SOURCE_LENGTH_LIMIT = 8 * 1024 * 1024;
const JPEG_BYTE_LIMIT = 40 * 1024;

async function resizePreview(source) {
    if (!source?.startsWith(JPEG) || source.length > SOURCE_LENGTH_LIMIT) return null;
    const payload = source.slice(JPEG.length);
    const bytes = Uint8Array.fromBase64 ? Uint8Array.fromBase64(payload) :
        Uint8Array.from(atob(payload), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    try {
        const scale = Math.min(1, 384 / bitmap.width, 240 / bitmap.height);
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const options = { type: 'image/jpeg', quality: .7 };
        let blob = await canvas.convertToBlob(options);
        if (blob.size > JPEG_BYTE_LIMIT) {
            // Textured or noisy views may need a smaller canvas to fit the same cap.
            canvas.width = Math.max(1, Math.floor(canvas.width / 2));
            canvas.height = Math.max(1, Math.floor(canvas.height / 2));
            canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            blob = await canvas.convertToBlob(options);
        }
        if (blob.type !== 'image/jpeg' || blob.size > JPEG_BYTE_LIMIT) return null;
        const thumbnail = new Uint8Array(await blob.arrayBuffer());
        return JPEG + (thumbnail.toBase64 ? thumbnail.toBase64() : btoa(String.fromCharCode(...thumbnail)));
    } finally {
        bitmap.close();
    }
}

function eligiblePage(tab) {
    return Number.isInteger(tab?.id) && tab.id >= 0 && Number.isInteger(tab.windowId) &&
        tab.windowId >= 0 && tab.incognito === false &&
        /^https?:\/\//i.test(tab.url) && !tab.pendingUrl && !tab.discarded &&
        tab.status !== 'loading' && tab.status !== 'unloaded';
}

function validSource(tab) {
    return eligiblePage(tab) && tab.active === true;
}

function captureFailure(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    if (message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) return { retry: true };
    if (/^Failed to capture tab: (image readback failed|encoding failed|view is invisible)$/.test(message)) return { retry: true };
    // Treat permission, policy, and unrecognized native errors as denials.
    return { denied: true };
}

function isSmallJpeg(data) {
    return typeof data === 'string' && data.length <= JPEG.length + Math.ceil(JPEG_BYTE_LIMIT / 3) * 4 &&
        data.startsWith(JPEG);
}

export class TabSwitcherPreviews {
    constructor(chromeApi, { now = Date.now, resize = resizePreview } = {}) {
        this.chrome = chromeApi;
        this.store = new TabSwitcherPreviewStore(chromeApi);
        this.retired = new Set();
        this.now = now;
        this.resize = resize;
        this.enabled = false;
        this.permitted = true;
        this.revision = 0;
        this.domainRevision = 0;
        this.excludedDomains = [];
        this.visitRevision = 0;
        this.captureOnVisit = false;
        this.visitAllowed = false;
        this.visitVersion = 0;
        this.visitRequest = 0;
        this.scheduledVisitRequest = 0;
        this.permissionVersion = 0;
        this.previews = new Map();
        this.pending = new Map();
        this.captureTimes = [];
        this.ready = Promise.resolve();
        this.cacheWork = Promise.resolve();
        this.permissionReady = Promise.resolve();
    }

    register() {
        const revision = this.revision;
        const visitRevision = this.visitRevision;
        const domainRevision = this.domainRevision;
        this.chrome.storage.onChanged?.addListener((changes, area) => {
            if (area !== 'local') return;
            const preview = changes[TAB_SWITCHER_PAGE_PREVIEWS];
            const visit = changes[TAB_SWITCHER_CAPTURE_ON_VISIT];
            if (!preview && !visit && !changes[TAB_SWITCHER_EXCLUDED_DOMAINS]) return;
            if (changes[TAB_SWITCHER_EXCLUDED_DOMAINS]) {
                this.domainRevision++;
                this.excludedDomains = changes[TAB_SWITCHER_EXCLUDED_DOMAINS].newValue ?? [];
                this.clear();
            }
            if (preview) {
                this.revision++;
                this.enabled = preview.newValue !== false;
            }
            if (visit) {
                this.visitRevision++;
                this.captureOnVisit = visit.newValue === true;
            }
            if (!this.enabled || (visit && !this.captureOnVisit)) this.clear();
            else this.queueCurrentVisit();
        });
        this.ready = Promise.resolve().then(() => this.chrome.storage.local.get([
            TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_EXCLUDED_DOMAINS,
        ])).then(settings => {
            if (domainRevision === this.domainRevision) this.excludedDomains = settings[TAB_SWITCHER_EXCLUDED_DOMAINS] ?? [];
            if (revision === this.revision) this.enabled = settings[TAB_SWITCHER_PAGE_PREVIEWS] !== false;
            if (visitRevision === this.visitRevision) this.captureOnVisit = settings[TAB_SWITCHER_CAPTURE_ON_VISIT] === true;
        }).catch(() => {});
        this.refreshVisitPermission();
        // The session index contains only tab IDs, capture times and opaque refs.
        this.cacheWork = this.restoreCache().catch(() => {});
        this.cacheWork.then(() => this.queueCurrentVisit(true));
        this.chrome.alarms?.onAlarm?.addListener(alarm => {
            if (alarm.name === PREVIEW_EXPIRY_ALARM) this.updateCache(() => {});
        });
        this.chrome.permissions?.onRemoved?.addListener(({ permissions, origins }) => {
            if (permissions?.includes('activeTab')) {
                this.permitted = false;
                this.clear();
            }
            if (origins?.length) {
                this.visitAllowed = false;
                this.clear();
                this.refreshVisitPermission();
            }
        });
        this.chrome.permissions?.onAdded?.addListener(({ permissions, origins }) => {
            if (permissions?.includes('activeTab')) this.permitted = true;
            if (origins?.length) {
                this.refreshVisitPermission();
                this.queueCurrentVisit();
            }
        });
        this.chrome.tabs.onUpdated?.addListener((tabId, change, tab) => {
            if (change.url !== undefined || change.status === 'loading' || change.discarded === true) {
                this.invalidate(tabId);
            }
            if (tab?.active && (change.status === 'complete' || change.url !== undefined)) {
                this.queueVisit(tab.windowId, tabId);
            }
        });
        this.chrome.tabs.onRemoved?.addListener(tabId => this.invalidate(tabId));
        this.chrome.tabs.onDetached?.addListener(tabId => this.invalidate(tabId));
        this.chrome.tabs.onReplaced?.addListener((added, removed) => {
            this.invalidate(removed);
            this.invalidate(added);
        });
        this.chrome.tabs.onActivated?.addListener(({ tabId, windowId }) => {
            const job = this.checking;
            if (job?.windowId === windowId && job.tabId !== tabId) job.invalid = true;
            this.queueVisit(windowId, tabId);
        });
        this.chrome.windows?.onFocusChanged?.addListener(windowId => {
            if (this.checking && this.checking.windowId !== windowId) this.checking.invalid = true;
            this.stopQueuedVisit();
            if (windowId >= 0) this.queueVisit(windowId);
        });
    }

    refreshVisitPermission() {
        const version = ++this.permissionVersion;
        this.permissionReady = Promise.resolve().then(() => this.chrome.permissions?.contains?.(TAB_SWITCHER_VISIT_PERMISSION))
            .then(granted => {
                if (this.permissionVersion === version) this.visitAllowed = granted === true;
            }).catch(() => {});
    }

    canCaptureVisit() {
        return this.enabled && this.permitted && this.captureOnVisit && this.visitAllowed;
    }

    stopQueuedVisit() {
        this.scheduledVisitRequest = ++this.visitRequest;
        this.visitVersion++;
        clearTimeout(this.visitTimer);
    }

    queueCurrentVisit(missingOnly = false) {
        Promise.all([this.ready, this.permissionReady]).then(async () => {
            if (!this.canCaptureVisit()) return;
            const window = await this.chrome.windows.getLastFocused({ windowTypes: ['normal'] });
            if (!Number.isInteger(window?.id) || window.id < 0) return;
            const tab = await this.foregroundTab(window.id);
            if (!validSource(tab) || !this.allowsUrl(tab.url)) return;
            if (missingOnly && this.recordAllowed(this.previews.get(tab.id))) return;
            this.queueVisit(window.id, tab.id);
        }).catch(() => {});
    }

    queueVisit(windowId, tabId) {
        const request = ++this.visitRequest;
        this.scheduleVisit(windowId, tabId, request).catch(() => {});
    }

    async scheduleVisit(windowId, tabId, request) {
        await Promise.all([this.ready, this.permissionReady]);
        if (!this.canCaptureVisit() || !await this.foregroundTab(windowId, tabId) ||
            request <= this.scheduledVisitRequest || !this.canCaptureVisit()) return;
        this.scheduledVisitRequest = request;
        clearTimeout(this.visitTimer);
        const version = ++this.visitVersion;
        this.waitForVisit(windowId, tabId, version, VISIT_DWELL_MS);
    }

    waitForVisit(windowId, tabId, version, delay, mayRetry = true) {
        this.visitTimer = setTimeout(() => this.captureVisit(windowId, tabId, version, mayRetry).catch(() => {}), delay);
    }

    async captureVisit(windowId, tabId, version, mayRetry) {
        if (version !== this.visitVersion || !this.canCaptureVisit()) return;
        const tab = await this.foregroundTab(windowId, tabId);
        if (version !== this.visitVersion || !validSource(tab) || !this.canCaptureVisit() || !this.allowsUrl(tab.url)) return;
        if (this.hasFreshVisit(tab.id)) return;
        const delay = this.captureDelay();
        if (delay > 0) {
            this.waitForVisit(windowId, tab.id, version, delay, mayRetry);
            return;
        }
        const job = await this.capture(tab, true);
        // Capture can be busy with the previous visit or the native screenshot
        // can temporarily fail while Chrome is painting the new foreground tab.
        const retry = !job || await job.preview === 'retry';
        if (retry && mayRetry && version === this.visitVersion && this.canCaptureVisit()) {
            this.waitForVisit(windowId, tab.id, version, CAPTURE_WINDOW_MS, false);
        }
    }

    hasFreshVisit(tabId) {
        const record = this.previews.get(tabId);
        return record?.visit && this.canCaptureVisit() && record.capturedAt > this.now() - VISIT_REPEAT_MS;
    }

    captureDelay() {
        const now = this.now();
        this.captureTimes = this.captureTimes.filter(time => now - time < CAPTURE_WINDOW_MS);
        return this.captureTimes.length >= CAPTURE_LIMIT ? this.captureTimes[0] + CAPTURE_WINDOW_MS - now : 0;
    }

    recordAllowed(record) {
        if (!this.enabled || !this.permitted || !record) return false;
        return record.visit === true ? this.canCaptureVisit() : record.expiresAt > this.now();
    }

    async restoreCache() {
        await Promise.all([this.ready, this.permissionReady]);
        const stored = await this.chrome.storage.session.get(TAB_SWITCHER_PREVIEW_CACHE);
        const now = this.now();
        for (const [key, record] of Object.entries(stored[TAB_SWITCHER_PREVIEW_CACHE] ?? {})) {
            const id = Number(key);
            // Old versions kept raw images in this index. Never migrate image data.
            if (!Number.isSafeInteger(id) || id < 0 || String(id) !== key ||
                !this.recordAllowed(record) || previewStorageMode(record.ref) !== (record.visit === true ? 'disk' : 'session') ||
                !Number.isFinite(record.capturedAt) || record.capturedAt > now ||
                (!record.visit && record.expiresAt !== record.capturedAt + PREVIEW_TTL_MS)) continue;
            const { ref, capturedAt } = record;
            this.previews.set(id, record.visit === true ? { ref, capturedAt, visit: true } :
                { ref, capturedAt, expiresAt: record.expiresAt });
        }
        // A new browser session has an empty index and a new key. Sweep orphan
        // ciphertext even when no tab records survived the previous session.
        const surviving = await this.store.reconcile([...this.previews.values()].map(record => record.ref));
        for (const [id, record] of this.previews) {
            if (!surviving.has(record.ref)) this.forget(id);
        }
        await this.persistCache();
    }

    updateCache(update) {
        const operation = this.cacheWork.then(async () => {
            if (await update() === false) return;
            await this.persistCache();
        });
        this.cacheWork = operation.catch(() => {});
        return this.cacheWork;
    }

    forget(tabId) {
        const record = this.previews.get(tabId);
        if (!record) return false;
        this.retired.add(record.ref);
        return this.previews.delete(tabId);
    }

    forgetAll() {
        for (const id of this.previews.keys()) this.forget(id);
    }

    clear() {
        this.stopQueuedVisit();
        if (this.checking) this.checking.invalid = true;
        this.pending.clear();
        this.forgetAll();
        this.updateCache(() => this.forgetAll());
    }

    invalidate(tabId) {
        if (this.checking?.tabId === tabId) this.checking.invalid = true;
        this.pending.delete(tabId);
        const removed = this.forget(tabId);
        this.updateCache(() => this.forget(tabId) || removed);
    }

    async persistCache() {
        for (const [id, preview] of this.previews) {
            if (!this.recordAllowed(preview)) this.forget(id);
        }
        const oldest = [...this.previews].sort((a, b) => a[1].capturedAt - b[1].capturedAt);
        for (const [id] of oldest.slice(0, Math.max(0, oldest.length - PREVIEW_LIMIT))) this.forget(id);
        if (this.retired.size) {
            const discarded = [...this.retired];
            await this.store.delete(discarded);
            for (const ref of discarded) this.retired.delete(ref);
        }
        if (this.previews.size) {
            await this.chrome.storage.session.set({ [TAB_SWITCHER_PREVIEW_CACHE]: Object.fromEntries(this.previews) });
        } else {
            await this.chrome.storage.session.remove(TAB_SWITCHER_PREVIEW_CACHE);
        }
        const deadlines = [...this.previews.values()].filter(record => !record.visit).map(record => record.expiresAt);
        if (deadlines.length) await this.chrome.alarms?.create?.(PREVIEW_EXPIRY_ALARM, { when: Math.min(...deadlines) });
        else await this.chrome.alarms?.clear?.(PREVIEW_EXPIRY_ALARM);
    }

    async foregroundTab(windowId, tabId) {
        const window = await this.chrome.windows.get(windowId, { populate: true });
        if (!window.focused || window.type !== 'normal' || window.incognito) return null;
        const active = window.tabs?.find(tab => tab.active);
        return active?.windowId === windowId && (tabId === undefined || active.id === tabId) ? active : null;
    }

    allowsUrl(url) {
        if (!Array.isArray(this.excludedDomains)) return false;
        const host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
        return !this.excludedDomains.some(domain => host === domain || host.endsWith('.' + domain));
    }

    async isForeground(source) {
        const tab = await this.foregroundTab(source.windowId, source.id);
        return validSource(tab) && tab.url === source.url && this.allowsUrl(tab.url);
    }

    async capture(source, visit = false) {
        if (!validSource(source) || this.checking || !this.chrome.tabs.captureVisibleTab) return;
        if (!visit && this.hasFreshVisit(source.id)) return;
        const job = { tabId: source.id, windowId: source.windowId, invalid: false, visit };
        this.checking = job;
        let deadline;
        try {
            // Await identity checks and submission only. The browser chooses
            // WebContents on submission. Encoding and page paint stay off the
            // tab-switch operation's critical path.
            await Promise.race([
                this.submit(source, job),
                new Promise(resolve => {
                    deadline = setTimeout(() => { job.invalid = true; resolve(); },
                        visit ? VISIT_SUBMISSION_MS : HANDOFF_BUDGET_MS);
                }),
            ]);
        } catch {
            // Capture can be denied by browser policy or interrupted by focus.
        } finally {
            clearTimeout(deadline);
            if (this.checking === job) this.checking = null;
        }
        if (job.preview) return job;
    }

    async submit(source, job) {
        await this.ready;
        if (!this.jobAllowed(job) || this.pending.has(job.tabId) || this.captureDelay() ||
            !await this.isForeground(source) || !this.jobAllowed(job)) return;
        job.allowDisk = this.canCaptureVisit();
        this.captureTimes.push(this.now());
        const image = this.chrome.tabs.captureVisibleTab(job.windowId, { format: 'jpeg', quality: 45 })
            .then(raw => ({ raw }), captureFailure);
        if (!await this.isForeground(source) || !this.jobAllowed(job)) return;

        this.pending.set(job.tabId, job);
        job.preview = this.finishCapture(job, source, image);
    }

    jobAllowed(job) {
        return !job.invalid && this.enabled && this.permitted && (!job.visit || this.canCaptureVisit());
    }

    async finishCapture(job, source, image) {
        let deadline;
        try {
            const encoded = image.then(async result => {
                if (!result.raw) return result;
                if (this.pending.get(job.tabId) !== job || !this.jobAllowed(job)) return {};
                // Chrome has bound the capture to the verified WebContents.
                // Check that the same document remains eligible after readback.
                const tab = await this.chrome.tabs.get(job.tabId);
                if (tab?.id !== job.tabId || !eligiblePage(tab) || tab.url !== source.url ||
                    tab.windowId !== job.windowId) return {};
                const data = await this.resize(result.raw);
                return data ? { data } : { retry: true };
            });
            const { data, denied, retry } = await Promise.race([
                encoded.catch(() => ({ retry: true })),
                new Promise(resolve => { deadline = setTimeout(() => resolve({ retry: true }), CAPTURE_WORK_MS); }),
            ]);
            await this.updateCache(async () => {
                if (this.pending.get(job.tabId) !== job || !this.jobAllowed(job)) return false;
                if (denied) return this.forget(job.tabId);
                if (!isSmallJpeg(data)) return false;
                const visit = job.allowDisk && this.canCaptureVisit();
                const ref = await this.store.put(data, visit);
                if (!ref) return false;
                if (this.pending.get(job.tabId) !== job || !this.jobAllowed(job) || (visit && !this.canCaptureVisit())) {
                    this.retired.add(ref);
                    return;
                }
                const capturedAt = this.now();
                this.forget(job.tabId);
                this.previews.set(job.tabId, { ref, capturedAt, ...(visit ? { visit } : { expiresAt: capturedAt + PREVIEW_TTL_MS }) });
            });
            if (retry) return 'retry';
        } finally {
            clearTimeout(deadline);
            if (this.pending.get(job.tabId) === job) this.pending.delete(job.tabId);
        }
    }

    async get(tabIds) {
        await this.ready;
        if (!this.enabled || !this.permitted) return {};
        await this.cacheWork;
        // Existing cards can paint immediately, including during refresh of
        // another card. The picker listens for newly published references.
        const hasReadyCard = tabIds.some(id => this.recordAllowed(this.previews.get(id)));
        const work = hasReadyCard ? [] : tabIds.map(id => this.pending.get(id)?.preview).filter(Boolean);
        if (work.length) {
            let deadline;
            try {
                await Promise.race([
                    Promise.all(work),
                    new Promise(resolve => { deadline = setTimeout(resolve, PREVIEW_WAIT_MS); }),
                ]);
            } finally {
                clearTimeout(deadline);
            }
            await this.cacheWork;
        }
        if (!this.enabled || !this.permitted) return {};
        const ids = [...new Set(tabIds)].filter(id => this.previews.has(id)).slice(0, PREVIEW_LIMIT);
        const results = await Promise.all(ids.map(async id => {
            const record = this.previews.get(id);
            if (!this.recordAllowed(record)) return;
            const tab = await this.chrome.tabs.get(id).catch(() => null);
            const current = () => this.previews.get(id) === record && this.recordAllowed(record);
            if (!current() || tab?.id !== id || !eligiblePage(tab) || !this.allowsUrl(tab.url)) return;
            const data = await this.store.read(record.ref);
            if (!current()) return;
            if (isSmallJpeg(data)) return { id, record, data };
            await this.updateCache(() => this.previews.get(id) === record && this.forget(id));
        }));
        return Object.fromEntries(results.filter(result => result && this.previews.get(result.id) === result.record &&
            this.recordAllowed(result.record)).map(({ id, data }) => [id, data]));
    }
}
