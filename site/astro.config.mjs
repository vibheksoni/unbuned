import { defineConfig } from 'astro/config';

const site = 'https://vibheksoni.com';
const base = '/unbuned';

export default defineConfig({
  site,
  base,
  trailingSlash: 'ignore',
  build: { format: 'directory', inlineStylesheets: 'auto' },
  compressHTML: true,
});
