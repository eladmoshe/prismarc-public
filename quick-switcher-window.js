// Find our popup by its packaged page so service-worker restarts cannot duplicate it.
let pending = Promise.resolve();

export function toggleQuickSwitcher(chromeApi = globalThis.chrome, sourceWindowId) {
    const operation = pending.then(async () => {
        const page = chromeApi.runtime.getURL('quick-switcher.html');
        let source;
        if (Number.isInteger(sourceWindowId) && sourceWindowId >= 0) {
            try { source = await chromeApi.windows.get(sourceWindowId); } catch { /* Window closed before invocation. */ }
        }
        source ||= await chromeApi.windows.getLastFocused();
        const popups = await chromeApi.windows.getAll({ windowTypes: ['popup'], populate: true });
        const existing = popups.find(window => Boolean(window.incognito) === Boolean(source.incognito) &&
            window.tabs?.some(tab => tab.url === page || tab.url?.startsWith(`${page}?`)));

        if (existing?.id === source.id) {
            await chromeApi.windows.remove(existing.id);
            return;
        }

        const url = `${page}?windowId=${source.id}`;
        if (existing) {
            const tab = existing.tabs.find(tab => tab.url === page || tab.url?.startsWith(`${page}?`));
            // Reopening from another window refreshes the results and destination.
            await chromeApi.tabs.update(tab.id, { url });
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
        try {
            await open(bounds);
        } catch (error) {
            // A moved/disconnected display (or a virtual test screen) can leave
            // the source window outside visible bounds. Let Chrome place it.
            if (!/bounds.*visible screen space/i.test(error.message)) throw error;
            await open({ width, height, focused: true });
        }
    });
    // A dismissed window or failed API call must not poison the next shortcut.
    pending = operation.catch(() => {});
    return operation;
}
