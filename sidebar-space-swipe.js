import { paletteName } from './space-colors.js';
import { spaceInkTheme } from './domManager.js';

const INTENT_DISTANCE = 7;
const COMMIT_DISTANCE = 84;
const PREVIEW_DISTANCE = 132;
const GESTURE_END_DELAY = 135;
const SETTLE_DURATION = 110;
const PROGRESS = '--space-swipe-progress';

export function setupSpaceSwipe(sidebar, { getSpace, canSwipe, activate, onError }) {
    const staticTint = window.matchMedia('(prefers-reduced-motion: reduce), (forced-colors: active)');
    let gesture = null;
    let finishing = null;
    let endTimer;

    function clearPreview() {
        if (!sidebar.classList.contains('space-swipe-preview')) return;
        sidebar.classList.remove('space-swipe-preview');
        delete sidebar.dataset.swipeTarget;
        sidebar.dataset.spaceTheme = spaceInkTheme(sidebar.dataset.spaceColor);
        sidebar.style.removeProperty('--space-swipe-gradient');
        sidebar.style.removeProperty('--space-swipe-color');
        sidebar.style.removeProperty('--space-swipe-color-dark');
        sidebar.style.removeProperty(PROGRESS);
    }

    function renderPreview(sourceColor, target, progress) {
        if (staticTint.matches || !target || paletteName(sourceColor) === paletteName(target.color) || progress === 0) {
            clearPreview();
            return;
        }
        if (sidebar.dataset.swipeTarget !== target.color) {
            sidebar.dataset.swipeTarget = target.color;
            const color = paletteName(target.color);
            sidebar.style.setProperty('--space-swipe-gradient', `var(--space-${color}-gradient)`);
            sidebar.style.setProperty('--space-swipe-color', `var(--space-${color}-base)`);
            sidebar.style.setProperty('--space-swipe-color-dark', 'color-mix(in srgb, var(--space-swipe-color) 80%, black)');
        }
        sidebar.dataset.spaceTheme = spaceInkTheme(progress >= 0.5 ? target.color : sourceColor);
        sidebar.style.setProperty(PROGRESS, String(progress));
        sidebar.classList.add('space-swipe-preview');
    }

    function cancel() {
        if (gesture) gesture.axis = 'ignored';
        if (finishing) {
            finishing.cancelled = true;
            finishing.animation?.cancel();
        }
        clearPreview();
    }

    function waitForGestureEnd() {
        clearTimeout(endTimer);
        endTimer = setTimeout(finishGesture, GESTURE_END_DELAY);
    }

    async function finishGesture() {
        const ended = gesture;
        gesture = null;
        const active = getSpace(0);
        if (ended.axis !== 'horizontal' || !canSwipe() || active?.id !== ended.sourceId || active.color !== ended.sourceColor) {
            clearPreview();
            return;
        }
        const target = ended.target;
        const currentTarget = getSpace(Math.sign(ended.distance));
        const shouldCommit = target && Math.abs(ended.distance) >= COMMIT_DISTANCE &&
            target.id === currentTarget?.id && target.color === currentTarget.color;
        finishing = ended;
        try {
            if (!staticTint.matches && sidebar.classList.contains('space-swipe-preview')) {
                const progress = Math.abs(ended.distance) / PREVIEW_DISTANCE;
                const animation = sidebar.animate([
                    { [PROGRESS]: String(progress) },
                    { [PROGRESS]: shouldCommit ? '1' : '0' },
                ], { duration: SETTLE_DURATION, easing: 'ease-out', fill: 'forwards' });
                finishing.animation = animation;
                if (!shouldCommit && progress >= 0.5) {
                    // Bring the foreground back with the animated backdrop so a
                    // short dark-to-light swipe does not leave dark text on dark.
                    const syncReturningTheme = () => {
                        if (animation.playState !== 'running' || !sidebar.classList.contains('space-swipe-preview')) return;
                        if (Number(getComputedStyle(sidebar).getPropertyValue(PROGRESS)) < 0.5) {
                            sidebar.dataset.spaceTheme = spaceInkTheme(ended.sourceColor);
                        } else {
                            requestAnimationFrame(syncReturningTheme);
                        }
                    };
                    requestAnimationFrame(syncReturningTheme);
                }
                await animation.finished.catch(() => {});
                if (!finishing.cancelled && shouldCommit) renderPreview(ended.sourceColor, target, 1);
                animation.cancel();
            }
            if (shouldCommit && !finishing.cancelled && canSwipe() && getSpace(0)?.id === ended.sourceId &&
                getSpace(Math.sign(ended.distance))?.id === target.id) {
                await activate(target.id);
            }
        } catch (error) {
            onError(error);
        } finally {
            clearPreview();
            finishing = null;
        }
    }

    sidebar.addEventListener('wheel', event => {
        // Preserve native chip scrolling, editing, modifier-zoom, and modified wheel behavior.
        if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey ||
            event.target.closest?.('#spaceSwitcher, input:focus, textarea, select, [contenteditable], [role="menu"]')) return;
        const scaleX = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sidebar.clientWidth : 1;
        const scaleY = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? sidebar.clientHeight : 1;
        const x = event.deltaX * scaleX;
        const y = event.deltaY * scaleY;
        if (!x && !y) return;
        if (finishing) {
            if (Math.abs(x) > Math.abs(y)) event.preventDefault();
            return;
        }
        if (!canSwipe() || event.buttons) {
            gesture ??= { axis: 'ignored' };
            cancel();
            waitForGestureEnd();
            return;
        }
        if (!gesture) {
            const source = getSpace(0);
            if (!source || !getSpace(1)) return;
            gesture = { sourceId: source.id, sourceColor: source.color, distance: 0, horizontal: 0, vertical: 0 };
        }
        waitForGestureEnd();
        if (!gesture.axis) {
            gesture.horizontal += Math.abs(x);
            gesture.vertical += Math.abs(y);
            if (Math.max(gesture.horizontal, gesture.vertical) >= INTENT_DISTANCE) {
                gesture.axis = gesture.horizontal > gesture.vertical * 1.25 ? 'horizontal' : 'vertical';
            }
        }
        if (gesture.axis === 'vertical' || gesture.axis === 'ignored') return;
        gesture.distance = Math.min(PREVIEW_DISTANCE, Math.max(-PREVIEW_DISTANCE, gesture.distance + x));
        if (gesture.axis !== 'horizontal') return;
        event.preventDefault();
        const active = getSpace(0);
        if (active?.id !== gesture.sourceId || active.color !== gesture.sourceColor) {
            cancel();
            return;
        }
        const target = gesture.distance && getSpace(Math.sign(gesture.distance));
        gesture.target = target ? { id: target.id, color: target.color } : null;
        renderPreview(gesture.sourceColor, gesture.target, Math.abs(gesture.distance) / PREVIEW_DISTANCE);
    }, { passive: false });

    sidebar.addEventListener('pointerdown', cancel);
    sidebar.addEventListener('dragstart', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', event => {
        if (event.key === 'Escape') cancel();
    });
    staticTint.addEventListener('change', clearPreview);
    return { cancel };
}
