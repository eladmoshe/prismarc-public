const key = 'zoomLaunchTabDeadlines';
const delay = 60_000;

export function isZoomLaunchUrl(value) {
    if (!value) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.port && !url.username && !url.password
            && (url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us'))
            && /^\/j\/[0-9]+\/?$/.test(url.pathname);
    } catch {
        return false;
    }
}

export function registerZoomLaunchTabs(api, onError, now = Date.now) {
    const deadlines = new Map();
    const checking = new Set();
    let pending = Promise.resolve();

    function enqueue(work) {
        pending = pending.then(work).catch(onError);
        return pending;
    }

    async function save() {
        if (deadlines.size) {
            await api.storage.session.set({ [key]: Object.fromEntries(deadlines) });
            const when = Math.min(...deadlines.values());
            // Recreating an unchanged alarm close to expiry can delay it again.
            const alarm = await api.alarms.get(key);
            if (alarm?.scheduledTime !== when) await api.alarms.create(key, { when });
        } else {
            await api.alarms.clear(key);
            await api.storage.session.remove(key);
        }
    }

    // Preserve deadlines across worker suspension. Reload or browser restart
    // clears session storage, so an already-open launcher gets a fresh minute.
    enqueue(async () => {
        const [stored, tabs] = await Promise.all([
            api.storage.session.get(key),
            api.tabs.query({ url: 'https://*.zoom.us/j/*' }),
        ]);
        for (const tab of tabs) {
            if (isZoomLaunchUrl(tab.url)) {
                const previous = stored[key]?.[tab.id];
                deadlines.set(tab.id, Number.isFinite(previous) ? previous : now() + delay);
            }
        }
        if (deadlines.size || stored[key]) await save();
    });

    function update(tabId, matches) {
        checking.delete(tabId);
        const deadline = now() + delay;
        return enqueue(async () => {
            if (matches) deadlines.set(tabId, deadline);
            else if (!deadlines.delete(tabId)) return;
            await save();
        });
    }

    api.tabs.onCreated.addListener(tab => {
        if (isZoomLaunchUrl(tab.url)) return update(tab.id, true);
    });
    api.tabs.onUpdated.addListener((id, change, tab) => {
        if (change.url !== undefined) return update(id, isZoomLaunchUrl(change.url));
        if (tab.pendingUrl) checking.delete(id);
    });
    api.tabs.onRemoved.addListener(id => update(id, false));
    api.tabs.onReplaced.addListener((added, removed) => {
        update(removed, false);
        return enqueue(async () => {
            const tab = await api.tabs.get(added).catch(() => null);
            if (tab && isZoomLaunchUrl(tab.url)) {
                deadlines.set(added, now() + delay);
                await save();
            }
        });
    });
    api.alarms.onAlarm.addListener(alarm => {
        if (alarm.name !== key) return;
        return enqueue(async () => {
            const due = [...deadlines].filter(([, deadline]) => deadline <= now());
            // Navigation can interrupt one check while a different tab is closing.
            for (const [id] of due) checking.add(id);
            for (const [id] of due) {
                if (!checking.has(id)) continue;
                const tab = await api.tabs.get(id).catch(() => null);
                if (!checking.delete(id)) continue;
                deadlines.delete(id);
                if (!tab || !isZoomLaunchUrl(tab.url)) continue;
                if (tab.pendingUrl) {
                    // A navigation can stall or abort. Never close it mid-flight.
                    deadlines.set(id, now() + delay);
                    continue;
                }
                await api.tabs.remove(id).catch(onError);
            }
            await save();
        });
    });
}
