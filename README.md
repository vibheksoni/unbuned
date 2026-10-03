<div align="center">

<img src="assets/unbuned.png" alt="unbuned logo" width="200"/>

# unbuned

**Extract JavaScript from Bun-compiled executables**

The easiest Bun decompiler-style JavaScript extractor for reverse engineering, malware analysis, security research, and code recovery.

[![Python](https://img.shields.io/badge/Python-3.6+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/vibheksoni/unbuned)](https://github.com/vibheksoni/unbuned/releases)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20PE%20%7C%20macOS%20Mach--O-lightgrey.svg)](https://github.com/vibheksoni/unbuned)
[![Dependencies](https://img.shields.io/badge/Dependencies-None-success.svg)](https://www.python.org/downloads/)
[![Stars](https://img.shields.io/github/stars/vibheksoni/unbuned?style=social)](https://github.com/vibheksoni/unbuned/stargazers)
[![Forks](https://img.shields.io/github/forks/vibheksoni/unbuned?style=social)](https://github.com/vibheksoni/unbuned/forks)

[Why It Exists](#why-it-exists) | [Quick Start](#quick-start) | [Features](#features) | [Real-World Samples](#real-world-samples) | [How It Works](#how-it-works)

</div>

---

## What is unbuned?

**unbuned** is a zero-dependency Python extractor for Bun-compiled executables. It locates the embedded Bun bundle, strips the binary noise around it, and writes clean JavaScript back to disk.

If you want to reverse engineer a Bun CLI, inspect a suspicious Bun-packed binary, recover lost app logic, or study how a production Bun app is bundled, this is the tool.

## Why It Exists

I built `unbuned` for the exact moment where a Bun executable lands on disk and you do not want a full reverse-engineering project just to see the application logic. Most of the time, the thing you actually need is the JavaScript bundle, fast, with as little friction as possible.

That is the whole point of this repo: one Python file, no dependencies, no install ceremony, and output you can immediately grep, diff, beautify, or audit.

If this tool saves you time, star the repo. That is what helps it reach more reversers, researchers, and malware analysts.

---

## Installation

```bash
git clone https://github.com/vibheksoni/unbuned.git
cd unbuned
```

No dependencies required. Just Python 3.6+.

---

## Quick Start

```bash
python unbuned.py <path-to-bun-executable>
```

Examples:

```bash
python unbuned.py droid.exe
python unbuned.py claude.exe
python unbuned.py freebuff
```

Output lands here:

```text
output/<executable-name>/<executable-name>.js
```

### Options

| Flag | Effect |
|---|---|
| `-o`, `--output DIR` | Write to `DIR` instead of `output/<name>` |
| `--format` | Reformat the extracted JavaScript for reading |
| `--indent N` | Spaces per indentation level with `--format` (default 2) |
| `--wrap-at N` | Column at which `--format` wraps long lines (default 100, 0 disables) |
| `-a`, `--all` | Dump everything: modules, sources, assets, manifests and bytecode |
| `-m`, `--modules` | Also write one file per compiled module plus `manifest.json` |
| `--sources` | Also write the original sources recovered from the source maps |
| `--assets` | Also extract the non-JavaScript files the executable embeds |
| `--bytecode` | Also dump the bytecode regions that surround the JavaScript |
| `--inspect` | Report on the executable without writing anything |
| `--json` | Emit the inspection report as JSON |
| `--arch CPU` | Pick a slice from a universal Mach-O by CPU type |
| `--chunk-size N` | Boundary scan granularity (default 1000) |
| `--threshold F` | Non-text ratio that ends the JavaScript (default 0.3) |
| `--skip-existing` | Never overwrite an existing output file |
| `-q`, `--quiet` | Suppress progress output |

```bash
python unbuned.py claude.exe --inspect
python unbuned.py claude.exe -a
python unbuned.py claude.exe --inspect --json | jq .module_count
```

## Everything In One Dump

`--all` walks the whole bundle and writes a tree:

```text
output/claude/claude.js            merged JavaScript
output/claude/manifest.json        module offsets, sizes, flags
output/claude/modules/             one file per compiled module
output/claude/sources/             original sources, in their real tree
output/claude/sources/sources.json which chunk each source came from
output/claude/assets/              embedded non-JavaScript assets
output/claude/assets/assets.json   frame offsets, sizes, kinds
output/claude/claude.bytecode-*.bin the JSC bytecode regions
```

On `claude.exe` that is 2,299 files in about three seconds.

---

## Features

- Extract JavaScript from Bun-compiled executables with pure Python 3.6+
- Reformat the recovered JavaScript with a built-in, dependency-free beautifier
- Parse Windows PE `.bun` sections directly
- Parse macOS Mach-O `__BUN,__bun` sections directly, thin or universal
- Parse Linux/ELF `.bun` sections directly, 32-bit or 64-bit, either endianness
- Fall back to Bun magic-byte discovery when section metadata is unavailable
- Split the bundle into its individual compiled modules with a JSON manifest
- Recover every module's real embedded path from Bun's own module graph
- Recover the original pre-bundle sources and their real paths from the
  embedded source maps, Zstandard compressed, into a mirrored tree
- Extract every embedded non-JavaScript file, compressed or not, and name
  it from the graph
- Dump everything in one pass with `--all`
- Report whether the executable runs JavaScriptCore bytecode instead of source
- Write byte-exact output with no newline translation or lossy re-encoding
- Memory-map the input instead of loading it into RAM
- Save clean UTF-8 JavaScript to `output/<name>/<name>.js`
- Stay readable, hackable, and dependency-free

## Supported Targets

`unbuned` currently handles:

- Windows PE Bun executables
- macOS thin and universal (FAT) Mach-O Bun executables
- Linux/ELF Bun executables
- Other Bun-packed binaries when the bundle can be located through the Bun magic-byte fallback

## Splitting Into Modules

A Bun bundle is not one file. It is a NUL-delimited list of compiled modules,
each introduced by a `// @bun` header line. `--modules` writes them out
separately so you can grep, diff, and open them individually:

```bash
python unbuned.py claude.exe -m
```

```text
output/claude/claude.js            40,913,893 bytes, all modules concatenated
output/claude/manifest.json         offsets, sizes, flags, file names
output/claude/modules/0000-chunk-6w5pag2z.js
output/claude/modules/0006-cli.js
...
```

Module names come from Bun's own module graph, so they are the real embedded
paths rather than guesses (see [Real File Names](#real-file-names)). When a
binary ships no readable graph, the name falls back to the module's first
import specifier. CommonJS modules get a `.cjs` extension, ES modules `.js`.

## Real File Names

Bun does not just concatenate your source. It compiles the whole program into
a single blob and, before that blob, writes a table describing every file it
embedded: the original path, the source text, any source map, the JSC bytecode,
and the loader and format it was compiled with.

That table is a `StandaloneModuleGraph`, and it is the reason `unbuned` can put
real names on things. Bun's build step appends it to the end of the `.bun`
section in a fixed order: the file records, a 32 byte `Offsets` struct, then
the literal marker `\n---- Bun! ----\n`.

```text
...file records...
Offsets   { byte_count, modules_ptr, entry_point_id, compile_exec_argv_ptr, flags }
TRAILER   "\n---- Bun! ----\n"
```

Finding the trailer from the end of the section locates the header, the header
points at the table, and the table is 52 bytes per file:

```text
name                  { u32 offset, u32 length }
contents              { u32 offset, u32 length }
sourcemap             { u32 offset, u32 length }
bytecode              { u32 offset, u32 length }
module_info           { u32 offset, u32 length }
bytecode_origin_path  { u32 offset, u32 length }
encoding              u8     0 binary, 1 latin1, 2 utf16
loader                u8     0 js, 1 jsx, 2 ts, 3 tsx, 4 json, 5 file, ...
module_format         u8     0 none, 1 esm, 2 cjs
side                  u8     0 server, 1 client
```

One detail matters more than it looks: every one of those offsets is relative
to the start of the section *plus* the section's own eight byte length header.
Missing that `+8` makes every pointer land eight bytes early, which is enough
to turn a whole table into garbage.

Records are written in load order, entry point first, then its static imports,
then dynamic imports breadth first. So a module's `contents` offset is exactly
where that module's text begins in the bundle, and matching a module to its
name is a dict lookup rather than a guess:

```text
modules named from module graph: 2156 of 2156
```

The graph also answers questions the bundle text cannot. For `claude.exe`:

```text
Module graph: 2384 embedded files
Entry point: B:/~BUN/root/cli
Startup modules: 7 in the entry point's static import closure
Graph loaders: 2156 jsx, 140 file, 87 binary, 1 text
```

`entry_point_id` and the startup count come from the same header, and the
remaining flags decode to the compiler's own feature set (`has_source_hashes`,
`has_builtin_bytecode`, `has_bytecode_string_table`, and so on). All of it is
written to `manifest.json` under `module_graph`, and every module entry gains
the path the graph recorded for it.

What the graph cannot give you is the original import graph, or a name better
than the one the bundler chose. Bun has already hashed chunks to
`chunk-9fxe9jf7.js` by the time it writes the table. `unbuned` reports what the
compiler recorded and does not pretend to recover more.

## Formatting The Output

Bun ships minified code, and minified code is one enormous line per module.
`--format` runs the bundle through a built-in beautifier so the output is
readable without installing anything:

```bash
python unbuned.py claude.exe --format
python unbuned.py claude.exe --format --indent 4 --wrap-at 120
python unbuned.py claude.exe --all --format
```

```text
Extracted: output/claude/claude.js
Size: 40,913,893 bytes (formatted)
```

### Why It Is Built In

Prettier, js-beautify and Babel are Node packages, and they all build a full
syntax tree before printing anything. That is the wrong shape for a Python tool
that has to stay one file with no dependencies, and it is the wrong shape for a
40 MB bundle. `unbuned` instead ships a single-pass lexer: it scans for the
constructs that change layout (strings, template literals, comments, regular
expressions, operators, brackets) and copies everything between them through
untouched.

That design has one hard guarantee, and it is the important one: **the formatter
only ever adds or removes whitespace.** No token is rewritten, no string is
re-quoted, no operator is re-ordered. The printed file is the extracted file
with different whitespace, so the two are identical once whitespace is
collapsed:

```python
assert "".join(extracted.split()) == "".join(formatted.split())
```

That guarantee is checked two ways. The test suite pins the cases that used to
break it: a quote that must not pair across code, a regular expression that
starts with `=`, a division that must not be scanned for a pattern, and a
template literal that has to survive a run of minified code in front of it. On
top of that, the whole 40 MB `claude.exe` bundle is formatted end to end and
compared, module by module, and every module is then parsed as an ECMAScript
module by node itself.

Node only honours `node --check` on a `.js` file when that file has no
`import` or `export` statement in it. A Bun bundle always does, so checking
one by its path silently succeeds without parsing anything. Pipe the module
in through standard input with `--input-type=module` to make node parse it
for real:

```bash
node --check --input-type=module < module.js
```

### What It Does

- indents by brace depth, with a cap so unbalanced input cannot inflate the file
- breaks statements, object and array literals, and `switch` cases
- pads operators, and keeps unary uses, `++`/`--`, and `?.` glued correctly
- separates `/` division from `/regex/` literals, including after `if (...)` heads
  and after any other value, and reads a pattern such as `/=/g` from the source
  before accepting `/=` as an assignment operator
- pairs quotes strictly, so a string can never run away through the rest of a
  module and shift every template literal after it
- keeps `import`/`export` specifier lists on one line, empty braces inline
- formats small `${...}` interpolations, and copies large ones verbatim
- wraps long lines at commas, binary operators, and member accesses
- resets layout state at each `// @bun` module header, so one unbalanced module
  cannot push everything after it deeper and deeper

It preserves the author's own line breaks where they exist and is deliberately
conservative about the rest. On `claude.exe` the whole 40 MB bundle formats in
about 21 seconds, every one of the 2156 modules comes back with its content
untouched, and every module is then parsed as an ECMAScript module by node
itself.

The trade-offs are honest ones:

- it is a lexer, not a parser, so it never renames, reorders, or rewrites
- a single token longer than the wrap width stays on its own long line
- interpolation bodies that are huge or deeply nested are copied verbatim
- a statement with no comma, operator, or bracket cannot be split at all

## Bytecode-Compiled Binaries

When a binary is built with `--bytecode`, the JavaScript you extract is the
*fallback* source. The bundle also carries a JavaScriptCore bytecode payload,
and that is what actually executes at runtime. `unbuned` reports this:

```text
Bytecode: JSC bytecode is embedded; 2156 of 2156 modules execute bytecode, not the source above
```

Use `--bytecode` to write the bytecode out. It writes one blob per module into
`bytecode/`, taken from the bytecode pointer and length the module graph
already records for each file:

```text
Bytecode blobs: 2164 modules, 89027160 bytes of bytecode addressed by the graph
```

Slicing the section into a "head" before the JavaScript and a "tail" after it,
which is what this used to do, produces blobs that are mostly the module graph
and the source rather than bytecode. On `claude.exe` that head was about
109 MB of mostly metadata. The pointer-driven path writes 2164 real blobs and
`bytecode/index.json`, and falls back to head and tail only when a binary's
graph carries no pointers at all.

Every blob starts with the same header, and `unbuned` checks it:

```text
d8 7e 89 08 01 00 00 00 | 04 00 00 00 | 60 08 00 00
magic and version       | version      | declared length
```

The declared length matches the graph's recorded length for every module in
`claude.exe`, which is a useful integrity check on the extraction.

Each module's own string pool is read too and recorded per module. In practice
those pools are dominated by JavaScriptCore runtime names such as `generator`,
`iterator` and `homeObject`, rather than application identifiers, and a
printable run sometimes runs one byte past the name it holds. Treat them as
leads. The literals that actually name things live in a shared table the
compiler appends once per binary, which `unbuned` does not read yet.

What `unbuned` does not do is turn bytecode back into JavaScript. JSC bytecode
is a register machine whose opcodes, register allocation and calling convention
are undocumented and change between releases, so reconstructing source from it
is a compiler backend rather than a parser. The blobs are written in a form a
disassembler can work from, but no disassembler is bundled.

## Embedded Assets

A Bun executable is not only JavaScript. Non-JavaScript files are embedded as
Zstandard frames inside the same section and never appear in the source at
all. `--assets` finds and extracts them:

```bash
python unbuned.py claude.exe --assets
```

```text
Assets: 138 files in output/claude/assets [decompressed]
Asset names from module graph: 138 of 138
Referenced asset names: 144
```

`claude.exe` turns out to ship 138 of them, about 10 MB decompressed: skill
definitions with YAML front matter, HTML templates, and vendored browser
bundles.

Their names come from the module graph, which records the real path for every
embedded file, so all 138 are named exactly. Two suffixes are Bun's plumbing
rather than part of the name and are removed: the trailing `.zst` that marks
the compressed frame, and the `.txt` Bun appends to keep a non-text asset on
its text pipeline. The content hash stays, because it is part of the name the
bundler recorded and dropping it would collide distinct assets that share a
stem:

```text
B:/~BUN/root/template.html-fb05d44d.txt.zst   ->  template.html-fb05d44d.html
B:/~BUN/root/SKILL-f2840619.md.zst            ->  SKILL-f2840619.md
B:/~BUN/root/chart.umd.min.js                 ->  chart.umd.min.js
```

Not every embedded file is compressed. `droid.exe` stores its native
helpers verbatim and its skills as UTF-16, so each file is sliced out at the
length the graph records, and the recorded encoding decides whether it is
written as stored or transcoded to UTF-8. A helper the bundler could not give
an extension ends its recorded name in a bare dot, which is why the payload's
own magic decides the extension:

```text
B:/~BUN/root/keytar-aabbccdd.              ->  keytar-aabbccdd.exe
B:/~BUN/root/fff_c-ddeeff00.dll           ->  fff_c-ddeeff00.dll
B:/~BUN/root/authentication.md-11223344.asset -> authentication.md-11223344.md
```

The last one is Bun's placeholder extension for files whose original one is
not part of the bundle, which strands the real extension inside the stem. The
recorded name is still used; only the extension is recovered.

A binary with no readable graph falls back to naming each file from its own
contents, taking the `name:` field of front matter, an HTML `<title>`, a
top-level heading, or a banner comment. Either way the exact section offset
lands in `assets.json`, and the graph's own path is recorded per asset under
`name`, so anything left as `asset-NNNN` can still be traced back.

The JavaScript refers to these files by their hashed names, so all of those
references are listed in `assets.json` under `referenced_names`.

Zstandard support is optional. When no binding is installed the frames are
still extracted, just left compressed as `.zst`:

```bash
pip install zstandard
```
---

## Original Sources

`--sources` goes one level deeper than the bundle. Bun keeps the text every
module was built from, and the path of that text, inside the source map region
each module record points at. This is the only place the original TypeScript
survives, because the bundle itself has already been flattened into chunks.

```bash
python unbuned.py droid.exe --sources
```

```text
Sources: 4914 files in output/droid/sources from 473 source maps [decompressed]
Original source bytes: 42,608,826
```

The record is not the JSON source map the bundler produced. Bun walks that
JSON once while compiling and writes a compact table instead, laid out by
`serialize_json_source_map_for_standalone` in `StandaloneModuleGraph.rs`:

| Offset | Contents |
|---|---|
| `0` | `u32` source count |
| `4` | `u32` length of the raw VLQ mapping |
| `8` | one `{offset, length}` pointer per source path |
| then | one `{offset, length}` pointer per source text |
| then | the VLQ mapping blob |
| then | every path, then every source text Zstandard compressed |

Every offset is absolute within the record, which gives a usable anchor: the
first path must begin exactly where the pointers and the VLQ blob end. A
record that does not line up is rejected rather than half-read.

Paths are recorded relative to whichever file imported them, so a shared
dependency arrives as `../../node_modules/...`. Dropping the leading `..`
segments turns that back into the path the file actually had, and the tree
lands the way it was compiled:

```text
src/index.ts                                            the CLI entry point
src/exec/acpDaemonRunner.ts                             command runners
packages/logging/src/tracing/enums.ts                   a workspace package
node_modules/@opentelemetry/api/build/src/version.js     a dependency
```

For `droid.exe` that is 4,914 files and 42.6 MB of original source: 2,487
`node_modules` dependencies, 1,281 files of droid's own `src`, and 1,146
workspace `packages`.

The same file often backs more than one chunk. Those are written once and
listed in `sources/sources.json` under `duplicate`, alongside the chunk each
copy came from, so nothing is silently overwritten.

Not every build carries them. `claude.exe` embeds no source maps, so
`--sources` reports nothing there, and that is a property of the binary
rather than a failure.

---

## How Do You Extract JS From a Bun Executable?

Run the executable through `unbuned`:

```bash
python unbuned.py droid.exe
```

**Output**

```text
Extracted: output/droid/droid.js
Size: 14,234,567 bytes
```

The extracted JavaScript will be saved to `output/<executable-name>/<executable-name>.js`.

---

## Real-World Samples

Extracted bundles from real Bun applications are committed under
[`output/`](output/claude/claude.js) so you can see exactly what `unbuned` pulls
out of production binaries before running it yourself.

### 1. Claude Code (`claude.exe`) in full

The most complete run, produced by one command:

```bash
python unbuned.py claude.exe -o output/claude/full --all --format
```

| | |
|---|---|
| Executable | 247.7 MB PE64, `.bun` section of 153.9 MB |
| JavaScript | 40.9 MB, 2,156 compiled modules |
| Module graph | 2,384 embedded files, all named |
| Entry point | `B:/~BUN/root/cli` |
| Assets | 138 Zstandard frames, about 10 MB decompressed |

That run writes 229 MB across 2,299 files, so it is not committed. The
browsable extraction above is the same bundle unformatted; run the command to
get the formatted output, the per-module files, and the manifests locally.

The asset names are the clearest evidence the module graph parse works. Bun
stores each asset as a compressed, content-hashed frame with a useless name, and
all 138 come back with the name the compiler recorded:

```text
0000-chart.umd.min.js                    0008-plugin-eval-quickref-5681d66c.md
0002-SKILL-f2840619.md                   0010-claude-code.d.ts-e37ccc4a.ts
0004-template.html-fb05d44d.html         0014-mermaid.min.js
```

Module names come from the same table, so `--modules` writes real source paths
like `0006-cli.js` instead of `0000-fs.js` guesses.

### 2. Factory Droid CLI (`droid.exe`)

- **Extracted:** 14.1 MB of JavaScript
- **Contains:** agent logic, model configuration, application workflows
- **Location:** [`output/droid/droid.js`](output/droid/droid.js)

The tracked sample above comes from an earlier build. Factory CLI
v0.232.0 (275 MB, installed to `~/bin/droid.exe`) is worth a full dump,
and it is the binary that exercises source recovery:

```bash
python unbuned.py ~/bin/droid.exe -o output/droid/full --all --format
```

```text
Modules: 623 files in output\droid\full\modules
Assets: 80 files in output\droid\full\assets [decompressed]
Asset names from module graph: 80 of 80
Sources: 4914 files in output\droid\full\sources from 473 source maps
Original source bytes: 42,608,826
```

That is 5,623 files and 364 MB: 623 bundled chunks named from the graph
(entry point `B:/~BUN/root/droid`), 80 named assets including `rg.exe`,
`keytar`, the `rust_pty` libraries for four platforms, two sound effects
and the `SKILL.md` files, and 4,914 original sources. The full tree is
untracked because it is large; regenerate it with the command above.

### 3. Freebuff (`freebuff`)

- **Extracted:** 11.4 MB of JavaScript
- **Contains:** telemetry events, model routing, product and CLI flows
- **Location:** [`output/freebuff/freebuff.js`](output/freebuff/freebuff.js)

### 4. Slate (`slate.exe`), proprietary

- **Extracted:** 22.4 MB of formatted JavaScript, 2 compiled modules
- **Contains:** the full agent runtime, terminal emulator, and TUI
- **Location:** [`output/slate/slate.js`](output/slate/slate.js)
- **Full dump:** [`output/slate/slate-full.7z`](output/slate/slate-full.7z), 3.1 MB

Slate is the one target here that ships no public source. Its npm package is
marked `Proprietary` and carries no repository field, so the only way to read
its code is to extract it. Both compiled modules are ESM, and the module
graph names every one of the 16 embedded files, which is why the assets come
back with real names instead of content hashes:

```text
0000-rust_pty-fazdxkv2.dll            0006-tree-sitter-markdown-411r6y9b.wasm
0002-tree-sitter-javascript-nd0q4pe9.wasm
0012-opentui-f2aygf4h.dll            0013-watcher-cn9g1cfm.node
```

The strings show what it is: an OpenCode fork with its own API host, carrying
`OPENCODE_` identifiers and `api.randomlabs.ai` endpoints throughout.

```bash
python unbuned.py slate.exe -o output/slate/full --all --format
```

### 5. Claude Agent SDK (`claude.exe`), 0.3.220

- **Extracted:** 33.8 MB of formatted JavaScript, 3 compiled modules, all CJS
- **Contains:** the agent loop, tool definitions, and the full CLI surface
- **Location:** [`output/claude-sdk/claude.js`](output/claude-sdk/claude.js)
- **Full dump:** [`output/claude-sdk/claude-sdk-full.7z`](output/claude-sdk/claude-sdk-full.7z), 12.8 MB

This build is different from the standalone `claude.exe` above in a way worth
recording: it is bytecode compiled, and all three modules carry the
`// @bun @bytecode @bun-cjs` header. The JavaScript you get back is the
fallback source, not what actually runs. The graph names the entry point as
`B:/~BUN/root/src/entrypoints/cli.js` and two native bridges, and all five
assets are recovered by name:

```text
0000-image-processor.node             0002-hljsBundle.generated.min.js
0001-chart.umd.min.js                0003-mermaid.min.js
```

The bundle also carries the largest regular expressions this project has met,
a 10 KB emoji alternation table that a naive tokenizer reads as division. See
[Formatting The Output](#formatting-the-output) for why a whitespace-only
guarantee is not the same as a parse.

### 6. Amp CLI (`amp.exe`), 0.0.1790956876

- **Extracted:** 13.2 MB of formatted JavaScript, 2 compiled modules
- **Contains:** the full agent CLI, and the keyring bridge it loads natively
- **Location:** [`output/amp/amp.js`](output/amp/amp.js)
- **Source binary:** 103,919,952 bytes, `.bun` section of 17,745,205 bytes

This is the one sample in this repository whose JavaScript is **UTF-16**, and
it is the reason [`unbuned` detects the encoding](#utf-16-bundles) rather than
assuming plain bytes. The bundle marker sits eight bytes into the section and
every ASCII character behind it is followed by a padding NUL, so a byte-level
search for `// @bun` finds nothing and every text ratio reads as half binary.

The recovered bundle is ordinary JavaScript once decoded: it is valid UTF-8
with no NUL padding left in it, and `node --check` parses it cleanly. The
module graph names the entry point `B:/~BUN/root/amp-windows-x64.exe`, and the
one recovered asset is the native addon the CLI publishes to the page:

```text
0000-keyring.win32-x64-msvc-108knn1q.node    427,520 bytes
```

The graph also confirms the extraction independently. It records the entry
point at section offset 8 with a length of exactly 17,317,422 bytes, which is
precisely what `unbuned` emits, and the only other graph file is the keyring
addon. That is a much stronger check than "the output looks like JavaScript".

One thing to know if you use `--modules` on this build: the extractor reports
two module headers where the graph records one JavaScript file. The second
`// @bun` is the first line of a script held inside a template literal
(`xei = \`#!/usr/bin/env bun\n...`), so it starts a line without being a
module boundary. The concatenated `amp.js` is unaffected, because the boundary
between the two is inside a string and the file still parses. See
[Limitations](#limitations) for why that is left alone rather than special
cased.

These samples are the proof point. `unbuned` is built to rip useful code out of
real shipped Bun executables, not just synthetic fixtures.

## Why These Samples Matter

Reverse-engineering tools live or die on credibility. Including extracted bundles from Droid, Claude Code, Slate, the Claude Agent SDK, Freebuff, and the Amp CLI makes the value concrete:

- you can inspect real output before running the tool
- you can use the repo as a search surface for Bun internals
- you can verify that the extraction stays readable at multi-megabyte scale
- you can benchmark your own reversing workflow against real targets

## What You Get Back

When extraction succeeds, you get:

- a clean `.js` file on disk
- UTF-8 text without the surrounding binary junk
- output that is ready for grep, static analysis, beautification, or manual review

That makes `unbuned` useful for both fast triage and deeper reversing sessions.

If you want to judge the extractor before running it yourself, open a sample bundle such as [`output/claude/claude.js`](output/claude/claude.js) and search through it. The repo is meant to prove the claim, not just make it.

---

## How It Works

`unbuned` uses a multi-stage extraction process:

1. **Format Detection:** detect the executable container and choose the best extraction path.
2. **Section Discovery:** locate `.bun` in PE and ELF files, or `__BUN,__bun` in Mach-O files.
3. **Universal Slice Selection:** pick an architecture from a FAT Mach-O, or the first one.
4. **Magic-Byte Fallback:** search for the Bun bundle marker when section metadata is not enough.
5. **JavaScript Marker Detection:** find the `// @bun` marker that denotes the bundle start.
6. **Module Discovery:** walk the NUL-delimited `// @bun` headers to index every module.
7. **Boundary Detection:** measure non-printable byte ratios to find the transition from code to binary data.
8. **Boundary Refinement:** use markers like `//# debugId=`, `//# sourceMappingURL=`, and `})();` to stop cleanly.
9. **Tail Trimming:** place the exact end of the last module and drop trailing bytecode.
10. **Extraction:** write the recovered JavaScript as raw bytes to `output/<name>/<name>.js`.

### UTF-16 Bundles

Most Bun builds store the bundle as plain bytes, but some ship the whole
JavaScript region as UTF-16, where every ASCII character is followed by a
padding NUL. `amp.exe` (the Amp CLI) is one of these. Such a bundle defeats a
plain byte search for the `// @bun` marker, and every byte-level text ratio
reads as roughly half binary.

`unbuned` detects this without being told. It looks for the marker as plain
bytes first and then as UTF-16 in either byte order, and threads the detected
encoding through the boundary scan, module splitting and header parsing.
Classification switches from `bytes.translate` over raw bytes to
`str.translate` over decoded code units, because the low byte of an accented
Latin letter or a Cyrillic character is itself an unprintable value, and
sampling low bytes alone would stop the scan early inside ordinary source.

Offsets stay in the original byte space throughout, so module offsets, the
module graph and the manifest still describe the file as it sits on disk. The
text is decoded to UTF-8 only where it is actually consumed: filenames, asset
paths, and the files written out. `manifest.json` records what was found under
`javascript.encoding`.

This holds for every container format, not just PE. Mach-O and universal
Mach-O terminate their bundle with a NUL instead of padding it out to the end
of the section, and in UTF-16 that padding NUL follows every ASCII character,
so the terminator has to be located on the code unit grid or the scan stops one
byte in. The test suite covers PE, Mach-O, universal Mach-O and ELF in both
byte orders.

### Boundary Detection Algorithm

The extractor uses a practical heuristic tuned for real Bun payloads:

- analyzes chunks for non-printable character ratios
- looks for source map comments (`//# sourceMappingURL=`)
- detects debug markers (`//# debugId=`)
- identifies IIFE closures (`})();`)
- validates binary-looking data after potential boundaries
- narrows to the transition with a coarse pass, then a fine pass, then lands on
  the exact code unit rather than stopping at a window edge
- byte classification runs through `bytes.translate`, so a 150 MB section is
  scanned inside CPython's C layer rather than a Python-level loop
- UTF-16 bundles are classified with `str.translate` over decoded code units
  instead, because a low-byte sample misreads ordinary non-ASCII source

### Why the Tail Is Trimmed Forwards

The structured data that follows the JavaScript is not always dense binary. Bun
interleaves printable bytes into its metadata, so the trailing region can sit
around 60% non-text while ordinary source sits under 10%. A backwards window
scan can therefore only ever land within one window of the true boundary, and
some compiled modules legitimately contain NUL bytes, so a NUL terminator is
not a reliable stop either.

`unbuned` instead scans *forwards* from the last module header, which is known
to be text, and stops where the density rises.

Clamping that result to the statistical cap is not good enough on its own. The
cap lands on a chunk boundary, and the chunk that trips the threshold usually
*begins* with real source and ends with the blob, so the clamp throws that
source away. `unbuned` therefore distinguishes two cases. If a binary window
was located before the cap, the boundary is settled there and refined to the
exact code unit. If none was, the cap is sitting inside source, and the
boundary is the first non-text code unit after it. Either way the result is a
code-unit boundary, never a window boundary, and a trailing sweep removes any
blob that rode along with it.

The practical benefit is that the output ends where the source ends. On
`amp.exe` this recovered the final `export default b3n();` that a cap-aligned
boundary cut mid-token, and the bundle now parses under `node --check`. The
practical cost is bounded: when a bundle genuinely ends on a long run of
control characters, the boundary can land a few bytes early.

---

## Use Cases

- **Reverse Engineering:** understand how a Bun application works without building a full decompiler first
- **Security Research:** inspect shipped Bun executables for risky logic, secrets, or attack surface
- **Malware Analysis:** peel back Bun-packed droppers, loaders, or suspicious tooling
- **Code Recovery:** recover source when the original project is gone but the executable survives
- **Learning:** study how real Bun apps package code, dependencies, and runtime behavior
- **CTF / Challenge Work:** speed up bundle extraction during time-boxed reversing tasks

---

## Requirements

- Python 3.6 or higher
- No external dependencies

---

## Limitations

- Extracts bundled JavaScript and embedded assets, not native modules
- Module and asset names are the paths the bundler recorded, so a hashed
  `chunk-9fxe9jf7.js` stays hashed and the original import graph is not
  recovered
- Original sources only exist when the build embedded source maps, and
  what comes back is the pre-bundle text, not the original repository
- When a binary ships no readable module graph, filenames fall back to being
  inferred from content
- Module headers are found by anchoring to line starts, so a `// @bun` line that
  sits inside a template literal can be mistaken for a boundary. This never
  corrupts the concatenated `.js`, which stays a single correct stream, but it
  can produce a bad slice in `--modules`. Telling the two apart properly needs
  JavaScript-level string tracking, so `unbuned` does not guess: on builds like
  the Amp CLI, cross-check `--modules` against the module graph, which is
  authoritative
- `--format` reformats layout only; it never renames, reorders, or rewrites code
- Very long single tokens, and huge or deeply nested template interpolations,
  stay on one line
- JSC bytecode is dumped raw, not decompiled
- The end of the JavaScript region is found statistically and then snapped to
  a code-unit boundary, so it can still land a few bytes early when a bundle
  ends on a run of control characters
- Some obfuscated code will still require manual analysis

---

## Contributing

Contributions are welcome, especially around:

- more fixture coverage
- JSC bytecode analysis
- better boundary heuristics
- more formatter layout rules
- additional real-world Bun samples

Run the tests with:

```bash
python -m unittest discover -s tests -v
```

Bug reports, PRs, and extraction results are all useful.

---

## Ethical Use

This tool is meant for legitimate reverse engineering, malware analysis, security research, learning, and recovery work. Respect licenses, contracts, and local law. Use it responsibly.

---

## Related Projects

- [asar](https://github.com/electron/asar) - Extract Electron `app.asar` archives
- [pkg](https://github.com/vercel/pkg) - Package Node.js apps into executables
- [nexe](https://github.com/nexe/nexe) - Create standalone Node.js executables

---

<div align="center">

**Built for people who would rather read the Bun app than speculate about it**

[Star this repo](https://github.com/vibheksoni/unbuned) if you find it useful.

</div>

---

## License

MIT License - see [LICENSE](LICENSE) for details.

---

## Author

[vibheksoni](https://github.com/vibheksoni)

If this repo helps you crack open a Bun executable faster, that is exactly what it was built for.

Currently open to work. If you're looking for someone with security research, reverse engineering, malware analysis, or full-stack development experience, hit me up.

- X/Twitter: [@ImVibhek](https://x.com/ImVibhek)
- Website: [vibheksoni.com](https://vibheksoni.com/)
- Security Blog: [opendoors.wtf](https://opendoors.wtf/)
- GitHub: [vibheksoni](https://github.com/vibheksoni)

---

_Remember: with great power comes great responsibility. Use this tool ethically and legally._
