export type Mark = 'claude' | 'factory' | 'freebuff' | 'slate';

export interface Sample {
  id: string;
  name: string;
  vendor: string;
  mark: Mark;
  meta: string;
  note: string;
  href: string;
  archive?: { label: string; href: string };
}

const repo = 'https://github.com/vibheksoni/unbuned';
const blob = (path: string) => `${repo}/blob/master/${path}`;
const asset = (name: string) => `${repo}/releases/download/v1.1.0/${name}`;

export const samples: Sample[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    vendor: 'Anthropic',
    mark: 'claude',
    meta: 'claude.exe · 40.9 MB · 2,156 files',
    note: 'The agent, the CLI and every tool it ships with, all named the way Bun recorded them.',
    href: blob('output/claude/claude.js'),
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    vendor: 'Factory',
    mark: 'factory',
    meta: 'droid.exe · 14.1 MB · 1 file',
    note: 'Agent logic, model settings and the app flows. A newer build of Droid unpacks into 623 files.',
    href: blob('output/droid/droid.js'),
  },
  {
    id: 'freebuff',
    name: 'Freebuff',
    vendor: 'Freebuff',
    mark: 'freebuff',
    meta: 'freebuff · 11.4 MB · 1 file',
    note: 'The telemetry, model routing and product flows that ship inside the desktop app.',
    href: blob('output/freebuff/freebuff.js'),
  },
  {
    id: 'slate',
    name: 'Slate',
    vendor: 'Random Labs',
    mark: 'slate',
    meta: 'slate.exe · 22.4 MB · 2 files',
    note: 'No public source anywhere, so reading it meant taking it apart. An OpenCode fork.',
    href: blob('output/slate/slate.js'),
    archive: { label: 'slate-full.7z', href: asset('slate-full.7z') },
  },
  {
    id: 'claude-sdk',
    name: 'Claude Agent SDK',
    vendor: 'Anthropic',
    mark: 'claude',
    meta: 'claude.exe · 33.8 MB · 3 files',
    note: 'This one runs on compiled bytecode, so what comes back is the fallback source, not what runs.',
    href: blob('output/claude-sdk/claude.js'),
    archive: { label: 'claude-sdk-full.7z', href: asset('claude-sdk-full.7z') },
  },
];
