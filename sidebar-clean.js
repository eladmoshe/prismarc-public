let openPreview;

document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !openPreview || openPreview.applying) return;
    event.preventDefault();
    openPreview.dismiss(true);
});

export function closeCleanPreview() {
    openPreview?.dismiss();
}

export function reconcileCleanPreview(spaceElement) {
    if (openPreview?.spaceElement === spaceElement) openPreview.reconcile();
}

export function removeCleanCandidate(tabId) {
    openPreview?.keepCandidates(candidate => candidate.id !== tabId);
}

export function setupCleanPreview(spaceElement, windowId) {
    new CleanPreview(spaceElement, windowId);
}

function tabCount(count) {
    return `${count} ${count === 1 ? 'tab' : 'tabs'}`;
}

function elapsedTime(milliseconds) {
    const minutes = Math.floor(milliseconds / 60_000);
    if (minutes < 1) return '';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours} hr ${minutes % 60} min` : `${hours} hr`;
    const days = Math.floor(hours / 24);
    const extraHours = hours % 24;
    const wholeDays = `${days} ${days === 1 ? 'day' : 'days'}`;
    return extraHours ? `${wholeDays} ${extraHours} hr` : wholeDays;
}

function selectionDescription(candidates, count, now) {
    if (!count) return 'None selected';
    if (count === candidates.length) return 'All eligible tabs';

    const cutoff = candidates[count - 1].lastViewed;
    if (!cutoff) return 'Includes unknown view times';

    const age = now - cutoff;
    const day = 24 * 60 * 60_000;
    if (age < 60 * 60_000) return 'Includes recent tabs';
    if (age >= 30 * day) return 'A month or older';
    if (age >= 7 * day) return 'A week or older';

    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    if (cutoff >= midnight.getTime()) return 'Earlier today or older';
    midnight.setDate(midnight.getDate() - 1);
    return cutoff >= midnight.getTime() ? 'Yesterday or older' : 'Before yesterday';
}

class CleanPreview {
    constructor(spaceElement, windowId) {
        this.spaceElement = spaceElement;
        this.windowId = windowId;
        this.spaceId = spaceElement.dataset.spaceId;
        this.trigger = spaceElement.querySelector('.clean-tabs-btn');
        this.panel = spaceElement.querySelector('.clean-panel');
        this.range = spaceElement.querySelector('.clean-range');
        this.cutoff = spaceElement.querySelector('.clean-cutoff');
        this.apply = spaceElement.querySelector('.clean-apply');
        this.cancel = spaceElement.querySelector('.clean-cancel');
        this.outcome = spaceElement.querySelector('.clean-outcome');
        this.tabList = spaceElement.querySelector('[data-tab-type="temporary"]');
        this.candidates = [];
        this.count = 0;
        this.generation = 0;
        this.panel.id = `clean-panel-${this.spaceId}`;
        this.range.id = `clean-range-${this.spaceId}`;
        this.trigger.setAttribute('aria-controls', this.panel.id);
        this.panel.querySelector('label').htmlFor = this.range.id;
        const description = this.panel.querySelector('.clean-range-description');
        description.id = `clean-range-description-${this.spaceId}`;
        this.range.setAttribute('aria-describedby', description.id);

        this.trigger.addEventListener('click', () => this.panel.hidden ? this.open() : this.dismiss(true));
        this.range.addEventListener('input', () => {
            this.count = Number(this.range.value);
            this.paint();
        });
        this.cancel.addEventListener('click', () => this.dismiss(true));
        this.apply.addEventListener('click', () => this.closeSelected());
    }

    request(action, details) {
        return chrome.runtime.sendMessage({ type: 'cleanTabs', action, spaceId: this.spaceId,
            windowId: this.windowId, ...details });
    }

    async open() {
        closeCleanPreview();
        openPreview = this;
        const generation = ++this.generation;
        this.now = Date.now();
        this.panel.hidden = false;
        this.trigger.setAttribute('aria-expanded', 'true');
        this.outcome.textContent = '';
        this.loading = true;
        this.paint();
        this.panel.focus();
        try {
            const result = await this.request('preview');
            if (generation !== this.generation) return;
            if (!result?.success) throw new Error('Preview unavailable');
            this.candidates = result.candidates;
        } catch {
            if (generation !== this.generation) return;
            this.outcome.textContent = 'Could not check temporary tabs.';
        } finally {
            if (generation === this.generation) {
                this.loading = false;
                this.reconcile(true);
                if (this.panel.ownerDocument.activeElement === this.panel) {
                    (this.range.disabled ? this.cancel : this.range).focus();
                }
            }
        }
    }

    keepCandidates(keep, initialize = false) {
        if (this.loading || this.applying) return;
        const survivingSelection = this.candidates.slice(0, this.count).filter(keep).length;
        this.candidates = this.candidates.filter(keep);
        this.count = initialize ? Math.ceil(this.candidates.length / 2) : survivingSelection;
        this.paint();
    }

    reconcile(initialize) {
        const rendered = new Set([...this.tabList.children].map(row => Number(row.dataset.tabId)));
        this.keepCandidates(candidate => rendered.has(candidate.id), initialize);
    }

    paint() {
        const candidates = new Map(this.candidates.map((candidate, index) => [candidate.id, { candidate, selected: index < this.count }]));
        for (const row of this.tabList.children) {
            const entry = candidates.get(Number(row.dataset.tabId));
            row.toggleAttribute('data-clean-selected', Boolean(entry?.selected));
            this.paintAge(row, entry);
        }

        const label = selectionDescription(this.candidates, this.count, this.now);
        this.cutoff.textContent = this.loading ? 'Checking tabs…' : this.candidates.length ? label : 'No eligible tabs';
        this.range.max = String(this.candidates.length);
        this.range.value = String(this.count);
        this.range.disabled = !this.candidates.length || this.applying;
        this.range.setAttribute('aria-valuetext', this.count
            ? `${label}. ${tabCount(this.count)} selected to close.`
            : 'No tabs selected to close');
        this.apply.textContent = this.applying ? `Closing ${tabCount(this.count)}…` : `Close ${tabCount(this.count)}`;
        this.apply.disabled = !this.count || this.applying;
        this.cancel.disabled = this.applying;
        this.trigger.disabled = this.applying;
    }

    paintAge(row, entry) {
        let age = row.querySelector('.clean-tab-age');
        if (!entry) {
            if (age) {
                const descriptions = (row.getAttribute('aria-describedby') || '').split(' ').filter(id => id && id !== age.id);
                if (descriptions.length) row.setAttribute('aria-describedby', descriptions.join(' '));
                else row.removeAttribute('aria-describedby');
                age.remove();
            }
            return;
        }
        if (!age) {
            age = row.ownerDocument.createElement('span');
            age.className = 'clean-tab-age';
            age.id = `clean-viewed-${entry.candidate.id}`;
            const descriptions = row.getAttribute('aria-describedby');
            row.setAttribute('aria-describedby', descriptions ? `${descriptions} ${age.id}` : age.id);
            const visible = row.ownerDocument.createElement('span');
            visible.setAttribute('aria-hidden', 'true');
            const spoken = row.ownerDocument.createElement('span');
            spoken.className = 'clean-sr-only';
            age.append(visible, spoken);
            row.querySelector('.tab-details')?.after(age);
        }
        const viewed = entry.candidate.lastViewed;
        const elapsed = viewed ? elapsedTime(this.now - viewed) : '';
        const label = elapsed ? `${elapsed} ago` : viewed ? 'Just now' : 'No view time';
        age.firstElementChild.textContent = label;
        age.lastElementChild.textContent = (viewed ? `Last viewed ${label.toLowerCase()}` : 'No recorded viewing time')
            + (entry.selected ? '. Selected to close.' : '');
    }

    dismiss(focus = false) {
        this.generation++;
        this.loading = this.applying = false;
        this.count = 0;
        this.candidates = [];
        this.panel.hidden = true;
        this.trigger.setAttribute('aria-expanded', 'false');
        this.paint();
        if (openPreview === this) openPreview = null;
        if (focus) this.trigger.focus();
    }

    async closeSelected() {
        if (!this.count || this.applying) return;
        const generation = this.generation;
        const selected = this.candidates.slice(0, this.count).map(({ id, url }) => ({ id, url }));
        this.applying = true;
        this.paint();
        let message;
        try {
            const result = await this.request('apply', { selected });
            if (!result?.success) throw new Error('Cleanup unavailable');
            message = result.remaining
                ? `Closed ${tabCount(result.closed)}. Skipped ${tabCount(result.remaining)}.`
                : `Closed ${tabCount(result.closed)}.`;
        } catch {
            message = 'Could not close the selected tabs.';
        }
        if (generation !== this.generation) return;
        this.dismiss(true);
        this.outcome.textContent = message;
    }
}
