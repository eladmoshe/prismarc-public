// A visual-only slot keeps source rows and their bookmark/folder identities in
// place until drop. No stored order is changed while the pointer is moving.
import { addDragListener } from './tab-pointer-drag.js';
export class TabDragPreview {
    constructor(document, onCancel = () => {}) {
        this.document = document;
        this.rows = [];
        this.animations = [];
        const cancel = event => {
            if (!this.rows.length || this.committing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            this.cancelled = true;
            this.clear();
            onCancel();
        };
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') cancel(event);
        }, true);
        document.addEventListener('mousedown', event => {
            if (event.button === 2 && this.rows.length && !this.committing) {
                this.suppressContextMenuUntil = Date.now() + 500;
                cancel(event);
            }
        }, true);
        document.addEventListener('contextmenu', event => {
            if (Date.now() < this.suppressContextMenuUntil) {
                this.suppressContextMenuUntil = 0;
                event.preventDefault();
                event.stopImmediatePropagation();
            } else cancel(event);
        }, true);
        addDragListener(document, 'dragover', event => {
            if (!this.rows.length) return;
            if (this.cancelled) {
                event.preventDefault();
                event.stopImmediatePropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
            } else if (!event.target.closest('[data-tab-type]')) this.clear();
        }, true);
        addDragListener(document, 'drop', event => {
            if (this.cancelled) {
                event.preventDefault();
                event.stopImmediatePropagation();
            } else if (this.slot?.isConnected) {
                const root = this.slot.closest('[data-tab-type]');
                const emptyTarget = root?.parentElement.querySelector(':scope > .placeholder-container');
                if (!root?.contains(event.target) && !emptyTarget?.contains(event.target)) this.clear();
            }
        }, true);
    }

    start(rows) {
        this.finish();
        this.rows = rows;
        this.cancelled = false;
        this.slot = this.document.createElement('div');
        this.slot.className = 'tab-drag-slot';
        this.slot.setAttribute('aria-hidden', 'true');
        this.slot.inert = true;
        for (const row of rows) {
            const copy = row.cloneNode(true);
            copy.className = 'tab-drag-preview-row';
            copy.style.height = `${row.getBoundingClientRect().height}px`;
            copy.style.boxSizing = 'border-box';
            for (const node of [copy, ...copy.querySelectorAll('*')]) {
                for (const attribute of [...node.attributes]) {
                    if (attribute.name === 'id' || attribute.name === 'draggable' ||
                        attribute.name === 'tabindex' || attribute.name.startsWith('data-')) {
                        node.removeAttribute(attribute.name);
                    }
                }
            }
            this.slot.appendChild(copy);
        }
    }

    move(container, y) {
        if (!this.rows.length || this.cancelled || this.committing || container.classList.contains('collapsed')) {
            this.clear();
            return false;
        }
        const rect = this.slot.getBoundingClientRect();
        if (this.slot.parentElement === container && y >= rect.top && y <= rect.bottom) return true;
        const candidates = [...container.children].filter(row =>
            row.matches('.tab, .folder') && !this.rows.includes(row));
        const before = candidates.find(row => {
            const box = row.getBoundingClientRect();
            return y < box.top + box.height / 2;
        }) || null;
        const parents = new Set([...this.rows.map(row => row.parentElement), this.slot.parentElement, container]);
        const positions = new Map([...parents].filter(Boolean).flatMap(parent => [...parent.children])
            .filter(row => row.matches('.tab, .folder') && !this.rows.includes(row))
            .map(row => [row, row.getBoundingClientRect().top]));
        this.stopAnimations();
        this.rows.forEach(row => row.classList.add('tab-drag-source'));
        container.insertBefore(this.slot, before);
        if (!this.document.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            for (const [row, top] of positions) {
                const delta = top - row.getBoundingClientRect().top;
                if (Math.abs(delta) > 0.5) this.animations.push(row.animate([
                    { transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }
                ], { duration: 140, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }));
            }
        }
        return true;
    }

    takeDrop(root) {
        if (this.cancelled || !this.slot?.isConnected || this.slot.closest('[data-tab-type]') !== root) {
            this.clear();
            return null;
        }
        let before = this.slot.nextElementSibling;
        while (before && this.rows.includes(before)) before = before.nextElementSibling;
        this.committing = true;
        return { container: this.slot.parentElement, before };
    }

    stopAnimations() {
        this.animations.forEach(animation => animation.cancel());
        this.animations = [];
    }

    clear() {
        this.stopAnimations();
        this.slot?.remove();
        this.rows.forEach(row => row.classList.remove('tab-drag-source'));
    }

    end() {
        // Native dragend can arrive while the asynchronous drop handler is
        // saving. Keep its visual slot until the real rows are ready to move.
        if (!this.committing) this.finish();
    }

    finish() {
        this.clear();
        this.rows = [];
        this.slot = null;
        this.committing = false;
        this.cancelled = false;
    }
}
