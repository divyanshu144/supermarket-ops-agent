import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '.superpowers/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Destructuring-to-omit (`const { SECRET, ...rest } = env`) is the idiom the config
      // tests use to build an env object with one key missing. Without this, every such
      // omission is reported as an unused variable.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
