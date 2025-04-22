/**
 * @file ESLint configuration file for the BatchHandler project.
 * @see https://eslint.org/docs/latest/use/configure/
 */

module.exports = {
  /**
   * Specifies the parser ESLint will use.
   * @see https://typescript-eslint.io/packages/parser
   */
  parser: '@typescript-eslint/parser',

  /**
   * Extends recommended rule sets. Order matters; later sets override earlier ones.
   * - `eslint:recommended`: ESLint's built-in recommended rules.
   * - `plugin:@typescript-eslint/recommended`: Recommended rules for TypeScript code.
   * - `plugin:prettier/recommended`: Integrates Prettier rules, disabling conflicting ESLint rules. Must be last.
   * @see https://eslint.org/docs/latest/use/configure/configuration-files#extending-configuration-files
   * @see https://typescript-eslint.io/linting/configs#recommended
   * @see https://github.com/prettier/eslint-plugin-prettier#recommended-configuration
   */
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],

  /**
   * Specifies parser options.
   * @see https://eslint.org/docs/latest/use/configure/language-options#specifying-parser-options
   */
  parserOptions: {
    ecmaVersion: 2020, // Use ES11 features.
    sourceType: 'module', // Use ES Modules (import/export).
  },

  /**
   * Customizes or overrides rules from the extended configurations.
   * @see https://eslint.org/docs/latest/use/configure/rules
   */
  rules: {
    // Allows the use of `any` type but issues a warning. Useful during initial development or complex integrations.
    '@typescript-eslint/no-explicit-any': 'warn',

    // Disables the rule requiring explicit return types on functions exported by a module.
    // While explicit types improve clarity, this can be relaxed for brevity if type inference is sufficient.
    '@typescript-eslint/explicit-module-boundary-types': 'off',

    // Disable the base 'no-unused-vars' rule as the TypeScript-specific version is preferred.
    'no-unused-vars': 'off',

    // Warns about unused variables but allows those prefixed with an underscore (`_`).
    // Useful for intentionally ignored parameters (e.g., in callbacks, function signatures).
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],

    // Enforces Prettier code style rules.
    // `endOfLine: 'auto'` lets Prettier handle line endings based on the OS/Git config, improving cross-platform compatibility.
    'prettier/prettier': ['error', { endOfLine: 'auto' }],
  },

  /**
   * Defines global variables that are predefined during execution.
   * @see https://eslint.org/docs/latest/use/configure/language-options#specifying-environments
   */
  env: {
    node: true, // Enables Node.js global variables (e.g., `process`, `__dirname`) and scoping.
    jest: true, // Enables Jest global variables (e.g., `describe`, `it`, `expect`) for test files.
  },

  /**
   * Specifies files and directories that ESLint should ignore.
   * @see https://eslint.org/docs/latest/use/configure/ignore
   */
  ignorePatterns: [
    'node_modules/', // Standard directory for dependencies.
    'dist/', // Common directory for build output.
    'coverage/', // Common directory for code coverage reports.
    '**/*.cjs', // Ignore CommonJS output files if generated separately.
  ],
};