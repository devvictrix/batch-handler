/**
 * @file Prettier configuration file for the BatchHandler project.
 * @see https://prettier.io/docs/en/configuration.html
 */

module.exports = {
  /** Use semicolons at the end of statements. */
  semi: true,
  /** Add trailing commas where valid in ES5 (objects, arrays, etc.). Helps with git diffs. */
  trailingComma: 'es5',
  /** Use single quotes instead of double quotes for strings. */
  singleQuote: true,
  /** Specify the line length that the printer will wrap on. */
  printWidth: 80,
  /** Specify the number of spaces per indentation-level. */
  tabWidth: 2,
  /** Enforce Unix-style line endings (LF). Crucial for cross-platform consistency. */
  endOfLine: 'lf',
};