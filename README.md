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
| `-a`, `--all` | Dump everything: modules, assets, manifests and bytecode |
| `-m`, `--modules` | Also write one file per compiled module plus `manifest.json` |
| `--assets` | Also extract Zstandard-embedded non-JavaScript assets |
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
- Extract Zstandard-embedded non-JavaScript assets and name them from the graph
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
compared, module by module, and the result still passes `node --check`.

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
untouched, and the result still passes `node --check`.

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

Use `--bytecode` to write the bytecode regions to disk if you want to analyse
them. Be aware these are large; on `claude.exe` the head region alone is
about 109 MB.

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

Extracted bundles from real Bun applications are committed in [`output/`](output/)
so you can see exactly what `unbuned` pulls out of production binaries before
running it yourself.

### 1. Claude Code (`claude.exe`) in full

The most complete run in the repo, produced by one command:

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

- [`output/claude/full/claude.js`](output/claude/full/claude.js) - the whole
  bundle, beautified
- [`output/claude/full/manifest.json`](output/claude/full/manifest.json) - every
  module with its real path, offset, size and format, plus the decoded module
  graph
- [`output/claude/full/assets/`](output/claude/full/assets/) - all 138 embedded
  assets under their real names

The asset directory is the clearest demonstration of the module graph at work.
Bun stores each one as a compressed, content-hashed frame with a useless name.
Here they are with the name the compiler recorded:

```text
0000-chart.umd.min.js                    0008-plugin-eval-quickref-5681d66c.md
0002-SKILL-f2840619.md                   0010-claude-code.d.ts-e37ccc4a.ts
0004-template.html-fb05d44d.html         0014-mermaid.min.js
```

The per-module `modules/` directory and the raw bytecode blobs are not
committed: 2,156 small files and 104 MB of unreadable bytecode that no one can
review in a diff. Both regenerate with the command above, and `manifest.json`
records the full module list either way.

### 2. Factory Droid CLI (`droid.exe`)

- **Extracted:** 14.1 MB of JavaScript
- **Contains:** agent logic, model configuration, application workflows
- **Location:** [`output/droid/droid.js`](output/droid/droid.js)

### 3. Freebuff (`freebuff`)

- **Extracted:** 11.4 MB of JavaScript
- **Contains:** telemetry events, model routing, product and CLI flows
- **Location:** [`output/freebuff/freebuff.js`](output/freebuff/freebuff.js)

These samples are the proof point. `unbuned` is built to rip useful code out of
real shipped Bun executables, not just synthetic fixtures.

## Why These Samples Matter

Reverse-engineering tools live or die on credibility. Including extracted bundles from Droid, Claude Code, and Freebuff makes the value concrete:

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

If you want to judge the extractor before running it yourself, open the sample outputs in [`output/`](output/) and search through them. The repo is meant to prove the claim, not just make it.

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

### Boundary Detection Algorithm

The extractor uses a practical heuristic tuned for real Bun payloads:

- analyzes chunks for non-printable character ratios
- looks for source map comments (`//# sourceMappingURL=`)
- detects debug markers (`//# debugId=`)
- identifies IIFE closures (`})();`)
- validates binary-looking data after potential boundaries
- byte classification runs through `bytes.translate`, so a 150 MB section is
  scanned inside CPython's C layer rather than a Python-level loop

### Why the Tail Is Trimmed Forwards

The structured data that follows the JavaScript is not always dense binary. Bun
interleaves printable bytes into its metadata, so the trailing region can sit
around 60% non-text while ordinary source sits under 10%. A backwards window
scan can therefore only ever land within one window of the true boundary, and
some compiled modules legitimately contain NUL bytes, so a NUL terminator is
not a reliable stop either.

`unbuned` instead scans *forwards* from the last module header, which is known
to be text, and stops where the density rises. Scanning forwards from a text
anchor can only under-trim, never drop real source. The practical cost is that
the final partial line of the last module may be cut; the practical benefit is
that no bytecode ever ends up in your output.

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
- When a binary ships no readable module graph, filenames fall back to being
  inferred from content
- `--format` reformats layout only; it never renames, reorders, or rewrites code
- Very long single tokens, and huge or deeply nested template interpolations,
  stay on one line
- JSC bytecode is dumped raw, not decompiled
- The end of the JavaScript region is found statistically, so the final
  partial line of the last module can be trimmed
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
