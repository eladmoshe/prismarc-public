// Keep the row in flow while its footprint shrinks, so surrounding tabs move
// continuously to their actual destinations (including nested folder layouts).
const closingRows = new WeakSet();

export function isTabClosing(row) {
    return closingRows.has(row) || row.classList.contains('tab-closing');
}

// Explicit close requests have already animated before Chrome emits onRemoved.
// External removals animate only the still-visible projection, never the tab.
export async function withRemovedTabMotion(row, reconcile, options) {
    if (!row || isTabClosing(row)) return reconcile();
    return withTabCloseMotion(row, reconcile, options);
}

export async function withTabCloseMotion(row, close, { collapse = true } = {}) {
    if (isTabClosing(row)) return;
    closingRows.add(row);
    let motion;
    try {
        motion = startRowExitMotion(row, 'tab-closing', { collapse });
        if (motion) await motion.finished;
        await close();
        // Retain the final frame until Chrome's removal listener removes or
        // replaces this row. Cancelling here can flash the old row back into view.
    } catch (error) {
        motion?.cancel();
        throw error;
    } finally {
        closingRows.delete(row);
    }
}

// Clip and shrink the row in place so adjacent rows follow its actual footprint.
export function startRowExitMotion(row, className, { collapse = true } = {}) {
    const view = row.ownerDocument.defaultView;
    if (view.matchMedia('(prefers-reduced-motion: reduce)').matches ||
        !row.getClientRects().length || typeof row.animate !== 'function') return null;

    const from = { opacity: 1, transform: 'translateX(0)' };
    const to = { opacity: 0, transform: 'translateX(6px)' };
    if (collapse) {
        const style = view.getComputedStyle(row);
        Object.assign(from, { height: style.height, paddingTop: style.paddingTop,
            paddingBottom: style.paddingBottom, marginBottom: style.marginBottom });
        Object.assign(to, { height: '0px', paddingTop: '0px',
            paddingBottom: '0px', marginBottom: '0px' });
    }
    let animation, timer;
    const cancel = () => {
        animation?.cancel();
        row.classList.remove(className);
    };
    try {
        animation = row.animate([from, to], { duration: 200,
            easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
        row.classList.add(className);
        // Hidden windows may stop painting before the final frame.
        const deadline = new Promise(resolve => { timer = setTimeout(resolve, 250); });
        const finished = Promise.race([animation.finished, deadline])
            .then(() => animation.finish()).catch(cancel).finally(() => clearTimeout(timer));
        return { finished, cancel };
    } catch {
        // An unavailable animation must not block reconciliation.
        cancel();
        return null;
    }
}
