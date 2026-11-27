const PAGE = 'capture-unavailable.html';
const WIDTH = 360;
const HEIGHT = 236;
let pending = Promise.resolve();

export function showCaptureUnavailable(chrome, reason, tab, isCurrentAttempt, getAppearance) {
    // Native windows survive the worker. Find and reuse a live notice, and
    // serialize attempts so rapid shortcuts cannot create a second window.
    const result = pending.then(async () => {
        if (!isCurrentAttempt()) return;
        const page = chrome.runtime.getURL(PAGE);
        const isNotice = url => url === page || url?.startsWith(`${page}#`);
        if (isNotice(tab?.url)) return;
        const [popups, theme] = await Promise.all([
            chrome.windows.getAll({ windowTypes: ['popup'], populate: true }),
            getAppearance(tab?.windowId, tab?.id).catch(() => 'dark'),
        ]);
        // After a prompt or startup failure, the original tab can still exist
        // without being the page where the user is working now.
        const source = await (Number.isInteger(tab?.windowId) && tab.windowId >= 0
            ? chrome.windows.get(tab.windowId, { populate: true })
            : chrome.windows.getLastFocused({ populate: true }));
        const activeTab = source.tabs?.find(candidate => candidate.active);
        if (!isCurrentAttempt() || source.focused === false ||
            (Number.isInteger(tab?.id) && (activeTab?.id !== tab.id || activeTab?.url !== tab.url))) return;

        const incognito = Boolean(source.incognito);
        const notice = popups.filter(window => Boolean(window.incognito) === incognito)
            .flatMap(window => window.tabs ?? [])
            .find(tab => isNotice(tab.url) || isNotice(tab.pendingUrl));
        // With no supplied command tab, avoid rewriting a notice already focused.
        if (notice?.windowId === source.id) return;

        const url = `${page}#${reason}${theme === 'light' ? '-light' : ''}`;
        const width = Math.min(WIDTH, source.width ?? WIDTH);
        const height = Math.min(HEIGHT, source.height ?? HEIGHT);
        const size = { width, height, focused: true };
        const bounds = {
            ...size,
            left: (source.left ?? 0) + Math.round(((source.width ?? width) - width) / 2),
            top: (source.top ?? 0) + Math.round(((source.height ?? height) - height) / 2),
        };
        if (notice && (notice.pendingUrl ?? notice.url) !== url) await chrome.tabs.update(notice.id, { url });
        const open = options => notice
            ? chrome.windows.update(notice.windowId, options)
            : chrome.windows.create({ url, type: 'popup', incognito, ...options });
        if (!isCurrentAttempt()) return;
        try {
            await open(bounds);
        } catch (error) {
            if (!/bounds.*visible screen space/i.test(error.message) || !isCurrentAttempt()) throw error;
            await open(size);
        }
    });
    pending = result.catch(() => {});
    return result;
}
