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
    const bytes = Uint8Array.from(atob(source.slice(JPEG.length)), char => char.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    try {
        const scale = Math.min(1, 384 / bitmap.width, 240 / bitmap.height);
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
            Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext('2d', { alpha: false }).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: .7 });
        if (blob.type !== 'image/jpeg' || blob.size > JPEG_BYTE_LIMIT) return null;
        return JPEG + btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
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
    if (message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) return { quota: true };
    if (/^Failed to capture tab: (image readback failed|encoding failed|view is invisible)$/.test(message)) return {};
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
            else if (visit || preview) this.queueCurrentVisit();
        });
        this.ready = Promise.resolve().then(() => this.chrome.storage.local.get([
            TAB_SWITCHER_PAGE_PREVIEWS, TAB_SWITCHER_CAPTURE_ON_VISIT, TAB_SWITCHER_EXCLUDED_DOMAINS,
        ])).then(settings => {
            if (domainRevision === this.domainRevision) this.excludedDomains = settings[TAB_SWITCHER_EXCLUDED_DOMAINS] ?? [];
            if (revision === this.revision) this.enabled = settings[TAB_SWITCHER_PAGE_PREVIEWS] !== false;
            if (visitRevision === this.visitRevision) this.captureOnVisit = settings[TAB_SWITCHER_CAPTURE_ON_VISIT] === true;
        }).catch(() => {});
        this.refreshVisitPermission();
        // MV3 can suspend the worker between shortcuts. Only the reduced
        // preview is restored from Chrome's trusted, volatile session store.
        this.cacheWork = this.restoreCache().catch(() => {});
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

    queueCurrentVisit() {
        Promise.all([this.ready, this.permissionReady]).then(async () => {
            if (!this.canCaptureVisit()) return;
            const window = await this.chrome.windows.getLastFocused({ windowTypes: ['normal'] });
            if (Number.isInteger(window?.id) && window.id >= 0) this.queueVisit(window.id);
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
        if (version !== this.visitVersion || !validSource(tab) || !this.canCaptureVisit()) return;
        const previous = this.previews.get(tab.id);
        if (previous && previous.expiresAt - PREVIEW_TTL_MS > this.now() - VISIT_REPEAT_MS) return;
        const delay = this.captureDelay();
        if (delay > 0) {
            this.waitForVisit(windowId, tab.id, version, delay, mayRetry);
            return;
        }
        const job = await this.capture(tab, true);
        const retry = (job?.preview && await job.preview) === 'quota';
        if (retry && mayRetry && version === this.visitVersion && this.canCaptureVisit()) {
            this.waitForVisit(windowId, tab.id, version, CAPTURE_WINDOW_MS, false);
        }
    }

    captureDelay() {
        const now = this.now();
        this.captureTimes = this.captureTimes.filter(time => now - time < CAPTURE_WINDOW_MS);
        return this.captureTimes.length >= CAPTURE_LIMIT ? this.captureTimes[0] + CAPTURE_WINDOW_MS - now : 0;
    }

    async restoreCache() {
        await Promise.all([this.ready, this.permissionReady]);
        const stored = await this.chrome.storage.session.get(TAB_SWITCHER_PREVIEW_CACHE);
        const records = stored[TAB_SWITCHER_PREVIEW_CACHE];
        if (!records) return;
        if (this.enabled && this.permitted) {
            const now = this.now();
            for (const [key, record] of Object.entries(records)) {
                const id = Number(key);
                if (Number.isInteger(id) && id >= 0 && String(id) === key && record?.expiresAt > now &&
                    record.expiresAt <= now + PREVIEW_TTL_MS && isSmallJpeg(record.data) &&
                    (record.visit !== true || this.canCaptureVisit())) {
                    this.previews.set(id, { data: record.data, expiresAt: record.expiresAt, ...(record.visit === true && { visit: true }) });
                }
            }
        }
        await this.persistCache();
    }

    updateCache(update) {
        const operation = this.cacheWork.then(async () => {
            if (update() === false) return;
            await this.persistCache();
        });
        this.cacheWork = operation.catch(() => {});
        return this.cacheWork;
    }

    clear() {
        this.stopQueuedVisit();
        if (this.checking) this.checking.invalid = true;
        this.pending.clear();
        this.previews.clear();
        this.updateCache(() => this.previews.clear());
    }

    invalidate(tabId) {
        if (this.checking?.tabId === tabId) this.checking.invalid = true;
        this.pending.delete(tabId);
        const removed = this.previews.delete(tabId);
        this.updateCache(() => this.previews.delete(tabId) || removed);
    }

    async persistCache() {
        if (!this.enabled || !this.permitted) this.previews.clear();
        const now = this.now();
        for (const [id, preview] of this.previews) {
            if (preview.expiresAt <= now) this.previews.delete(id);
        }
        const newest = [...this.previews].sort((left, right) => right[1].expiresAt - left[1].expiresAt);
        for (const [id] of newest.slice(PREVIEW_LIMIT)) this.previews.delete(id);

        if (this.previews.size) {
            const when = Math.min(...[...this.previews.values()].map(preview => preview.expiresAt));
            await this.chrome.storage.session.set({ [TAB_SWITCHER_PREVIEW_CACHE]: Object.fromEntries(this.previews) });
            await this.chrome.alarms?.create?.(PREVIEW_EXPIRY_ALARM, { when });
        } else {
            await this.chrome.storage.session.remove(TAB_SWITCHER_PREVIEW_CACHE);
            await this.chrome.alarms?.clear?.(PREVIEW_EXPIRY_ALARM);
        }
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
                return { data: await this.resize(result.raw) };
            });
            const { data, denied, quota } = await Promise.race([
                encoded.catch(() => ({})),
                new Promise(resolve => { deadline = setTimeout(() => resolve({}), CAPTURE_WORK_MS); }),
            ]);
            await this.updateCache(() => {
                if (this.pending.get(job.tabId) !== job || !this.jobAllowed(job)) return false;
                if (denied) return this.previews.delete(job.tabId);
                if (!isSmallJpeg(data)) return false;
                this.previews.set(job.tabId, { data, expiresAt: this.now() + PREVIEW_TTL_MS, ...(job.visit && { visit: true }) });
            });
            if (quota) return 'quota';
        } finally {
            clearTimeout(deadline);
            if (this.pending.get(job.tabId) === job) this.pending.delete(job.tabId);
        }
    }

    async get(tabIds) {
        await this.ready;
        if (!this.enabled || !this.permitted) return {};
        const work = tabIds.map(id => this.pending.get(id)?.preview).filter(Boolean);
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
        }
        await this.cacheWork;
        if (!this.enabled || !this.permitted) return {};
        const records = tabIds.filter(id => this.previews.has(id)).map(id => [id, this.previews.get(id)]);
        const tabs = await Promise.all(records.map(([id]) => this.chrome.tabs.get(id).catch(() => null)));
        return Object.fromEntries(records
            .filter(([id, record], index) => this.enabled && this.permitted && this.previews.get(id) === record &&
                record.expiresAt > this.now() && (record.visit !== true || this.canCaptureVisit()) &&
                tabs[index]?.id === id && eligiblePage(tabs[index]) && this.allowsUrl(tabs[index].url))
            .map(([id, record]) => [id, record.data]));
    }
}
