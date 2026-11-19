export const DEFAULT_SPACE_COLOR = 'prismarc';
export const LIGHT_SPACE_COLOR = 'prismarc-light';

export function spacePaletteColor(color, dark = false) {
    return `var(--chrome-${color}-color${dark ? '-dark' : ''}, rgba(255, 255, 255, 0.1))`;
}
