// @ts-check

// https://eslint.org/docs/latest/use/configure/configuration-files
// https://prettier.io/docs/integrating-with-linters
// https://www.npmjs.com/package/@eslint/js
// https://github.com/eslint/json

import { defineConfig } from 'eslint/config';

import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import tseslint from 'typescript-eslint';
import json from '@eslint/json';
import js from '@eslint/js';
import globals from 'globals';

export default defineConfig([
  {
    ignores: ['node_modules/', 'dist/', 'out/'],
  },

  eslintPluginPrettierRecommended,

  // TypeScript files
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },

  // JS config files (esbuild.mjs, prettier.config.mjs, etc.)
  {
    files: ['**/*.mjs'],
    plugins: { js },
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    extends: ['js/recommended'],
  },

  {
    files: ['**/*.json'],
    ignores: ['package-lock.json'],
    plugins: { json },
    language: 'json/json',
    extends: ['json/recommended'],
  },
]);
