import { Logger } from './logger.js';
import { MAX_FAVORITES, NativeFavorites } from './native-favorites.js';

const MEMBERSHIP_KEY = 'spaceFavorites';
const PRIVATE_MEMBERSHIP_KEY = 'privateSpaceFavorites';
const contains = (members, favoriteId) => [...members.values()].some(ids => ids.includes(favoriteId));
const removeId = (members, favoriteId) => new Map([...members].map(([spaceId, ids]) =>
    [spaceId, ids.filter(id => id !== favoriteId)]));
const full = () => new Error(`Favorites is full. You can add up to ${MAX_FAVORITES} to this Space. Remove a Favorite to make room.`);

function addIds(members, spaceId, ids) {
    return new Map(members).set(spaceId, [...new Set([...(members.get(spaceId) || []), ...ids])]);
}

// Space order is independent of Chrome's pin order. Native records still own
// the live tab, saved address, and window restoration for each identity.
export class SpaceFavorites {
    constructor(readContext) {
        this.readContext = readContext;
        this.native = new NativeFavorites();
        this.privateMembers = new Map();
    }

    async save(members, isPrivate = false) {
        if (isPrivate) {
            await chrome.storage.session.set({ [PRIVATE_MEMBERSHIP_KEY]: Object.fromEntries(members) });
            this.privateMembers = members;
        } else {
            await this.native.persistLocal({ [MEMBERSHIP_KEY]: Object.fromEntries(members) });
            this.members = members;
        }
    }

    async prepare(context) {
        if (this.members) return;
        const [data, session] = await Promise.all([
            chrome.storage.local.get(MEMBERSHIP_KEY),
            chrome.storage.session.get(PRIVATE_MEMBERSHIP_KEY)
        ]);
        const privateIds = new Set([...this.native.records.values()].filter(item => !item.group).map(item => item.favoriteId));
        const savedPrivate = Object.entries(session[PRIVATE_MEMBERSHIP_KEY] || {});
        this.privateMembers = new Map(savedPrivate.map(([spaceId, ids]) => [spaceId, ids.filter(id => privateIds.has(id))])
            .filter(([, ids]) => ids.length));
        if (savedPrivate.some(([spaceId, ids]) => this.privateMembers.get(spaceId)?.length !== ids.length)) {
            await this.save(this.privateMembers, true);
        }
        if (data[MEMBERSHIP_KEY]) {
            this.members = new Map(Object.entries(data[MEMBERSHIP_KEY]));
            return;
        }
        const records = [...this.native.records.values(), ...this.native.closed.values(), ...this.native.restoreQueue];
        const ids = [...new Set(records.filter(item => item.group && item.favoriteId)
            .sort((a, b) => a.index - b.index).map(item => item.favoriteId))];
        // Use the Space model's startup snapshot even if the first sidebar
        // request arrives after another panel has created a new Space.
        const members = new Map(context.initialSpaceIds.filter(id => context.spaceIds.includes(id))
            .map(id => [id, ids]));
        await this.save(members);
    }

    membershipFor(item) {
        return item.group ? this.members : this.privateMembers;
    }

    async prune(context) {
        await this.prepare(context);
        for (const [members, isPrivate] of [[this.members, false], [this.privateMembers, true]]) {
            if ([...members.keys()].every(id => context.spaceIds.includes(id))) continue;
            const kept = new Map([...members].filter(([id]) => context.spaceIds.includes(id)));
            const orphaned = new Set([...members.values()].flat().filter(id => !contains(kept, id)));
            try {
                for (const id of orphaned) await this.native.release(id);
                await this.save(kept, isPrivate);
            } catch (error) {
                // Keep the removed membership until cleanup succeeds so a
                // failed native unpin cannot add the tile to another Space.
                Logger.warn('Could not release a Favorite from a deleted Space:', error);
            }
        }
    }

    async importNativePin(windowId, item) {
        if (this.members && contains(this.membershipFor(item), item.favoriteId)) return;
        const context = await this.readContext(windowId);
        await this.prepare(context);
        const members = this.membershipFor(item);
        if (context.activeSpaceId && !contains(members, item.favoriteId)) {
            await this.save(addIds(members, context.activeSpaceId, [item.favoriteId]), !item.group);
        }
    }

