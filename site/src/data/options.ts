export interface Option {
  flag: string;
  effect: string;
}

export const options: Option[] = [
  { flag: '-o, --output DIR', effect: 'Save somewhere else' },
  { flag: '-m, --modules', effect: 'One file per part, plus a manifest' },
  { flag: '--assets', effect: 'Also pull out images and other files' },
  { flag: '--sources', effect: 'Also pull out the original source' },
  { flag: '--bytecode', effect: 'Also save the compiled code Bun made' },
  { flag: '-a, --all', effect: 'All of the above in one go' },
  { flag: '--format', effect: 'Tidy up the code so it is easier to read' },
  { flag: '--indent N', effect: 'Spaces per level, default 2' },
  { flag: '--wrap-at N', effect: 'Line length, default 100, 0 turns it off' },
  { flag: '--inspect', effect: 'Report what is inside without writing anything' },
  { flag: '--json', effect: 'Same report, as JSON' },
  { flag: '--arch CPU', effect: 'Pick a version from a Mac universal build' },
  { flag: '--chunk-size N', effect: 'How finely to scan, default 1000' },
  { flag: '--threshold F', effect: 'How much non-text ends the code, default 0.3' },
  { flag: '--skip-existing', effect: 'Never overwrite a file that is already there' },
  { flag: '-q, --quiet', effect: 'Say less' },
];
