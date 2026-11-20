// These measurements match the strip, row and footer rules in tab-switcher.css.
const CARD_WIDTH = 192;
const MIN_CARD_WIDTH = 128;
const ART_RATIO = 1.6;
const STRIP_GAP = 12;
const LIST_GAP = 4;
const LIST_WIDTH = 460;
const ROW_HEIGHT = 44;
const MIN_ROW_HEIGHT = 24;
const MARGIN = 24;
const STRIP_PADDING = 40;
const LIST_PADDING = 20;
const CAPTION_HEIGHT = 40;
const FOOTER_HEIGHT = 48;

export function recentTabsLayout(count, viewportWidth, viewportHeight) {
    const columns = Math.max(1, count);
    const availableWidth = viewportWidth - MARGIN;
    const horizontalSpace = STRIP_PADDING + (columns - 1) * STRIP_GAP;
    const verticalSpace = MARGIN + STRIP_PADDING + CAPTION_HEIGHT + FOOTER_HEIGHT;
    const cardWidth = Math.floor(Math.min(CARD_WIDTH, (availableWidth - horizontalSpace) / columns,
        (viewportHeight - verticalSpace) * ART_RATIO));
    if (cardWidth >= MIN_CARD_WIDTH) {
        return {
            mode: 'strip', width: cardWidth * columns + horizontalSpace,
            height: Math.ceil(cardWidth / ART_RATIO) + verticalSpace,
        };
    }

    const listSpace = MARGIN + LIST_PADDING + FOOTER_HEIGHT + (columns - 1) * LIST_GAP;
    const rowHeight = Math.max(MIN_ROW_HEIGHT, Math.min(ROW_HEIGHT, Math.floor((viewportHeight - listSpace) / columns)));
    return { mode: 'list', width: Math.max(0, Math.min(LIST_WIDTH, availableWidth)),
        height: columns * rowHeight + listSpace, rowHeight };
}

export function recentTabsPopupSize(count, source) {
    // The popup's outer bounds include browser chrome. The renderer adapts to
    // the actual content area after Chrome applies the platform's insets.
    const frameWidth = 8;
    const frameHeight = 40;
    const layout = recentTabsLayout(count, (source.width ?? Infinity) - frameWidth, Infinity);
    const preferredHeight = layout.height + frameHeight;
    const height = Math.min(preferredHeight, Math.max(260, source.height ?? preferredHeight));
    return { width: Math.min(source.width ?? Infinity, layout.width + MARGIN + frameWidth), height };
}

export function recentTabsPopupAdjustment(count, origin, popup, viewport, screen, zoom) {
    const { availLeft = 0, availTop = 0, availWidth, availHeight } = screen;
    if (![popup.left, popup.top, popup.width, popup.height, availLeft, availTop, availWidth, availHeight]
        .every(Number.isFinite) || availWidth <= 0 || availHeight <= 0 || !(zoom > 0)) return;

    // Chrome's window and work area use logical pixels. Use the actual frame
    // and tab zoom to translate the room available to the picker itself.
    const frameWidth = Math.max(0, popup.width - Math.round(viewport.width * zoom));
    const frameHeight = Math.max(0, popup.height - Math.round(viewport.height * zoom));
    const target = recentTabsLayout(count, (availWidth - frameWidth) / zoom, (availHeight - frameHeight) / zoom);
    const current = recentTabsLayout(count, viewport.width, viewport.height);
    const width = Math.min(availWidth, Math.ceil((target.width + MARGIN) * zoom) + frameWidth);
    const height = Math.min(availHeight, Math.ceil(target.height * zoom) + frameHeight);
    if (width === popup.width && height === popup.height) return;
    // Leave an already fitting initial window alone when only the conservative
    // frame allowance differs. Correct native windows opened at a saved size.
    if (current.mode === target.mode && current.width >= target.width &&
        current.height >= target.height && viewport.height >= current.height &&
        popup.width <= width + 8 && popup.height <= height + 12) return;

    function place(start, area, size, sourceStart, sourceSize, popupStart, popupSize) {
        const originCenter = sourceStart + sourceSize / 2;
        const center = originCenter >= start && originCenter < start + area ? originCenter : popupStart + popupSize / 2;
        return Math.max(start, Math.min(start + area - size, Math.round(center - size / 2)));
    }

    return {
        width, height,
        left: place(availLeft, availWidth, width, origin?.left, origin?.width, popup.left, popup.width),
        top: place(availTop, availHeight, height, origin?.top, origin?.height, popup.top, popup.height),
    };
}