    install() {
        this.native.install({
            onPinned: (windowId, item) => this.importNativePin(windowId, item),
            onLegacyClosed: async (windowId, item) => {
                const context = await this.readContext(windowId);
                await this.prepare(context);
                let members = this.members;
                for (const id of context.initialSpaceIds.filter(id => context.spaceIds.includes(id))) {
                    members = addIds(members, id, [item.favoriteId]);
                }
                if (members !== this.members) await this.save(members);
            },
            onUnpinned: async (id, isPrivate) => {
                if (!this.members) await this.prepare(await this.readContext());
                const members = isPrivate ? this.privateMembers : this.members;
                if (contains(members, id)) await this.save(removeId(members, id), isPrivate);
            }
        });
        chrome.storage.onChanged?.addListener((changes, area) => {
            const change = changes.spaces;
            if (area !== 'local' || !change?.oldValue?.some(space =>
                !change.newValue?.some(current => current.id === space.id))) return;
            this.native.run(async () => this.prune(await this.readContext())).catch(Logger.error);
        });
        this.native.run(async () => this.prepare(await this.readContext())).catch(Logger.error);
    }

    async reconcileLivePins(context, items) {
        if (!context.activeSpaceId) return;
        for (const [members, isPrivate] of [[this.members, false], [this.privateMembers, true]]) {
            const ids = items.filter(item => !item.closed && Boolean(item.group) !== isPrivate && !contains(members, item.favoriteId))
                .map(item => item.favoriteId);
            if (ids.length) await this.save(addIds(members, context.activeSpaceId, ids), isPrivate);
        }
    }

    list(spaceId, items) {
        const byId = new Map(items.map(item => [item.favoriteId, item]));
        return [...(this.members.get(spaceId) || []), ...(this.privateMembers.get(spaceId) || [])]
            .map(id => byId.get(id)).filter(Boolean);
    }

    async pin(tabIds, spaceId, windowId, items) {
        if (!Array.isArray(tabIds) || !tabIds.length || !tabIds.every(id => Number.isInteger(id) && id > 0)) {
            throw new Error('Choose tabs to add to Favorites.');
        }
        const selected = await Promise.all([...new Set(tabIds)].map(id => chrome.tabs.get(id)));
        if (selected.some(tab => tab.windowId !== windowId)) throw new Error('Choose tabs in this window.');
        const additions = selected.filter(tab => !items.some(item => item.id === tab.id)).length;
        if (additions && items.length + additions > MAX_FAVORITES) throw full();
        if (!additions) return;
        const isPrivate = Boolean(selected[0].incognito);
        const members = isPrivate ? this.privateMembers : this.members;
        try {
            await this.native.pin(tabIds, Infinity);
        } finally {
            // A batch can partially succeed if a tab goes away mid-update.
            const added = selected.map(tab => this.native.records.get(tab.id)?.favoriteId).filter(Boolean);
            if (added.length) await this.save(addIds(members, spaceId, added), isPrivate);
        }
    }

    async reorder(spaceId, windowId, ids, items, allItems) {
        if (!Array.isArray(ids) || ids.length !== items.length || new Set(ids).size !== items.length ||
            !items.every(item => ids.includes(item.favoriteId))) throw new Error('Favorites changed. Try moving it again.');
        if (items.every((item, index) => item.favoriteId === ids[index])) return;
        const members = this.membershipFor(items[0]);
        const byOrder = ids.values();
        const nativeOrder = ids.values();
        await this.native.changeFavorite({ action: 'reorder', windowId, favoriteIds: allItems.map(({ favoriteId }) =>
            ids.includes(favoriteId) ? nativeOrder.next().value : favoriteId) });
        const order = members.get(spaceId).map(id => ids.includes(id) ? byOrder.next().value : id);
        await this.save(new Map(members).set(spaceId, order), !items[0].group);
    }

