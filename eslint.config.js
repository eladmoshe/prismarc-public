import globals from 'globals';

export default [
  { ignores: ['dist/**', 'dist-dev/**', 'coverage/**'] },
  {
    files: ['*.js', 'public/*.js', 'scripts/**/*.js', 'vite-plugins/*.js', 'tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        chrome: 'readonly',
        __PRISMARC_CALENDAR_CLIENT_ID__: 'readonly',
        __PRISMARC_INCLUDE_CALENDAR__: 'readonly',
        __PRISMARC_STORE_BUILD__: 'readonly',
      },
    },
    rules: {
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['tests/e2e/**/*.js'],
    languageOptions: { globals: globals.jest },
  },
];
