// Resolve plain-number accelerators against the currently displayed order.
// Repeats still identify a shortcut so the UI can consume them without typing.
export function numberShortcutIndex(event, resultCount) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || !/^[1-9]$/.test(event.key)) return null;
    // The first row keeps Enter; 1–9 address the following nine rows.
    const index = Number(event.key);
    return index < resultCount ? index : null;
}

export function optionDigit(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        !event.altKey || event.metaKey || event.ctrlKey || event.shiftKey || event.getModifierState?.('AltGraph') ||
        !/^Digit[0-9]$/.test(event.code)) return null;
    // Option can produce a symbol for a physical number key.
    return event.code.at(-1);
}