    async change(message, spaceId, windowId, item, otherItems) {
        const { action, targetSpaceId } = message;
        const { favoriteId, group } = item;
        const members = this.membershipFor(item);
        if (action === 'copy' || action === 'move') {
            if (spaceId === targetSpaceId) return;
            const alreadyThere = (members.get(targetSpaceId) || []).includes(favoriteId);
            if (action === 'copy' && (alreadyThere || otherItems.some(tab => tab.baseUrl === item.baseUrl))) return;
            if (action === 'move' && alreadyThere) {
                await this.save(new Map(members).set(spaceId, members.get(spaceId).filter(id => id !== favoriteId)), !group);
                return;
            }
            if (otherItems.length >= MAX_FAVORITES) throw full();
            if (action === 'copy') {
                if (!group) throw new Error('Favorites in private windows can only stay open in this window.');
                const id = crypto.randomUUID();
                const index = (await this.native.list(windowId)).length;
                this.native.closed.set(id, { favoriteId: id, tabId: null, index, group, baseUrl: item.baseUrl,
                    url: item.baseUrl, title: item.title, closed: true });
                try { await this.save(addIds(members, targetSpaceId, [id])); }
                catch (error) { this.native.closed.delete(id); throw error; }
            } else {
                const remaining = new Map(members).set(spaceId, members.get(spaceId).filter(id => id !== favoriteId));
                await this.save(addIds(remaining, targetSpaceId, [favoriteId]), !group);
            }
        } else if (action === 'remove') {
            const remaining = new Map(members).set(spaceId, members.get(spaceId).filter(id => id !== favoriteId));
            const shared = contains(remaining, favoriteId);
            if (!shared || message.releaseTab === true) await this.native.release(favoriteId, shared);
            await this.save(remaining, !group);
        } else if (action === 'open' || (action === 'reset' && item.closed)) {
            await this.native.changeFavorite({ action: 'open', windowId, favoriteId });
        } else if (action === 'reset') {
            await chrome.tabs.update(item.id, { url: item.baseUrl, active: true });
        } else if (action === 'close' || action === 'toggleMute') {
            if (item.closed || item.id !== message.tabId) throw new Error('This Favorite changed. Try again.');
            const tab = await chrome.tabs.get(item.id);
            if (!tab.pinned || tab.windowId !== windowId) throw new Error('This Favorite changed. Try again.');
            if (action === 'close') {
                await chrome.tabs.remove(tab.id);
                if (group) this.native.rememberClosed(this.native.records.get(tab.id));
                else {
                    this.native.detach(tab.id);
                    await this.save(removeId(members, favoriteId), true);
                }
            } else if (tab.audible || tab.mutedInfo?.muted) {
                await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted });
            }
        } else {
            throw new Error('Unknown Favorites action.');
        }
    }

    dispatch(message) {
        return this.native.run(async () => {
            const { action, targetSpaceId } = message;
            let { windowId, spaceId } = message;
            if (!Number.isInteger(windowId) && action === 'pin' && Number.isInteger(message.tabIds?.[0])) {
                windowId = (await chrome.tabs.get(message.tabIds[0])).windowId;
            }
            if (!Number.isInteger(windowId)) windowId =
                (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id;
            const context = await this.readContext(windowId);
            await this.prune(context);
            spaceId ??= context.activeSpaceId;
            if (!context.spaceIds.includes(spaceId) ||
                (['copy', 'move'].includes(action) && !context.spaceIds.includes(targetSpaceId))) {
                throw new Error('This Space is no longer available.');
            }
            const allItems = await this.native.list(windowId);
            try {
                if (action === 'get' || action === 'owner') await this.reconcileLivePins(context, allItems);
                const items = this.list(spaceId, allItems);
                if (action === 'get') return items;
                if (action === 'owner') {
                    const item = allItems.find(tab => tab.id === message.tabId);
                    if (!item) return [];
                    const members = this.membershipFor(item);
                    const owner = [spaceId, ...context.spaceIds].find(id => members.get(id)?.includes(item.favoriteId));
                    return owner ? [{ spaceId: owner }] : [];
                }
                if (action === 'pin') await this.pin(message.tabIds, spaceId, windowId, items);
                else if (action === 'reorder') await this.reorder(spaceId, windowId, message.favoriteIds, items, allItems);
                else {
                    const item = items.find(tab => message.favoriteId ? tab.favoriteId === message.favoriteId : tab.id === message.tabId);
                    if (!item) throw new Error('This Favorite is no longer in this Space.');
                    await this.change(message, spaceId, windowId, item, this.list(targetSpaceId, allItems));
                }
                return this.list(spaceId, await this.native.list(windowId));
            } finally {
                await this.native.persist();
            }
        });
    }
}
