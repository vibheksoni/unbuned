export interface Limit {
  title: string;
  body: string;
}

export const limits: Limit[] = [
  {
    title: 'JavaScript only',
    body: 'It pulls out the JavaScript and the files packed next to it. It does not touch compiled machine code.',
  },
  {
    title: 'Names stay as Bun wrote them',
    body: 'A file Bun called chunk-9fxe9jf7.js is still called that. The names are the real ones, but hashed ones stay hashed.',
  },
  {
    title: 'Original files need source maps',
    body: 'The before-bundling code is only there if the app shipped source maps with it.',
  },
  {
    title: 'The last file can be cut short',
    body: 'The end of the code is worked out by measuring, so the final line can be trimmed. Bytecode never sneaks in.',
  },
  {
    title: 'Formatting only moves things around',
    body: 'It never renames, reorders or rewrites code. Very long lines stay long.',
  },
  {
    title: 'Bytecode stays as bytecode',
    body: 'Compiled JavaScriptCore is saved as-is. Turning it back into source is not something this does.',
  },
];
