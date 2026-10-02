# unbuned site

The one page site for unbuned. Astro, static output, no UI dependencies.

## Run it

```bash
cd site
npm install
npm run dev
```

## Build it

```bash
npm run build
npm run preview
```

The build writes `dist/`. The whole page is a single static file plus one
stylesheet, so it can be served by anything.

## Layout

| Path | What it is |
|---|---|
| `src/layouts/Base.astro` | Document head, SEO meta, JSON-LD, global styles |
| `src/components/` | One component per section, plus `Mark.astro` for brand marks |
| `src/data/` | Every string on the page, so copy edits never touch markup |
| `src/pages/index.astro` | Section order only |
| `public/` | Favicons, `og.png`, `robots.txt`, `sitemap.xml`, `llms.txt` |

## Changing the domain

`astro.config.mjs` sets `site` and `base`. They are currently
`https://vibheksoni.github.io` and `/unbuned`, which is what GitHub Pages
serves from this repository.

To move to a root domain such as `https://unbuned.example`, change both:

```js
const site = 'https://unbuned.example';
const base = '/';
```

Then update the three absolute URLs that are written by hand:
`public/robots.txt`, `public/sitemap.xml`, and `llms.txt`.

## Deploying

`.github/workflows/pages.yml` builds `site/` and publishes `dist/` to GitHub
Pages. Enable Pages for the repository with source set to GitHub Actions. The
workflow only runs once the site directory is committed.
