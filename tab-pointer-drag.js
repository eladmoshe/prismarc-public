// Track tab drags inside the sidebar so Escape/right-click remain ordinary DOM
// events. Chrome's native OS drag loop otherwise consumes those cancel inputs.
export function addDragListener(element, type, listener, options) {
    element.addEventListener(type, listener, options);
    element.addEventListener(`arcify:${type}`, listener, options);
}

export function dispatchPointerDrag(element, type, fields = {}) {
    const event = new Event(`arcify:${type}`, { bubbles: true, cancelable: true });
    Object.assign(event, fields);
    element.dispatchEvent(event);
    return event;
}

export class TabPointerDrag {
    constructor(document, preview) {
        this.document = document;
        this.preview = preview;
        document.addEventListener('mousedown', event => {
            // A fresh click is independent of the click suppressed after a
            // completed/cancelled drag, including clicks on non-tab controls.
            if (event.button === 0) this.suppressClick = false;
            if (event.button === 2 && this.session && !this.session.started) this.cancel();
        }, true);
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape' && this.session && !this.session.started) this.cancel();
        }, true);
        document.addEventListener('mousemove', event => this.move(event), true);
        document.addEventListener('mouseup', event => {
            if (event.button !== 0 || !this.session) return;
            const { row, started, transfer } = this.session;
            if (!row.isConnected) { this.cancel(); return; }
            if (started) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const target = this.hover(event.clientX, event.clientY);
                if (target) dispatchPointerDrag(target, 'drop', { dataTransfer: transfer, clientX: event.clientX, clientY: event.clientY });
                this.suppressClick = true;
            }
            this.reset();
            if (started) dispatchPointerDrag(row, 'dragend', { dataTransfer: transfer });
        }, true);
        document.addEventListener('click', event => {
            if (!this.suppressClick) return;
            this.suppressClick = false;
            event.preventDefault();
            event.stopImmediatePropagation();
        }, true);
        document.defaultView.addEventListener('blur', () => this.cancel());
    }

    prepare(event, row) {
        if (event.button !== 0 || !row.draggable || event.target.closest('button, input, .tab-close, .tab-remove, .pinned-back')) return;
        this.cancel();
        this.suppressClick = false;
        const rect = row.getBoundingClientRect();
        this.session = { row, draggable: row.draggable,
            section: row.closest('[data-tab-type]'), folderId: row.closest('.folder')?.dataset.bookmarkId,
            startX: event.clientX, startY: event.clientY,
            offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width };
        row.draggable = false;
    }

    move(event) {
        const s = this.session;
        if (!s) return;
        if (!(event.buttons & 1)) { this.cancel(); return; }
        if (!s.row.isConnected) {
            // A refresh can rebuild the pressed row before the first drag movement.
            // Only resume from the same item under the press point in the same section and folder.
            const row = this.document.elementFromPoint(s.startX, s.startY)?.closest('.tab');
            const sameItem = row?.draggable && (row.dataset.tabId || row.dataset.bookmarkId) &&
                row.dataset.tabId === s.row.dataset.tabId && row.dataset.bookmarkId === s.row.dataset.bookmarkId;
            if (s.started || !sameItem || !s.section || row.closest('[data-tab-type]') !== s.section ||
                row.closest('.folder')?.dataset.bookmarkId !== s.folderId) {
                this.cancel();
                return;
            }
            s.row.draggable = s.draggable;
            s.row = row;
            row.draggable = false;
        }
        if (!s.started && Math.hypot(event.clientX - s.startX, event.clientY - s.startY) < 5) return;
        event.preventDefault();
        if (!s.started) {
            const data = new Map();
            s.transfer = { dropEffect: 'move', effectAllowed: 'move',
                setData: (type, value) => data.set(type, value), getData: type => data.get(type) || '' };
            s.started = true;
            if (dispatchPointerDrag(s.row, 'dragstart', { dataTransfer: s.transfer }).defaultPrevented) {
                this.suppressClick = true;
                this.reset();
                return;
            }
            this.document.getSelection()?.removeAllRanges();
            this.ghost = this.preview.slot.cloneNode(true);
            this.ghost.className = 'tab-drag-ghost';
            this.ghost.style.width = `${s.width}px`;
            const style = this.document.defaultView.getComputedStyle(s.row);
            this.ghost.style.setProperty('--space-bg-color', style.getPropertyValue('--space-bg-color'));
            this.ghost.style.setProperty('--drag-ghost-row-fill', style.backgroundColor);
            this.ghost.style.color = style.color;
            this.document.body.appendChild(this.ghost);
            this.document.body.classList.add('tab-pointer-dragging');
        }
        this.x = event.clientX;
        this.y = event.clientY;
        this.ghost.style.left = `${event.clientX - s.offsetX}px`;
        this.ghost.style.top = `${event.clientY - s.offsetY}px`;
        this.hover(this.x, this.y);
        if (!this.scrollFrame) this.scrollFrame = this.document.defaultView.requestAnimationFrame(() => this.scroll());
    }

    hover(x, y) {
        const target = this.document.elementFromPoint(x, y);
        if (!this.session) return null;
        if (this.lastTarget && this.lastTarget !== target) dispatchPointerDrag(this.lastTarget, 'dragleave', {
            relatedTarget: target, dataTransfer: this.session.transfer });
        this.lastTarget = target;
        if (!target) return null;
        this.session.transfer.dropEffect = 'move';
        const over = dispatchPointerDrag(target, 'dragover', {
            dataTransfer: this.session.transfer, clientX: x, clientY: y });
        return this.session && over.defaultPrevented && this.session.transfer.dropEffect !== 'none' ? target : null;
    }

    scroll() {
        this.scrollFrame = null;
        if (!this.session?.started) return;
        let target = this.document.elementFromPoint(this.x, this.y);
        while (target && (target.scrollHeight <= target.clientHeight + 1 ||
            !/(auto|scroll)/.test(this.document.defaultView.getComputedStyle(target).overflowY))) {
            target = target.parentElement;
        }
        if (target) {
            const box = target.getBoundingClientRect();
            const delta = this.y < box.top + 32 ? -8 : this.y > box.bottom - 32 ? 8 : 0;
            if (delta) { target.scrollTop += delta; this.hover(this.x, this.y); }
        }
        this.scrollFrame = this.document.defaultView.requestAnimationFrame(() => this.scroll());
    }

    reset() {
        if (this.session) this.session.row.draggable = this.session.draggable;
        this.session = null;
        this.ghost?.remove();
        this.ghost = null;
        this.lastTarget = null;
        this.document.body.classList.remove('tab-pointer-dragging');
        this.document.defaultView.cancelAnimationFrame(this.scrollFrame);
        this.scrollFrame = null;
    }

    cancel() {
        const session = this.session;
        this.reset();
        if (session?.started) {
            this.suppressClick = true;
            dispatchPointerDrag(session.row, 'dragend', { dataTransfer: session.transfer });
        }
    }
}
