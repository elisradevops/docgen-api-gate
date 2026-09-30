import tseslint from 'typescript-eslint';
import globals from 'globals';

// Phase 4 regression guard: bans the two log-record-corrupting patterns the observability plan
// found and fixed by hand across all four backend repos. Deliberately does NOT extend
// js.configs.recommended/tseslint's recommended rule sets — this repo has never had a linter,
// and pulling in a general rule set now would surface a large, unrelated pre-existing backlog
// (unused vars, etc.) as new lint failures. Scope is exactly the one regression this guards
// against. Keep this file identical in shape across docgen-api-gate / docgen-content-control /
// docgen-data-provider-package / docgen-dg-skins-package — see each repo's CLAUDE.md "keep
// these files in sync" note.
export default tseslint.config(
  {
    ignores: ['bin/**', 'coverage/**', '**/test/**', '**/tests/**'],
  },
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.base],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='logger'] > :matches(TemplateLiteral, BinaryExpression[operator='+']).arguments:first-child MemberExpression[property.name='stack']",
          message:
            'Do not embed .stack in the log message string — errors({stack:true}) attaches it automatically when the Error is passed as an argument. Pass the Error itself as a positional/meta argument instead.',
        },
        {
          selector:
            "CallExpression[callee.object.name='logger'] CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > Identifier.arguments:first-child[name=/^(e|err|error|ex)$/]",
          message:
            "Don't JSON.stringify an Error — message/stack are non-enumerable and it serializes to {}. Pass the Error object directly as a log argument.",
        },
      ],
    },
  }
);
