'use strict';
// Konfigurasi lint minimal (tanpa dependensi tambahan): menangkap variabel tak terdefinisi / tak terpakai.
const node = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', console: 'readonly', __dirname: 'readonly',
  setTimeout: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Intl: 'readonly', Buffer: 'readonly',
};
const browser = { window: 'readonly', document: 'readonly', location: 'readonly' };

module.exports = [
  { ignores: ['node_modules/**', 'docs/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: node },
    rules: { 'no-undef': 'error', 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }] },
  },
  { files: ['public/js/**/*.js'], languageOptions: { sourceType: 'script', globals: browser } },
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...node, ...browser } } },
];
