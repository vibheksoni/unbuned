<div align="center">

<img src="assets/unbuned.png" alt="unbuned logo" width="200"/>

# unbuned

**Extract JavaScript from Bun-compiled executables**

The easiest way to pull readable JavaScript out of Bun executables for reverse engineering, malware analysis, security research, and code recovery.

[![Python](https://img.shields.io/badge/Python-3.6+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Platforms](https://img.shields.io/badge/Platforms-Windows%20PE%20%7C%20macOS%20Mach--O-lightgrey.svg)](https://github.com/vibheksoni/unbuned)
[![Dependencies](https://img.shields.io/badge/Dependencies-None-success.svg)](https://www.python.org/downloads/)
[![Stars](https://img.shields.io/github/stars/vibheksoni/unbuned?style=social)](https://github.com/vibheksoni/unbuned/stargazers)
[![Forks](https://img.shields.io/github/forks/vibheksoni/unbuned?style=social)](https://github.com/vibheksoni/unbuned/forks)

[Why It Exists](#why-it-exists) | [Features](#features) | [Usage](#usage) | [Real-World Samples](#real-world-samples) | [How It Works](#how-it-works)

</div>

---

## What is unbuned?

**unbuned** is a zero-dependency Python extractor for Bun-compiled executables. It locates the embedded Bun bundle, strips the binary noise around it, and writes clean JavaScript back to disk.

If you want to reverse engineer a Bun CLI, inspect a suspicious Bun-packed binary, recover lost app logic, or study how a production Bun app is bundled, this is the tool.

## Why It Exists

I built `unbuned` for the exact moment where a Bun executable lands on disk and you do not want a full reverse-engineering project just to see the application logic. Most of the time, the thing you actually need is the JavaScript bundle, fast, with as little friction as possible.

That is the whole point of this repo: one Python file, no dependencies, no install ceremony, and output you can immediately grep, diff, beautify, or audit.

---

## Installation

```bash
git clone https://github.com/vibheksoni/unbuned.git
cd unbuned
```

No dependencies required. Just Python 3.6+.

---

## Features

- Extract JavaScript from Bun-compiled executables with pure Python 3.6+
- Parse Windows PE `.bun` sections directly
- Parse macOS Mach-O `__BUN,__bun` sections directly
- Fall back to Bun magic-byte discovery when section metadata is unavailable
- Detect JavaScript boundaries and strip binary contamination
- Refine extraction boundaries with `debugId`, `sourceMappingURL`, and closure markers
- Save clean UTF-8 JavaScript to `output/<name>/<name>.js`
- Stay readable, hackable, and dependency-free

## Supported Targets

`unbuned` currently handles:

- Windows PE Bun executables
- macOS thin Mach-O Bun executables
- Other Bun-packed binaries when the bundle can be located through the Bun magic-byte fallback

It does **not** yet implement native ELF section parsing or FAT/universal Mach-O extraction.

---

## Usage

```bash
python unbuned.py <path-to-bun-executable>
```

### Example

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

This repo includes extracted bundles from real Bun applications so people can immediately see what `unbuned` pulls out of production binaries.

### 1. Factory Droid CLI (`droid.exe`)

- **Extracted:** 14.1 MB of JavaScript
- **Contains:** agent logic, model configuration, application workflows
- **Location:** `output/droid/droid.js`

### 2. Claude Code (`claude.exe`)

- **Extracted:** 10.9 MB of JavaScript
- **Contains:** Anthropic SDK code, tool definitions, CLI internals
- **Location:** `output/claude/claude.js`

### 3. Freebuff (`freebuff`)

- **Extracted:** 11.4 MB of JavaScript
- **Contains:** telemetry events, model routing, product and CLI flows
- **Location:** `output/freebuff/freebuff.js`

These samples are the proof point. `unbuned` is built to rip useful code out of real shipped Bun executables, not just synthetic fixtures.

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

---

## How It Works

`unbuned` uses a multi-stage extraction process:

1. **Format Detection:** detect the executable container and choose the best extraction path.
2. **Section Discovery:** locate `.bun` in PE files or `__BUN,__bun` in thin Mach-O files.
3. **Magic-Byte Fallback:** search for the Bun bundle marker when section metadata is not enough.
4. **JavaScript Marker Detection:** find the `// @bun` marker that denotes the bundle start.
5. **Boundary Detection:** measure non-printable byte ratios to find the transition from code to binary data.
6. **Boundary Refinement:** use markers like `//# debugId=`, `//# sourceMappingURL=`, and `})();` to stop cleanly.
7. **Extraction:** decode the recovered JavaScript and write it to `output/<name>/<name>.js`.

### Boundary Detection Algorithm

The extractor uses a practical heuristic tuned for real Bun payloads:

- analyzes chunks for non-printable character ratios
- looks for source map comments (`//# sourceMappingURL=`)
- detects debug markers (`//# debugId=`)
- identifies IIFE closures (`})();`)
- validates binary-looking data after potential boundaries

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

- Extracts bundled JavaScript only, not native modules or assets
- Native ELF parsing is not implemented yet
- FAT/universal Mach-O binaries are not supported yet
- Minified code remains minified
- Some obfuscated code will still require manual analysis

---

## Contributing

Contributions are welcome, especially around:

- ELF support
- more fixture coverage
- better boundary heuristics
- additional real-world Bun samples

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
