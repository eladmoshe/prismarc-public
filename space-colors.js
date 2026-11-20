export const DEFAULT_SPACE_COLOR = 'prismarc';
export const LIGHT_SPACE_COLOR = 'prismarc-light';
export const APPEARANCE_THEME_KEY = 'appearanceTheme';

export function isAppearanceTheme(value) {
    return value === 'dark' || value === 'light';
}

export const SPACE_COLOR_NAMES = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'];

export function paletteName(color) {
    return SPACE_COLOR_NAMES.includes(color) ? color : DEFAULT_SPACE_COLOR;
}

// Use relative luminance to choose the foreground for a custom solid.
export function solidUsesLightInk(hex) {
    const [red, green, blue] = hex.slice(1).match(/../g).map(channel => {
        const value = parseInt(channel, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue < 0.2;
}
