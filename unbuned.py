#!/usr/bin/env python3
"""
unbuned - extract JavaScript from Bun-compiled executables.

Zero-dependency, pure-Python 3.6+ extractor for Windows PE, macOS Mach-O
(thin and universal) and Linux ELF executables produced by
`bun build --compile`.

Design notes
------------
* Output is written as raw bytes. The previous implementation opened the
  destination in text mode, which silently rewrote every ``\\n`` as ``\\r\\n``
  on Windows and inflated every extraction by tens of kilobytes.
* The end of the JavaScript region is found structurally, not statistically.
  Bun stores compiled modules NUL-delimited inside the ``.bun`` section, so a
  module header is only accepted when it is preceded by NUL (or the start of
  the region) and occupies a whole line. That rejects markers that appear
  inside string literals or comments.
* Byte classification is vectorised through ``bytes.translate`` so a 150 MB
  section is scanned in C rather than in a Python-level loop.
* The input file is memory-mapped instead of read whole, so a 250 MB
  executable costs no resident copy.
"""

import argparse
import collections
import json
import mmap
import os
import re
import struct
import sys
from pathlib import Path

BUN_MAGIC = b'\xe5\x02\x80\x01'
BUN_TRAILER = b'\n---- Bun! ----\n'

# Bun's standalone module graph is serialised as one flat blob that ends with
# the trailer, immediately preceded by a 32 byte `Offsets` struct
# (`#[repr(C)] { byte_count: usize, modules_ptr: {u32,u32}, entry_point_id: u32,
# compile_exec_argv_ptr: {u32,u32}, flags: u32 }`). Every pointer in that struct
# and in the file table it describes is relative to the section start *plus* the
# section's own eight byte length header, which is why the arithmetic below
# adds a constant instead of using the values raw.
GRAPH_HEADER_SIZE = 32
GRAPH_POINTER_BASE = 8
GRAPH_FILE_RECORD_SIZE = 52
GRAPH_FLAG_SOURCE_HASHES = 1 << 5
GRAPH_FLAG_BUILTIN_BYTECODE = 1 << 6
GRAPH_FLAG_BYTECODE_STRING_TABLE = 1 << 7
GRAPH_FLAG_STARTUP_MODULE_COUNT = 1 << 8
GRAPH_FLAG_MODULE_INFO_STRING_TABLE = 1 << 9

FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_SEGMENT = 0x1
LC_SEGMENT_64 = 0x19
MH_MAGIC = 0xFEEDFACE
MH_MAGIC_64 = 0xFEEDFACF
MH_CIGAM = 0xCEFAEDFE
MH_CIGAM_64 = 0xCFFAEDFE
ELF_MAGIC = b'\x7fELF'
SHT_NOBITS = 8

PE_SECTION_NAME = '.bun'
MACHO_SEGMENT_NAME = '__BUN'
MACHO_SECTION_NAME = '__bun'
ELF_SECTION_NAME = '.bun'

BUN_MARKER = b'// @bun'

# A module header is a whole line of `// @bun` plus optional `@tag` tokens.
# Bun writes one header per compiled module, NUL-delimited, so the caller
# anchors it at the start of the region or immediately after a NUL separator
# and this pattern rejects markers that sit inside a string or a comment.
MODULE_HEADER_RE = re.compile(rb'// @bun(?: [@\-a-zA-Z0-9_]+)*[ \t]*\r?\n')

# Backwards scan window and non-text ratio used to find the last real module
# boundary. 256 bytes is large enough that ordinary UTF-8 source cannot trip it
# and small enough to land on the exact boundary byte.
TRIM_WINDOW = 256
TRIM_THRESHOLD = 0.5

# Byte -> 1 when the byte cannot appear in plain UTF-8 source text.
# Kept as a module-level constant so it is built once.
NON_TEXT_TABLE = bytes(
    0 if (32 <= value < 127 or value in (9, 10, 13)) else 1
    for value in range(256)
)

BunModule = collections.namedtuple(
    'BunModule',
    ['index', 'offset', 'size', 'header', 'cjs', 'bytecode', 'slug'],
)

Section = collections.namedtuple(
    'Section',
    ['container', 'name', 'file_offset', 'size'],
)

GraphFile = collections.namedtuple(
    'GraphFile',
    [
        'index',
        'name',
        'offset',
        'length',
        'encoding',
        'loader',
        'module_format',
        'side',
        'bytecode_offset',
        'bytecode_length',
        'module_info_offset',
        'module_info_length',
        'sourcemap_offset',
        'sourcemap_length',
    ],
)

ModuleGraph = collections.namedtuple(
    'ModuleGraph',
    ['files', 'entry_point_id', 'startup_module_count', 'flags', 'byte_count'],
)

GraphSource = collections.namedtuple(
    'GraphSource',
    ['module_index', 'module_name', 'path', 'offset', 'length'],
)

GRAPH_LOADER_NAMES = {
    0: 'js',
    1: 'jsx',
    2: 'ts',
    3: 'tsx',
    4: 'json',
    5: 'file',
    6: 'wasm',
    7: 'napi',
    8: 'base64',
    9: 'dataurl',
    10: 'text',
    11: 'toml',
    12: 'sqlite',
    13: 'binary',
    14: 'css',
    15: 'html',
}

GRAPH_FORMAT_NAMES = {0: 'none', 1: 'esm', 2: 'cjs'}
GRAPH_SIDE_NAMES = {0: 'server', 1: 'client'}
GRAPH_ENCODING_NAMES = {0: 'binary', 1: 'latin1', 2: 'utf16'}
GRAPH_FLAG_DEFINITIONS = (
    (1 << 0, 'disable_default_env_files'),
    (1 << 1, 'disable_autoload_bunfig'),
    (1 << 2, 'disable_autoload_tsconfig'),
    (1 << 3, 'disable_autoload_package_json'),
    (1 << 4, 'source_text_contiguous'),
    (1 << 5, 'has_source_hashes'),
    (1 << 6, 'has_builtin_bytecode'),
    (1 << 7, 'has_bytecode_string_table'),
    (1 << 8, 'has_startup_module_count'),
    (1 << 9, 'has_module_info_string_table'),
    (1 << 10, 'cross_compiled_bytecode'),
)

# Bounds a single embedded name so a corrupt length cannot make the reader scan
# a whole section for a terminator it will never find.
GRAPH_NAME_LIMIT = 512

# Bun appends a content hash to the recorded name, which glues itself to the
# real extension: `template.html-fb05d44d.txt.zst` is a `template.html` asset.
# This pattern recovers the extension the hash was appended after.
GRAPH_HASHED_EXTENSION_RE = re.compile(r'\.([A-Za-z0-9]{1,8})-[0-9A-Fa-f]{8}$')

# A source map starts with the source count and the VLQ mapping length,
# then holds one `{offset, length}` pointer per source path and one per
# source text, then the VLQ blob, then every path in order followed by
# every source text Zstandard compressed.
SOURCE_MAP_HEADER_SIZE = 8
SOURCE_MAP_POINTER_SIZE = 8

# Bounds the declared source count so a corrupt header is rejected on the
# header's own terms rather than after allocating for billions of pointers.
SOURCE_MAP_SOURCE_LIMIT = 1 << 20

# Characters that are illegal in a Windows path component, plus control
# bytes, replaced when a recorded source path is turned into an output path.
SOURCE_PATH_UNSAFE_RE = re.compile(r'[\x00-\x1f<>:"|?*]')

# Loaders whose files are JavaScript, TypeScript or JSX source. Everything
# else in the graph is an asset the executable ships alongside the bundle.
GRAPH_CODE_LOADERS = frozenset((0, 1, 2, 3))

# Magic bytes that identify a native executable format. Bun records a helper
# with no extension when the bundler could not infer one, which leaves a
# trailing dot as the only clue in the name.
# Bun gives every file it embeds an `.asset` extension when the original one
# is not part of the bundle, which leaves the real extension stranded inside
# the recorded stem as in `authentication.md-kckwz2e2.asset`.
GRAPH_PLACEHOLDER_EXTENSION = '.asset'

ASSET_KIND_BY_EXTENSION = {
    '.md': 'markdown',
    '.markdown': 'markdown',
    '.html': 'html',
    '.htm': 'html',
    '.json': 'json',
    '.js': 'script',
    '.mjs': 'script',
    '.cjs': 'script',
    '.ts': 'script',
    '.tsx': 'script',
    '.jsx': 'script',
    '.py': 'script',
    '.sh': 'script',
    '.css': 'text',
    '.yaml': 'text',
    '.yml': 'text',
    '.toml': 'text',
}

NATIVE_FORMAT_EXTENSIONS = (
    (b'MZ', '.exe'),
    (b'\x7fELF', '.so'),
    (b'\xcf\xfa\xed\xfe', '.dylib'),
    (b'\xce\xfa\xed\xfe', '.dylib'),
    (b'\xca\xfe\xba\xbe', '.dylib'),
)


def read_module_graph(section):
    """
    Parse Bun's standalone module graph out of a bundle section.

    Bun writes every embedded file into one flat blob whose final bytes are a
    32 byte `Offsets` struct followed by the `\\n---- Bun! ----\\n` trailer.
    `Offsets` points at a table of 52 byte `CompiledModuleGraphFile` records,
    each holding six `{offset, length}` pointers (name, contents, sourcemap,
    bytecode, module_info, bytecode_origin_path) plus four single byte enums
    (encoding, loader, module_format, side). Records are emitted in load order:
    the entry point's static imports first, then dynamic imports breadth first.
    Reading this table is what gives every module and asset its real name, since
    the bundled JavaScript itself only carries hashed `// @bun` chunk names.

    Every pointer in the blob is relative to the section start *plus* the
    section's own eight byte length header, so the values are shifted by
    `GRAPH_POINTER_BASE` before use. Offsets in the returned records are
    therefore absolute within `section`.

    Args:
        section (bytes|mmap): The whole container section, header included.

    Returns:
        ModuleGraph|None: The parsed graph, or None when the section carries no
            readable module graph.
    """
    trailer = section.rfind(BUN_TRAILER)
    if trailer < GRAPH_HEADER_SIZE:
        return None

    header = trailer - GRAPH_HEADER_SIZE
    try:
        byte_count, modules_offset, modules_length, entry_point_id, argv_offset, _argv_length, flags = \
            struct.unpack_from('<QIIIIII', section, header)
    except struct.error:
        return None

    if byte_count + GRAPH_POINTER_BASE != header:
        return None
    if modules_length < GRAPH_FILE_RECORD_SIZE or modules_length % GRAPH_FILE_RECORD_SIZE:
        return None

    table = modules_offset + GRAPH_POINTER_BASE
    if table < 0 or table + modules_length > len(section):
        return None

    count = modules_length // GRAPH_FILE_RECORD_SIZE
    files = []
    for index in range(count):
        at = table + (index * GRAPH_FILE_RECORD_SIZE)
        try:
            name_offset, name_length = struct.unpack_from('<II', section, at)
            content_offset, content_length = struct.unpack_from('<II', section, at + 8)
            sourcemap_offset, sourcemap_length = struct.unpack_from('<II', section, at + 16)
            bytecode_offset, bytecode_length = struct.unpack_from('<II', section, at + 24)
            module_info_offset, module_info_length = struct.unpack_from('<II', section, at + 32)
            encoding = section[at + 48]
            loader = section[at + 49]
            module_format = section[at + 50]
            side = section[at + 51]
        except (struct.error, IndexError):
            break

        name = read_graph_string(section, name_offset, name_length)
        files.append(
            GraphFile(
                index=index,
                name=name,
                offset=content_offset + GRAPH_POINTER_BASE,
                length=content_length,
                encoding=encoding,
                loader=loader,
                module_format=module_format,
                side=side,
                bytecode_offset=bytecode_offset + GRAPH_POINTER_BASE,
                bytecode_length=bytecode_length,
                module_info_offset=module_info_offset + GRAPH_POINTER_BASE,
                module_info_length=module_info_length,
                sourcemap_offset=sourcemap_offset + GRAPH_POINTER_BASE,
                sourcemap_length=sourcemap_length,
            )
        )

    startup_module_count = read_startup_module_count(
        section, table + modules_length, count, flags
    )

    return ModuleGraph(
        files=files,
        entry_point_id=entry_point_id,
        startup_module_count=startup_module_count,
        flags=flags,
        byte_count=byte_count,
    )


def read_graph_string(section, offset, length):
    """
    Read one NUL-terminated embedded name out of a module graph.

    Args:
        section (bytes|mmap): The whole container section.
        offset (int): Raw pointer value from the graph record.
        length (int): Raw length from the graph record; 0 means no name.

    Returns:
        bytes: The name without its terminator, or b'' when absent or invalid.
    """
    if not length:
        return b''
    start = offset + GRAPH_POINTER_BASE
    if start < 0 or start >= len(section):
        return b''
    stop = section.find(b'\x00', start, start + min(length + 1, GRAPH_NAME_LIMIT + 1))
    if stop < 0:
        return b''
    return bytes(section[start:stop])


def read_startup_module_count(section, table_end, count, flags):
    """
    Read how many leading modules form the entry point's static import closure.

    The compiler appends the source hash table, then the builtin bytecode table,
    then the optional bytecode string table pointer, and only then the startup
    module count, so the count sits a fixed distance past the module table. The
    walk is defensive because later Bun releases append further tables that the
    documented layout does not describe.

    Args:
        section (bytes|mmap): The whole container section.
        table_end (int): Absolute section offset just past the module table.
        count (int): Number of records in the module table.
        flags (int): The graph flags word.

    Returns:
        int: The startup module count, or 0 when it cannot be located.
    """
    if not flags & GRAPH_FLAG_STARTUP_MODULE_COUNT:
        return 0

    cursor = table_end + (count * 4)
    if cursor + 4 > len(section):
        return 0

    try:
        builtin_count = struct.unpack_from('<I', section, cursor)[0]
    except struct.error:
        return 0

    cursor += 4 + (builtin_count * 12)
    if flags & GRAPH_FLAG_BYTECODE_STRING_TABLE:
        cursor += 8
    if cursor + 4 > len(section):
        return 0

    try:
        startup = struct.unpack_from('<I', section, cursor)[0]
    except struct.error:
        return 0
    if startup > count:
        return 0
    return startup


def read_graph_files(section):
    """
    Parse the embedded file table out of a bundle section.

    Args:
        section (bytes|mmap): The whole container section, header included.

    Returns:
        list[GraphFile]: Every embedded file in load order, empty when the
            section carries no readable module graph.
    """
    graph = read_module_graph(section)
    return graph.files if graph is not None else []


def read_source_map(blob):
    """
    Parse one standalone source map into its source paths and content ranges.

    The bundler emits a JSON source map, but Bun never embeds that JSON. It
    walks the map once while compiling and writes a compact record instead: the
    source count, the length of the raw VLQ mapping, then one `{offset, length}`
    pointer per source path followed by one per source text, then the VLQ blob,
    then a string payload holding every path in order followed by every source
    text Zstandard compressed. Every offset is absolute within `blob`, so the
    first path has to begin exactly where the pointers and the VLQ blob end.
    That anchor is what separates a real record from a run of bytes that merely
    starts with two plausible integers.

    Args:
        blob (bytes|mmap): A graph record's sourcemap region, header included.

    Returns:
        tuple|None: `(paths, contents)` where `paths` is a list of str and
            `contents` a list of `(offset, length)` pairs into `blob`, or None
            when the record holds no sources or does not parse.
    """
    if len(blob) < SOURCE_MAP_HEADER_SIZE:
        return None

    count, mapping_length = struct.unpack_from('<II', blob, 0)
    if count == 0 or count > SOURCE_MAP_SOURCE_LIMIT:
        return None

    paths_at = SOURCE_MAP_HEADER_SIZE
    contents_at = paths_at + SOURCE_MAP_POINTER_SIZE * count
    payload_at = contents_at + SOURCE_MAP_POINTER_SIZE * count + mapping_length
    if payload_at > len(blob):
        return None
    if struct.unpack_from('<I', blob, paths_at)[0] != payload_at:
        return None

    paths = []
    contents = []
    for index in range(count):
        at = paths_at + SOURCE_MAP_POINTER_SIZE * index
        start, length = struct.unpack_from('<II', blob, at)
        if start < payload_at or start + length > len(blob):
            return None
        paths.append(bytes(blob[start:start + length]).decode('utf-8', 'replace'))
    for index in range(count):
        at = contents_at + SOURCE_MAP_POINTER_SIZE * index
        start, length = struct.unpack_from('<II', blob, at)
        if start + length > len(blob):
            return None
        contents.append((start, length))

    return paths, contents


def read_graph_sources(section, graph):
    """
    Collect every original source file stored in the graph's source maps.

    A source map keeps the pre-bundle text of every file that went into a
    chunk, so this is the only way to recover the original TypeScript rather
    than the flattened bundle. The same file can back several chunks, so
    callers are expected to key on the path rather than assume uniqueness.

    Args:
        section (bytes|mmap): The whole container section, header included.
        graph (ModuleGraph|None): The parsed module graph.

    Returns:
        list[GraphSource]: One entry per embedded source file, in graph order.
    """
    if graph is None:
        return []

    sources = []
    for entry in graph.files:
        if not entry.sourcemap_offset or not entry.sourcemap_length:
            continue
        blob = section[entry.sourcemap_offset:entry.sourcemap_offset + entry.sourcemap_length]
        parsed = read_source_map(blob)
        if parsed is None:
            continue
        paths, contents = parsed
        for path, (offset, length) in zip(paths, contents):
            sources.append(GraphSource(
                module_index=entry.index,
                module_name=entry.name.decode('utf-8', 'replace'),
                path=path,
                offset=entry.sourcemap_offset + offset,
                length=length,
            ))
    return sources


def source_output_path(path):
    """
    Reduce a bundler-relative source path to a safe relative output path.

    The bundler records each path relative to the file that imported it, so a
    shared dependency arrives as `../../node_modules/...`. Those leading `..`
    segments only describe where the importer sat, so dropping them is what
    turns the record back into the real `node_modules/...` path. Characters
    Windows rejects are replaced rather than dropped, and any component that
    cannot survive is discarded so nothing can escape the output directory.

    Args:
        path (str): The path exactly as the source map records it.

    Returns:
        str|None: A relative path safe to join onto an output directory, or
            None when nothing usable survives.
    """
    parts = []
    for part in path.replace('\\', '/').split('/'):
        if part in ('', '.', '..'):
            continue
        cleaned = SOURCE_PATH_UNSAFE_RE.sub('-', part).strip(' .')
        if not cleaned:
            continue
        parts.append(cleaned)
    if not parts:
        return None
    return '/'.join(parts)


def graph_flag_names(flags):
    """
    Expand a graph flags word into the flag names the compiler defines.

    Args:
        flags (int): The graph flags word.

    Returns:
        list[str]: Names of every flag the binary sets.
    """
    return [name for bit, name in GRAPH_FLAG_DEFINITIONS if flags & bit]


def _slug_from_graph_name(name):
    """
    Reduce a graph path to a filename stem safe for the filesystem.

    Args:
        name (bytes): The embedded path, such as `B:/~BUN/root/chunk-1a2b.js`.

    Returns:
        str: The stem, with separators and characters Windows dislikes replaced.
    """
    text = name.decode('utf-8', 'replace').replace('\\', '/').rsplit('/', 1)[-1]
    for extension in ('.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'):
        if text.lower().endswith(extension):
            text = text[:-len(extension)]
            break
    slug = _SLUG_STRIP_RE.sub(b'-', text.encode('utf-8', 'replace')).strip(b'-')
    return slug.decode('ascii', 'ignore') or 'module'


def module_graph_index(extraction):
    """
    Build a region offset to graph record index for the whole module graph.

    Modules are located by scanning for `// @bun` headers, while the graph
    records where each file's source text actually sits. A record's offset is
    already absolute within the section, so the only conversion needed to get a
    region offset is subtracting the marker offset. That correspondence is exact
    rather than approximate, which is why this is a dict lookup and not a
    nearest-neighbour guess.

    Args:
        extraction (Extraction): Completed extraction.

    Returns:
        dict: Maps a module's region offset to its `GraphFile`.
    """
    graph = extraction.graph
    if graph is None:
        return {}

    index = {}
    for entry in graph.files:
        if entry.name and entry.length:
            index.setdefault(entry.offset - extraction.js_offset, entry)
    return index


def module_graph_names(extraction):
    """
    Map each module's region offset to a filename stem from the module graph.

    Args:
        extraction (Extraction): Completed extraction.

    Returns:
        dict: Maps a module's region offset to a filename stem.
    """
    index = module_graph_index(extraction)
    if not index:
        return {}

    names = {}
    for module in extraction.modules():
        entry = index.get(module.offset)
        if entry is not None:
            names[module.offset] = _slug_from_graph_name(entry.name)
    return names


def module_graph_entry_name(extraction, region_offset):
    """
    Recover the full embedded path for the module at a region offset.

    Args:
        extraction (Extraction): Completed extraction.
        region_offset (int): Offset of the module within the JavaScript region.

    Returns:
        bytes|None: The graph's own path for that module, or None.
    """
    entry = module_graph_index(extraction).get(region_offset)
    return entry.name if entry is not None else None


def is_binary_byte(byte):
    """
    Report whether a single byte cannot appear in plain source text.

    Args:
        byte (int): Byte value to classify.

    Returns:
        bool: True when the byte is binary rather than text.
    """
    return byte > 127 or (byte < 32 and byte not in [9, 10, 13])


def non_text_ratio(buf):
    """
    Compute the fraction of bytes in a buffer that are not source text.

    Uses `bytes.translate` so the scan runs inside CPython's C layer instead
    of a per-byte Python loop, which is roughly forty times faster on large
    sections.

    Args:
        buf (bytes|mmap): Buffer to classify.

    Returns:
        float: Ratio of non-text bytes, 0.0 for an empty buffer.
    """
    if not len(buf):
        return 0.0
    return buf.translate(NON_TEXT_TABLE).count(1) / len(buf)


def find_bun_section(data, pe_offset):
    """
    Locate the `.bun` section in a PE executable.

    Args:
        data (bytes|mmap): Raw executable data.
        pe_offset (int): Offset of the PE signature.

    Returns:
        tuple: (start_offset, size) or (None, None) if not found.
    """
    if pe_offset + 24 > len(data):
        return None, None

    num_sections = struct.unpack('<H', data[pe_offset+6:pe_offset+8])[0]
    optional_header_size = struct.unpack('<H', data[pe_offset+20:pe_offset+22])[0]
    section_table_offset = pe_offset + 24 + optional_header_size

    for i in range(num_sections):
        section_offset = section_table_offset + (i * 40)
        if section_offset + 40 > len(data):
            return None, None

        section_name = data[section_offset:section_offset+8].rstrip(b'\x00').decode('ascii', errors='ignore')

        if section_name == PE_SECTION_NAME:
            virtual_size = struct.unpack('<I', data[section_offset+8:section_offset+12])[0]
            raw_size = struct.unpack('<I', data[section_offset+16:section_offset+20])[0]
            raw_offset = struct.unpack('<I', data[section_offset+20:section_offset+24])[0]
            section_size = min(virtual_size, raw_size)
            section_end = raw_offset + section_size
            if section_size == 0 or section_end > len(data):
                return None, None

            return raw_offset, section_size

    return None, None


def find_elf_bun_section(data):
    """
    Locate the `.bun` section in an ELF executable.

    Handles 32-bit and 64-bit objects in either endianness by honouring
    `e_ident[EI_DATA]` rather than assuming little-endian output.

    Args:
        data (bytes|mmap): Raw executable data.

    Returns:
        tuple: (start_offset, size) or (None, None) if not found.
    """
    if len(data) < 64 or data[:4] != ELF_MAGIC:
        return None, None

    is_64_bit = data[4] == 2
    endian = '<' if data[5] == 1 else '>'

    if is_64_bit:
        if len(data) < 64:
            return None, None
        e_shoff, = struct.unpack_from(endian + 'Q', data, 0x28)
        e_shentsize, e_shnum, e_shstrndx = struct.unpack_from(endian + 'HHH', data, 0x3A)
    else:
        if len(data) < 52:
            return None, None
        e_shoff, = struct.unpack_from(endian + 'I', data, 0x20)
        e_shentsize, e_shnum, e_shstrndx = struct.unpack_from(endian + 'HHH', data, 0x2E)

    if not e_shoff or not e_shnum or e_shoff + e_shnum * e_shentsize > len(data):
        return None, None

    if e_shstrndx >= e_shnum:
        return None, None

    strtab_offset, = struct.unpack_from(
        endian + ('Q' if is_64_bit else 'I'), data, e_shoff + e_shstrndx * e_shentsize + (0x18 if is_64_bit else 0x10)
    )

    for index in range(e_shnum):
        header = e_shoff + index * e_shentsize
        if is_64_bit:
            sh_name, = struct.unpack_from(endian + 'I', data, header)
            sh_type, = struct.unpack_from(endian + 'I', data, header + 4)
            sh_offset, sh_size = struct.unpack_from(endian + 'QQ', data, header + 0x18)
        else:
            sh_name, = struct.unpack_from(endian + 'I', data, header)
            sh_type, = struct.unpack_from(endian + 'I', data, header + 4)
            sh_offset, sh_size = struct.unpack_from(endian + 'II', data, header + 0x10)

        if sh_type == SHT_NOBITS or sh_size == 0:
            continue
        if sh_offset + sh_size > len(data):
            continue

        name = data[strtab_offset + sh_name:].split(b'\x00', 1)[0]
        if name == ELF_SECTION_NAME.encode('ascii'):
            return sh_offset, sh_size

    return None, None


def find_macho_bun_section(data):
    """
    Locate `__BUN,__bun` in a thin Mach-O executable.

    Args:
        data (bytes|mmap): Raw executable data.

    Returns:
        tuple: (start_offset, size, error_message)
    """
    if len(data) < 4:
        return None, None, "Error: Unsupported executable format"

    fat_magic = struct.unpack('>I', data[:4])[0]
    if fat_magic in (FAT_MAGIC, FAT_MAGIC_64):
        return None, None, "Error: FAT/universal Mach-O detected; use parse_fat_arches"

    magic = struct.unpack('<I', data[:4])[0]
    if magic == MH_MAGIC_64:
        is_64_bit = True
        header_size = 32
    elif magic == MH_MAGIC:
        is_64_bit = False
        header_size = 28
    else:
        return None, None, None

    if len(data) < header_size:
        return None, None, "Error: Invalid Mach-O header"

    ncmds = struct.unpack('<I', data[16:20])[0]
    sizeofcmds = struct.unpack('<I', data[20:24])[0]
    command_offset = header_size
    commands_end = command_offset + sizeofcmds

    if commands_end > len(data):
        return None, None, "Error: Invalid Mach-O load commands"

    for _ in range(ncmds):
        if command_offset + 8 > len(data):
            return None, None, "Error: Invalid Mach-O load command"

        cmd, cmdsize = struct.unpack('<II', data[command_offset:command_offset+8])
        if cmdsize < 8 or command_offset + cmdsize > len(data):
            return None, None, "Error: Invalid Mach-O load command"

        if is_64_bit and cmd == LC_SEGMENT_64:
            if cmdsize < 72:
                return None, None, "Error: Invalid Mach-O segment command"

            nsects = struct.unpack('<I', data[command_offset+64:command_offset+68])[0]
            section_offset = command_offset + 72
            section_size = 80
        elif not is_64_bit and cmd == LC_SEGMENT:
            if cmdsize < 56:
                return None, None, "Error: Invalid Mach-O segment command"

            nsects = struct.unpack('<I', data[command_offset+48:command_offset+52])[0]
            section_offset = command_offset + 56
            section_size = 68
        else:
            command_offset += cmdsize
            continue

        for index in range(nsects):
            current_offset = section_offset + (index * section_size)
            if current_offset + section_size > command_offset + cmdsize:
                return None, None, "Error: Invalid Mach-O section table"

            sectname = data[current_offset:current_offset+16].rstrip(b'\x00').decode('ascii', errors='ignore')
            segname = data[current_offset+16:current_offset+32].rstrip(b'\x00').decode('ascii', errors='ignore')

            if is_64_bit:
                size = struct.unpack('<Q', data[current_offset+40:current_offset+48])[0]
                file_offset = struct.unpack('<I', data[current_offset+48:current_offset+52])[0]
            else:
                size = struct.unpack('<I', data[current_offset+36:current_offset+40])[0]
                file_offset = struct.unpack('<I', data[current_offset+40:current_offset+44])[0]

            if sectname == MACHO_SECTION_NAME and segname == MACHO_SEGMENT_NAME:
                section_end = file_offset + size
                if size == 0 or section_end > len(data):
                    return None, None, "Error: Invalid __BUN,__bun section"

                return file_offset, size, None

        command_offset += cmdsize

    return None, None, "Error: Could not find __BUN,__bun section in Mach-O executable"


def parse_fat_arches(data):
    """
    Enumerate the architecture slices of a FAT/universal Mach-O binary.

    Args:
        data (bytes|mmap): Raw executable data.

    Returns:
        tuple: (list_of_slices, error_message) where each slice is
            (cputype, cpusubtype, offset, size).
    """
    if len(data) < 8:
        return None, "Error: Unsupported executable format"

    fat_magic = struct.unpack('>I', data[:4])[0]
    if fat_magic not in (FAT_MAGIC, FAT_MAGIC_64):
        return None, "Error: Not a FAT/universal Mach-O binary"

    nfat_arch, = struct.unpack('>I', data[4:8])
    is_64 = fat_magic == FAT_MAGIC_64
    entry_size = 32 if is_64 else 20

    if 8 + nfat_arch * entry_size > len(data):
        return None, "Error: Invalid FAT/universal Mach-O architecture table"

    slices = []
    for index in range(nfat_arch):
        base = 8 + index * entry_size
        cputype, cpusubtype = struct.unpack('>ii', data[base:base+8])
        if is_64:
            offset, size = struct.unpack('>QQ', data[base+8:base+24])
        else:
            offset, size = struct.unpack('>II', data[base+8:base+16])
        if size == 0 or offset + size > len(data):
            return None, "Error: Invalid FAT/universal Mach-O architecture slice"
        slices.append((cputype, cpusubtype, offset, size))

    if not slices:
        return None, "Error: FAT/universal Mach-O binary contains no architecture slices"

    return slices, None


def select_fat_slice(data, cputype=None):
    """
    Choose one architecture slice from a FAT/universal Mach-O binary.

    Args:
        data (bytes|mmap): Raw executable data.
        cputype (int|None): Requested CPU type, or None for the first slice.

    Returns:
        tuple: (start_offset, size, error_message)
    """
    slices, error_message = parse_fat_arches(data)
    if slices is None:
        return None, None, error_message

    if cputype is None:
        chosen = slices[0]
    else:
        matches = [entry for entry in slices if entry[0] == cputype]
        if not matches:
            available = ", ".join(str(entry[0]) for entry in slices)
            return None, None, "Error: CPU type {} not present; available: {}".format(cputype, available)
        chosen = matches[0]

    return chosen[2], chosen[3], None


def find_bun_section_any(data, cputype=None):
    """
    Locate the Bun bundle in any supported container format.

    PE and ELF are checked first, then thin Mach-O, then FAT/universal
    Mach-O, and finally the bare magic-byte fallback.

    Args:
        data (bytes|mmap): Raw executable data.
        cputype (int|None): CPU type to select from a universal Mach-O.

    Returns:
        tuple: (Section, stop_at_nul, error_message)
    """
    if len(data) >= 0x40 and data[0:2] == b'MZ':
        pe_offset = struct.unpack('<I', data[0x3C:0x40])[0]
        if pe_offset + 4 <= len(data) and data[pe_offset:pe_offset+4] == b'PE\x00\x00':
            js_start, js_size = find_bun_section(data, pe_offset)
            if js_start is not None:
                return (
                    Section('pe', PE_SECTION_NAME, js_start, js_size),
                    False,
                    None,
                )

    js_start, js_size, error_message = find_macho_bun_section(data)
    if js_start is not None:
        return (
            Section('macho', '%s,%s' % (MACHO_SEGMENT_NAME, MACHO_SECTION_NAME), js_start, js_size),
            True,
            None,
        )
    if error_message is not None and 'FAT/universal' in error_message:
        js_start, js_size, error_message = select_fat_slice(data, cputype)
        if js_start is None:
            return None, False, error_message
        inner = data[js_start:js_start + js_size]
        inner_start, inner_size, inner_error = find_macho_bun_section(inner)
        if inner_start is not None:
            return (
                Section('macho-fat', '%s,%s' % (MACHO_SEGMENT_NAME, MACHO_SECTION_NAME), js_start + inner_start, inner_size),
                True,
                None,
            )
        return None, False, inner_error
    if error_message is not None:
        return None, False, error_message

    js_start, js_size = find_elf_bun_section(data)
    if js_start is not None:
        return (
            Section('elf', ELF_SECTION_NAME, js_start, js_size),
            False,
            None,
        )

    pos = data.find(BUN_MAGIC)
    if pos != -1:
        return (
            Section('magic', 'magic', pos, len(data) - pos),
            False,
            None,
        )

    return None, False, "Error: Could not locate JavaScript bundle"


def find_js_boundary(bundle, chunk_size=1000, threshold=0.3):
    """
    Detect where JavaScript ends and binary data begins.

    Args:
        bundle (bytes|mmap): JavaScript bundle data.
        chunk_size (int): Size of chunks to analyze.
        threshold (float): Non-printable ratio threshold.

    Returns:
        int: Offset where binary data starts.
    """
    for i in range(0, min(len(bundle), 50_000_000), chunk_size):
        chunk = bundle[i:i+chunk_size]
        if not chunk:
            break

        if non_text_ratio(chunk) > threshold:
            return i

    return len(bundle)


def find_first_binary_byte(bundle):
    """
    Find the first byte that does not look like plain-text JavaScript.

    Args:
        bundle (bytes|mmap): JavaScript bundle data.

    Returns:
        int|None: Offset of the first binary-looking byte, or None if not found.
    """
    table = NON_TEXT_TABLE
    for index, byte in enumerate(bundle):
        if table[byte]:
            return index

    return None


def refine_boundary(bundle, initial_end):
    """
    Snap the JavaScript boundary to the end of a trailing marker line.

    Only whole `//# ...` comment lines are considered. Snapping to a stray
    `;`, `}` or `)` looked attractive but is actively harmful: Bun's bytecode
    blob contains plenty of those bytes, so on a real target it walked 223 bytes
    past the last module and pulled binary into the output. This function can
    therefore never move the boundary backwards, and never forward past a
    marker line that is definitionally the last line of the source.

    Args:
        bundle (bytes|mmap): JavaScript bundle data.
        initial_end (int): Initial boundary offset.

    Returns:
        int: Refined boundary offset, never less than `initial_end`.
    """
    next_data = bundle[initial_end:initial_end+2000]
    ascii_count = sum(1 for b in next_data[:500] if 32 <= b < 127)

    if ascii_count <= 50:
        return initial_end

    markers = [b'//# debugId=', b'//# sourceMappingURL=']

    for marker in markers:
        marker_pos = next_data.find(marker)
        if marker_pos >= 0:
            line_end = next_data.find(b'\n', marker_pos)
            if line_end >= 0:
                check_after = next_data[line_end+1:line_end+101]
                if len(check_after) > 0:
                    binary_ratio = non_text_ratio(check_after)
                    if binary_ratio > 0.4:
                        return initial_end + line_end + 1

    return initial_end


def trim_trailing_binary(buf, threshold=TRIM_THRESHOLD):
    """
    Cut non-text bytes off the end of a JavaScript buffer.

    Used as the fallback when module headers give no better anchor. The window
    scales with the buffer so short bundles are still cleaned, and any residual
    non-text run at the boundary is removed outright, because source code never
    ends in raw control or high bytes.

    Args:
        buf (bytes|mmap): Candidate JavaScript data.
        threshold (float): Non-text ratio above which a window is binary.

    Returns:
        tuple: (trimmed_data, trimmed_byte_count)
    """
    length = len(buf)
    if not length:
        return buf, 0

    window = min(TRIM_WINDOW, max(16, length // 8))
    end = length
    while end >= window:
        if non_text_ratio(buf[end - window:end]) > threshold:
            end -= window
            continue
        break

    while end > 0 and NON_TEXT_TABLE[buf[end - 1]]:
        end -= 1

    if end == length:
        return buf, 0

    return buf[:end], length - end


def resolve_js_end(region, refined_end, headers, coarse_step=256, coarse_window=256,
                   coarse_threshold=0.35, fine_window=64, fine_threshold=0.4):
    """
    Determine the end of the JavaScript region without losing source.

    Neither a backwards window nor a NUL terminator is reliable here: the
    bytecode blob that follows the source interleaves printable bytes, so its
    density is only around 0.6, and compiled modules may legitimately contain
    NUL bytes. Instead this scans *forwards* from the last module header, which
    is known to be text, and stops where the source turns into structured
    data. Scanning forwards from a text anchor can only ever under-trim, never
    drop real source. A coarse pass bounds the work on multi-megabyte modules
    and a fine pass places the boundary within one window.

    Args:
        region (bytes|mmap): JavaScript region, already sliced to the marker.
        refined_end (int): End offset from the statistical boundary, used as a cap.
        headers (list): Module header offsets inside `region`.

    The coarse pass is allowed to inspect past the cap, because the blob it is
    looking for usually starts within one window of the cap, but the result is
    clamped to the cap so this can only ever under-trim.
        coarse_step (int): Advance per coarse iteration in bytes.
        coarse_window (int): Window size for the coarse pass.
        coarse_threshold (float): Non-text ratio that flags the coarse pass.
        fine_window (int): Window size for the fine pass.
        fine_threshold (float): Non-text ratio that flags the fine pass.

    Returns:
        int: Exclusive end offset of the JavaScript region.
    """
    limit = min(len(region), refined_end)
    if not headers:
        trimmed, _removed = trim_trailing_binary(region[:limit])
        return len(trimmed)

    anchor = headers[-1]
    if anchor >= limit:
        return limit

    coarse = anchor
    while coarse + coarse_window <= len(region):
        if non_text_ratio(region[coarse:coarse + coarse_window]) > coarse_threshold:
            break
        coarse += coarse_step
    else:
        trimmed, _removed = trim_trailing_binary(region[:limit])
        return len(trimmed)

    low = max(anchor, coarse - coarse_window)
    high = min(limit, coarse + coarse_window)
    if low >= high:
        trimmed, _removed = trim_trailing_binary(region[:limit])
        return len(trimmed)

    edge = high
    pos = low
    while pos + fine_window <= high:
        if non_text_ratio(region[pos:pos + fine_window]) > fine_threshold:
            edge = pos
            break
        pos += 1

    while edge < high and non_text_ratio(region[edge:edge + fine_window]) <= fine_threshold:
        edge += 1

    while edge > 0 and NON_TEXT_TABLE[region[edge - 1]]:
        edge -= 1

    return min(edge, limit)


def find_module_offsets(bundle):
    """
    Locate every compiled module inside a Bun bundle.

    Bun writes one `// @bun` header per module, NUL-delimited, so a header is
    only accepted when it sits at the start of the region or directly after a
    NUL and the rest of the line is a valid tag list. That rejects markers that
    appear inside a string literal or a comment.

    Searching backwards with `rfind` avoids a full regular-expression pass
    over a bundle that can be hundreds of megabytes.

    Args:
        bundle (bytes|mmap): JavaScript bundle data.

    Returns:
        list: Module header offsets in ascending order.
    """
    needle = b'\x00' + BUN_MARKER
    offsets = []
    cursor = len(bundle)

    while cursor > 0:
        found = bundle.rfind(needle, 0, cursor)
        if found < 0:
            break
        start = found + 1
        if MODULE_HEADER_RE.match(bundle, start):
            offsets.append(start)
        cursor = found

    offsets.reverse()

    if bundle.startswith(BUN_MARKER) and MODULE_HEADER_RE.match(bundle, 0):
        offsets.insert(0, 0)

    return offsets


_SLUG_RE = re.compile(rb'''(?:from|require\()\s*["']([^"']{1,120})["']''')
_SLUG_STRIP_RE = re.compile(rb'[^A-Za-z0-9._-]+')
_SLUG_EXTENSION_RE = re.compile(rb'\.(mjs|cjs|jsx|tsx|mts|cts|ts|js)$', re.IGNORECASE)


def derive_slug(module_bytes, index):
    """
    Derive a readable filename stem for a module.

    Uses the module's first import specifier when one is present, otherwise a
    sanitised fragment of its first meaningful line.

    Args:
        module_bytes (bytes): Raw module source.
        index (int): Zero-based module index.

    Returns:
        str: Filesystem-safe slug, never empty.
    """
    head = module_bytes[:8192]

    match = _SLUG_RE.search(head)
    if match:
        spec = match.group(1).replace(b'\\', b'/')
        base = spec.rsplit(b'/', 1)[-1]
        base = base.split(b'?', 1)[0]
        base = _SLUG_EXTENSION_RE.sub(b'', base)
        slug = _SLUG_STRIP_RE.sub(b'-', base).strip(b'-').decode('ascii', 'ignore')
        if slug:
            return slug[:48]

    for line in head.split(b'\n'):
        stripped = line.strip()
        if not stripped or stripped.startswith(b'//') or stripped.startswith(b'/*') or stripped.startswith(b'*'):
            continue
        slug = _SLUG_STRIP_RE.sub(b'-', stripped).strip(b'-').decode('ascii', 'ignore')
        if slug:
            return slug[:40]

    return 'module-%04d' % index


def read_module_headers(bundle, offsets, js_end):
    """
    Read the header line of every module without copying module bodies.

    Args:
        bundle (bytes|mmap): JavaScript region.
        offsets (list): Module header offsets.
        js_end (int): Exclusive end offset of the JavaScript region.

    Returns:
        list: Tuples of (offset, size, header, cjs, bytecode) in file order.
    """
    headers = []
    limits = offsets[1:] + [js_end]
    for start, limit in zip(offsets, limits):
        newline = bundle.find(b'\n', start, limit)
        header = bytes(bundle[start:newline if newline != -1 else limit]).strip()
        headers.append(
            (
                start,
                limit - start,
                header,
                b'@bun-cjs' in header,
                b'@bytecode' in header,
            )
        )
    return headers


def build_modules(bundle, headers):
    """
    Attach filesystem-safe slugs to pre-read module headers.

    Only the first few kilobytes of each module are inspected, so building the
    full module list never copies the whole bundle.

    Args:
        bundle (bytes|mmap): JavaScript region.
        headers (list): Tuples produced by `read_module_headers`.

    Returns:
        list[BunModule]: Modules in file order.
    """
    modules = []
    for index, (offset, size, header, cjs, bytecode) in enumerate(headers):
        head = bytes(bundle[offset:offset + min(size, 8192)])
        modules.append(
            BunModule(
                index=index,
                offset=offset,
                size=size,
                header=header,
                cjs=cjs,
                bytecode=bytecode,
                slug=derive_slug(head, index),
            )
        )
    return modules


def extract_js_data(bundle, stop_at_nul=False, chunk_size=1000, threshold=0.3):
    """
    Extract clean JavaScript from a bundle payload.

    Args:
        bundle (bytes|mmap): Candidate bundle data.
        stop_at_nul (bool): Whether to stop at the first NUL terminator.
        chunk_size (int): Boundary scan granularity.
        threshold (float): Boundary scan non-text ratio.

    Returns:
        tuple: (js_data, error_message)
    """
    js_marker_pos = bundle.find(BUN_MARKER)

    if js_marker_pos == -1:
        return None, "Error: Could not find JavaScript marker"

    bundle = bundle[js_marker_pos:]

    if stop_at_nul:
        nul_pos = bundle.find(b'\x00')
        if nul_pos != -1:
            return bundle[:nul_pos], None

    initial_end = find_js_boundary(bundle, chunk_size, threshold)
    final_end = refine_boundary(bundle, initial_end)

    if final_end == 0:
        first_binary = find_first_binary_byte(bundle)
        if first_binary not in (None, 0):
            return bundle[:first_binary], None

    return bundle[:final_end], None


def open_binary(exe_path):
    """
    Memory-map an executable for extraction.

    Falls back to a plain read when the file cannot be mapped, which keeps the
    module usable against in-memory buffers in tests.

    Args:
        exe_path (Path): Path to the executable.

    Returns:
        tuple: (data, close_callable)
    """
    handle = open(str(exe_path), 'rb')
    try:
        mapped = mmap.mmap(handle.fileno(), 0, access=mmap.ACCESS_READ)
    except (ValueError, OSError):
        handle.close()
        return exe_path.read_bytes(), lambda: None

    def close():
        mapped.close()
        handle.close()

    return mapped, close


class Extraction(object):
    """
    Result of a successful bundle extraction.

    Attributes:
        section (Section): Container section the bundle came from.
        js (bytes): Clean JavaScript, byte-exact, free of trailing binary.
        region (bytes): JavaScript region the extraction was measured against.
        module_headers (list): Per-module offset, size, header and flags.
        source_size (int): Size of the input executable.
        section_size (int): Size of the container section.
        js_offset (int): Offset of the JavaScript marker inside the section.
        js_length (int): Length of the clean JavaScript region.
        trimmed (int): Trailing binary bytes removed from the raw boundary.
        graph (ModuleGraph|None): Bun's own module graph, the authoritative
            record of every embedded file's real name. None when the section
            carries no readable graph.
        sources (list[GraphSource]|None): Every original source file recovered
            from the graph's source maps, in graph order.
    """

    def __init__(self, section, js, region, module_headers, source_size, section_size,
                 js_offset, js_length, trimmed, source_path='', graph=None, sources=None):
        self.section = section
        self.js = js
        self.region = region
        self.module_headers = module_headers
        self.source_size = source_size
        self.section_size = section_size
        self.js_offset = js_offset
        self.js_length = js_length
        self.trimmed = trimmed
        self.source_path = source_path
        self.graph = graph
        self.sources = sources if sources is not None else []

    @property
    def module_count(self):
        """
        int: Number of compiled modules found in the bundle.
        """
        return len(self.module_headers)

    @property
    def source_count(self):
        """
        int: Number of original source files recovered from source maps.
        """
        return len(self.sources)

    @property
    def source_paths(self):
        """
        int: Number of distinct source paths across every source map.
        """
        return len(set(source.path for source in self.sources))

    @property
    def source_map_count(self):
        """
        int: Number of module records that carry a usable source map.
        """
        return len(set(source.module_index for source in self.sources))

    @property
    def bytecode_module_count(self):
        """
        int: Number of modules that execute bytecode rather than the source.
        """
        return sum(1 for header in self.module_headers if header[4])

    @property
    def uses_bytecode(self):
        """
        bool: True when the executable runs JSC bytecode rather than source.
        """
        return self.bytecode_module_count > 0

    def modules(self):
        """
        Build the full module list, including filename slugs.

        Returns:
            list[BunModule]: Modules in file order.
        """
        return build_modules(self.region, self.module_headers)


def extract_bundle(exe_path, chunk_size=1000, threshold=0.3, cputype=None):
    """
    Extract and analyse the JavaScript bundle from a Bun executable.

    Args:
        exe_path (str|Path): Path to the executable.
        chunk_size (int): Boundary scan granularity.
        threshold (float): Boundary scan non-text ratio.
        cputype (int|None): CPU type to select from a universal Mach-O.

    Returns:
        tuple: (Extraction, error_message)
    """
    exe_path = Path(exe_path)
    if not exe_path.exists():
        return None, "Error: File not found: {}".format(exe_path)

    data, close = open_binary(exe_path)
    try:
        section, stop_at_nul, error_message = find_bun_section_any(data, cputype)
        if section is None:
            return None, error_message

        raw_section = data[section.file_offset:section.file_offset + section.size]

        raw_js, error_message = extract_js_data(raw_section, stop_at_nul, chunk_size, threshold)
        if error_message is not None:
            return None, error_message

        marker_offset = raw_section.find(BUN_MARKER)
        if marker_offset == -1:
            return None, "Error: Could not find JavaScript marker"

        region = raw_section[marker_offset:]
        offsets = find_module_offsets(region)
        js_end = resolve_js_end(region, len(raw_js), offsets)
        js_data = region[:js_end]
        module_headers = read_module_headers(region, offsets, js_end)

        graph = read_module_graph(raw_section)

        return (
            Extraction(
                section=section,
                js=js_data,
                region=region,
                module_headers=module_headers,
                source_size=len(data),
                section_size=section.size,
                js_offset=marker_offset,
                js_length=len(js_data),
                trimmed=max(0, len(raw_js) - js_end),
                source_path=exe_path.name,
                graph=graph,
                sources=read_graph_sources(raw_section, graph),
            ),
            None,
        )
    finally:
        close()


def write_modules(extraction, output_dir, quiet=False, formatter=None):
    """
    Write one file per compiled module plus a JSON manifest.

    Module names come from the standalone module graph when it can be parsed,
    because the graph records the real embedded path for every file. Failing
    that the name is derived from the module's first import specifier.

    Args:
        extraction (Extraction): Completed extraction.
        output_dir (Path): Destination directory.
        quiet (bool): Suppress progress output.
        formatter (callable|None): Optional byte-to-byte reformatter.

    Returns:
        tuple: (list_of_written_paths, manifest_dict)
    """
    modules_dir = output_dir / 'modules'
    modules_dir.mkdir(parents=True, exist_ok=True)

    written = []
    entries = []
    graph_index = module_graph_index(extraction)
    for module in extraction.modules():
        extension = '.cjs' if module.cjs else '.js'
        graph_entry = graph_index.get(module.offset)
        slug = _slug_from_graph_name(graph_entry.name) if graph_entry is not None else module.slug
        name = '%04d-%s%s' % (module.index, slug, extension)
        path = modules_dir / name

        start = extraction.js_offset + module.offset
        payload = extraction.js[module.offset:module.offset + module.size]
        if formatter is not None:
            payload = formatter(payload)
        with open(str(path), 'wb') as handle:
            handle.write(payload)

        written.append(path)
        graph_name = graph_entry.name if graph_entry is not None else None
        entries.append(
            {
                'index': module.index,
                'file': 'modules/' + name,
                'offset': start,
                'size': len(payload),
                'header': module.header.decode('ascii', 'replace'),
                'cjs': module.cjs,
                'bytecode': module.bytecode,
                'name': graph_name.decode('utf-8', 'replace') if graph_name else None,
            }
        )

    manifest = build_manifest(extraction, entries)
    manifest_path = output_dir / 'manifest.json'
    with open(str(manifest_path), 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2)

    written.append(manifest_path)
    if not quiet:
        print("Modules: {} files in {}".format(len(entries), modules_dir))
    return written, manifest


def dump_bytecode(extraction, exe_path, output_dir):
    """
    Write the bytecode regions that surround the JavaScript in the section.

    Args:
        extraction (Extraction): Completed extraction.
        exe_path (Path): Path to the source executable.
        output_dir (Path): Destination directory.

    Returns:
        list[Path]: Paths written.
    """
    data, close = open_binary(exe_path)
    try:
        base = extraction.section.file_offset
        region = data[base:base + extraction.section_size]
        start = extraction.js_offset
        end = start + extraction.js_length

        written = []
        regions = [
            ('head', 0, start),
            ('tail', end, extraction.section_size),
        ]
        for label, region_start, region_end in regions:
            if region_end <= region_start:
                continue
            payload = bytes(region[region_start:region_end])
            path = output_dir / ('%s.bytecode-%s.bin' % (exe_path.stem, label))
            with open(str(path), 'wb') as handle:
                handle.write(payload)
            written.append(path)
        return written
    finally:
        close()


ZSTD_MAGIC = b'\x28\xb5\x2f\xfd'

# ---------------------------------------------------------------------------
# JavaScript pretty printer
#
# A dependency-free, single-pass lexer. It walks the source looking only for
# constructs that change layout (strings, templates, comments, regex literals
# and structural punctuation) and copies everything between them verbatim, so
# a full AST is never built and multi-megabyte bundles stay workable.
# ---------------------------------------------------------------------------

_JS_TOKENS = (
    r'[ \t\r\n\f\v]+'
    r'|//[^\n]*'
    r'|/\*.*?\*/'
    r'''|"(?:\\[^\n]|[^"\\\n])*"|'(?:\\[^\n]|[^'\\\n])*'|'''
    r'''"|'|`'''
    r'|\\(?:u\{[0-9A-Fa-f]{1,6}\}|u[0-9A-Fa-f]{4}|x[0-9A-Fa-f]{2}|u\{|.)'
    r'|[{}()\[\];,]'
    r'|/(?!=)'
    r'|(?:>>>=|<<=|>>=|\*\*=|&&=|\|\|=|\?\?=|>>>|===|!==|\.\.\.|=>|==|!=|<=|>='
    r'|&&|\|\||\?\?|\*\*|\+\+|--|\+=|-=|/=|\*=|%=|&=|\|=|\^=|<<|>>|\?\.'
    r'|[-+*%=<>!&|^~?:])'
)

_JS_NEXT_RE = re.compile(_JS_TOKENS, re.DOTALL)

# Bundled Unicode and emoji tables compile to very large patterns, and a
# 10KB one is still an ordinary regular expression. A candidate is only
# accepted when the character after its closing slash cannot continue an
# operand, so `a / b / c` still reads as division at any length.
_JS_MAX_REGEX = 1 << 16

# Operators that begin with a slash. A slash followed by `=` is matched as one
# of these by the token pattern, so a regular expression such as `/=/g` has to
# be recognised from the raw source before the operator is accepted.
_SLASH_OPERATORS = frozenset(('/=', '//='))

_FLAG_CHAR = re.compile(r'[a-z]')

_TEMPLATE_JUMP_RE = re.compile(r'[\\`$]')
_IDENT_CHAR = re.compile(r'[A-Za-z0-9_$]')

# Keywords after which a `/` opens a regular expression rather than dividing.
_REGEX_KEYWORDS = frozenset((
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'throw', 'case', 'do', 'else', 'yield', 'await', 'default',
))

# Characters that end a value, so a `/` after one is division.
_VALUE_END = frozenset(')]}\'"`')

# Keywords that take a parenthesised head, which reads better with a space.
_PAREN_KEYWORDS = frozenset(('if', 'for', 'while', 'switch', 'catch', 'await'))

# Keywords whose head `(` is followed by a body, so a `/` after the `)` opens
# a regular expression even though the `)` itself is a value.
_BODY_KEYWORDS = frozenset(('if', 'for', 'while', 'with'))

# A space belongs before `{` unless it is glued to an operator or opener.
_NO_SPACE_BEFORE_BRACE = frozenset('([{,=:')

# Words that keep the `}` they follow on the same line.
_AFTER_BRACE_WORD = frozenset(('else', 'catch', 'finally', 'while', 'from'))

# Words that open a `case` or `default` label, whose body is indented.
_CASE_WORDS = frozenset(('case', 'default'))

# Words whose `{` starts a specifier list that reads better on one line.
_SPEC_LIST_WORDS = frozenset(('import', 'export'))

# Characters that keep a `}` and whatever follows it on one line.
_AFTER_BRACE_CHAR = ');,]}.:,`='

# Indentation past this depth is clamped, so deeply nested or unbalanced input
# cannot inflate every following line.
_MAX_INDENT = 24

# A line comment that opens a Bun module. Layout state resets here so that
# modules with unbalanced braces cannot push later modules deeper and deeper.
_MODULE_MARK = '// @bun'

# Interpolation bodies larger than this, or nested deeper than this, are copied
# verbatim: reformatting them means scanning the same text again.
_MAX_HOLE = 4000000
_MAX_NESTED = 2


def _scan_template(source, start):
    """
    Scan a template literal, honouring escapes and nested `${}` holes.

    Args:
        source (str): Full source text.
        start (int): Index of the opening backtick.

    Returns:
        tuple: (end_index, literal_text)
    """
    length = len(source)
    cursor = start + 1
    while cursor < length:
        match = _TEMPLATE_JUMP_RE.search(source, cursor)
        if match is None:
            return length, source[start:]
        char = match.group(0)
        if char == '\\':
            cursor = match.end() + 1
            continue
        if char == '`':
            return match.end(), source[start:match.end()]
        if source[match.end():match.end() + 1] == '{':
            cursor = _scan_brace_hole(source, match.end() + 1)
            continue
        cursor = match.end()

    return length, source[start:]


def _read_regex(source, pos):
    """
    Measure the regular expression literal that starts at an index.

    Character classes and backslash escapes are tracked, because a slash or a
    backtick inside a class belongs to the pattern rather than to the code
    around it. That is what keeps `/[`\\s].*$/s` from being mistaken for a
    template boundary.

    Args:
        source (str): Full source text.
        pos (int): Index of the opening slash.

    Returns:
        int|None: Index just past the literal and its flags, or None when the
            text at that index is not a well-formed regular expression.
    """
    length = len(source)
    index = pos + 1
    escaped = False
    in_class = False
    while index < length:
        char = source[index]
        if char in '\n\r\u2028\u2029':
            return None
        if escaped:
            escaped = False
        elif char == '\\':
            escaped = True
        elif char == '[':
            in_class = True
        elif char == ']':
            in_class = False
        elif char == '/' and not in_class:
            index += 1
            while index < length and _FLAG_CHAR.match(source[index]):
                index += 1
            return index
        index += 1
    return None


def _scan_brace_hole(source, start):
    """
    Find the end of a `${ ... }` interpolation, skipping nested constructs.

    Regular expressions are consumed as whole literals here, exactly as in the
    main pass, so a backtick inside a character class cannot be read as the end
    of an enclosing template.

    Args:
        source (str): Full source text.
        start (int): Index just after the opening `{`.

    Returns:
        int: Index just past the closing `}`.
    """
    length = len(source)
    cursor = start
    depth = 0
    prev_char = ''
    while cursor < length:
        match = _JS_NEXT_RE.search(source, cursor)
        if match is None:
            return length
        text = match.group(0)
        head = text[0]
        gap = source[cursor:match.start()]
        if gap:
            prev_char = gap[-1]
        if head == '`':
            cursor = _scan_template(source, match.start())[0]
            prev_char = '`'
            continue
        if head == '/':
            if len(text) > 1:
                cursor = match.end()
                continue
            if prev_char.isalnum() or prev_char in '_$)]}"\'`/':
                cursor = match.end()
                continue
            stop = _read_regex(source, match.start())
            cursor = stop if stop is not None else match.end()
            prev_char = '/'
            continue
        if head in '{}()[]':
            if head in '{([':
                depth += 1
            elif head in '})]':
                if head == '}' and depth == 0:
                    return match.end()
                depth -= 1
            prev_char = head
            cursor = match.end()
            continue
        if head in '"\'' or head in _VALUE_END:
            prev_char = head
            cursor = match.end()
            continue
        prev_char = head
        cursor = match.end()

    return length


def _peek_word(source, index):
    """
    Read the identifier that starts at or after an index, if any.

    Args:
        source (str): Full source text.
        index (int): Index to look at.

    Returns:
        str|None: The identifier, or None if there is not one.
    """
    length = len(source)
    while index < length and source[index] in ' \t\r\n':
        index += 1
    end = index
    while end < length and _IDENT_CHAR.match(source[end]):
        end += 1
    if end == index:
        return None
    word = source[index:end]
    if word[0].isdigit():
        return None
    return word


def _peek_char(source, index):
    """
    Read the next non-whitespace character at or after an index.

    Args:
        source (str): Full source text.
        index (int): Index to look at.

    Returns:
        str: The character, or an empty string at end of input.
    """
    length = len(source)
    while index < length and source[index] in ' \t\r\n':
        index += 1
    if index >= length:
        return ''
    return source[index]


def _spans_wide(source, start, closer, width):
    """
    Report whether the run to a closing character is wider than a limit.

    Args:
        source (str): Full source text.
        start (int): Index just after the opening character.
        closer (str): Closing character to look for.
        width (int): Column limit.

    Returns:
        bool: True if the enclosed run is longer than `width`.
    """
    if not width:
        return False
    stop = source.find(closer, start)
    return stop > 0 and stop - start > width


def _template_parts(source, start):
    """
    Split a template literal into raw text and interpolation segments.

    Args:
        source (str): Full source text.
        start (int): Index of the opening backtick.

    Returns:
        tuple: (parts, end_index) where parts is a list of
            (is_interpolation, text) pairs that concatenate back to the
            original literal, and end_index is just past the closing backtick.
    """
    length = len(source)
    cursor = start + 1
    origin = start
    parts = []
    while cursor < length:
        match = _TEMPLATE_JUMP_RE.search(source, cursor)
        if match is None:
            break
        char = match.group(0)
        if char == '\\':
            cursor = match.end() + 1
            continue
        if char == '`':
            parts.append((False, source[origin:match.end()]))
            return parts, match.end()
        if source[match.end():match.end() + 1] == '{':
            parts.append((False, source[origin:match.end() + 1]))
            hole_end = _scan_brace_hole(source, match.end() + 1)
            parts.append((True, source[match.end() + 1:hole_end - 1]))
            cursor = hole_end
            origin = hole_end - 1
            continue
        cursor = match.end()
    parts.append((False, source[origin:length]))
    return parts, length


def beautify_js(source, indent='  ', break_commas=True, wrap_at=100,
                keep_blank_lines=True, nested=0):
    """
    Reformat JavaScript source for reading.

    This is a lexical pretty printer, not a parser. It keeps the author's own
    line breaks, normalises horizontal whitespace, pads operators, indents by
    brace depth and adds line breaks at statement and object-literal
    boundaries. No token is ever rewritten, so the result is the input with
    different whitespace, and no syntax tree is built, so a whole bundle stays
    within reach.

    Args:
        source (str): JavaScript source text.
        indent (str): One level of indentation.
        break_commas (bool): Break object and array literals across lines.
        wrap_at (int): Column at which long lines are wrapped, 0 disables
            wrapping. Wrapping only ever inserts line breaks at commas,
            binary operators and member accesses, so it cannot change parsing.
        keep_blank_lines (bool): Preserve blank lines from the input.
        nested (int): Current template-interpolation nesting level. Internal:
            large or deeply nested interpolations are copied verbatim because
            reformatting them costs a second pass over the same text.

    Returns:
        str: Reformatted source.
    """
    if not source:
        return source

    out = []
    append = out.append
    ladders = [indent * level for level in range(_MAX_INDENT)]

    depth = 0
    paren = 0
    hang = 0
    heads = []
    hangs = []
    breaks = []
    line_open = False
    need_indent = True
    pending_space = False
    prev_char = ''
    prev_word = None
    prev_value = False
    prev_prop = False
    ternary = False
    label = False
    spec_list = False
    brace_inline = False
    breakable = False
    case_extra = 0
    case_depth = 0
    line_length = 0
    index = 0
    length = len(source)

    def newline():
        nonlocal line_open, need_indent, pending_space, line_length
        if line_open:
            append('\n')
        line_open = False
        need_indent = True
        pending_space = False
        line_length = 0

    def too_long(size):
        return bool(wrap_at) and line_length + size > wrap_at

    def hang_here():
        nonlocal hang
        if hangs and not hangs[-1]:
            hangs[-1] = True
            hang += 1

    def put(text):
        nonlocal line_open, need_indent, pending_space, line_length
        if not text:
            return
        if need_indent:
            if pending_space:
                append(' ')
                line_length += 1
            level = depth + hang + (case_extra if depth >= case_depth else 0)
            if level > _MAX_INDENT - 1:
                level = _MAX_INDENT - 1
            pad = ladders[level]
            append(pad)
            line_length += len(pad)
            need_indent = False
        elif pending_space:
            append(' ')
            line_length += 1
        pending_space = False
        append(text)
        line_length += len(text)
        line_open = True

    while index < length:
        match = _JS_NEXT_RE.search(source, index)
        if match is None:
            text = source[index:]
            if text:
                prev_word = None
                prev_value = False
                prev_char = text[-1]
                if need_indent or pending_space:
                    put(text)
                else:
                    append(text)
                    line_length += len(text)
                    line_open = True
            break

        gap = source[index:match.start()]
        if gap:
            last = gap[-1]
            if last.isalnum() or last in '_$':
                end = len(gap)
                while end > 0 and (gap[end - 1].isalnum() or gap[end - 1] in '_$'):
                    end -= 1
                prev_word = gap[end:]
                prev_value = prev_word not in _REGEX_KEYWORDS
                prev_prop = gap[:end].endswith('.')
                if prev_word in _CASE_WORDS:
                    case_extra = 0
                    label = True
            else:
                prev_word = None
                prev_value = False
                prev_prop = False
            prev_char = last
            if wrap_at and line_length > wrap_at and line_open and gap[0] == '.':
                newline()
            elif breakable and line_open and too_long(len(gap)):
                hang_here()
                newline()
            breakable = False
            if need_indent or pending_space:
                put(gap)
            else:
                append(gap)
                line_length += len(gap)
                line_open = True

        index = match.end()
        text = match.group(0)
        head = text[0]

        if head in ' \t\r\n\f\v':
            if '\n' in text:
                had_line = line_open
                newline()
                if had_line and keep_blank_lines and text.count('\n') > 1:
                    append('\n')
            else:
                pending_space = line_open
            continue

        if head == '/' and len(text) > 1 and text[1] in '/*':
            put(text)
            if text[1] == '/' or '\n' in text:
                newline()
            if text.startswith(_MODULE_MARK):
                depth = 0
                paren = 0
                hang = 0
                case_extra = 0
                case_depth = 0
                spec_list = False
                brace_inline = False
                del heads[:]
                del hangs[:]
                del breaks[:]
            prev_char = '/'
            prev_word = None
            breakable = False
            continue

        if head == '/' and text[1:2] not in ('/', '*'):
            breakable = False
            divides = prev_value
            if not divides:
                stop = _read_regex(source, match.start())
                if stop is not None and (stop - match.start() <= _JS_MAX_REGEX
                                         and not _IDENT_CHAR.match(source, stop)):
                    if line_open and prev_word in _REGEX_KEYWORDS:
                        pending_space = True
                    put(source[match.start():stop])
                    index = stop
                    prev_value = True
                    prev_char = '/'
                    prev_word = None
                    continue
            if divides and line_open:
                pending_space = True
            put(text if text in _SLASH_OPERATORS else '/')
            if divides:
                pending_space = True
            prev_value = True
            prev_char = '/'
            prev_word = None
            continue

        if head == '"' or head == "'":
            if line_open and prev_word == 'from':
                pending_space = True
            if breakable and line_open and too_long(len(text)):
                hang_here()
                newline()
            put(text)
            breakable = False
            prev_char = head
            prev_word = None
            prev_value = True
            continue

        if head == '`':
            parts, stop = _template_parts(source, match.start())
            if breakable and line_open and too_long(match.end() - match.start()):
                hang_here()
                newline()
            level = depth + hang + (case_extra if depth >= case_depth else 0)
            if level > _MAX_INDENT - 1:
                level = _MAX_INDENT - 1
            pad = ladders[level] + indent
            for is_hole, text in parts:
                if not is_hole:
                    put(text)
                    continue
                inner = None
                if nested < _MAX_NESTED and len(text) <= _MAX_HOLE:
                    inner = beautify_js(
                        text, indent=indent, wrap_at=wrap_at, nested=nested + 1
                    ).strip('\n')
                head_line, _, tail = (inner if inner is not None else text).partition('\n')
                put(head_line)
                if tail:
                    for extra in tail.split('\n'):
                        append('\n')
                        if extra:
                            append(pad + extra)
                        line_length = len(pad) + len(extra)
                line_open = True
                need_indent = False
            breakable = False
            index = stop
            prev_char = '`'
            prev_word = None
            prev_value = True
            continue

        # A JavaScript identifier may spell itself with escapes, as in the
        # key spelled `espa\u{f1}ol`. The braces around the code point belong
        # to the escape rather than to object punctuation, so the whole
        # escape is emitted verbatim and never measured as a place to break.
        if head == '\\':
            put(text)
            pending_space = False
            breakable = False
            prev_char = text[-1]
            prev_word = None
            prev_value = True
            continue

        if head in '{}()[];,':
            if head == '{':
                label = False
                if prev_char and prev_char not in _NO_SPACE_BEFORE_BRACE:
                    pending_space = True
                put('{')
                depth += 1
                if prev_word in _SPEC_LIST_WORDS and not _spans_wide(source, match.end(), '}', wrap_at):
                    spec_list = True
                    breaks.append(False)
                elif _peek_char(source, index) == '}':
                    brace_inline = True
                    breaks.append(False)
                else:
                    breaks.append(True)
                    newline()
                prev_value = False
                breakable = False
            elif head == '}':
                if depth > 0:
                    depth -= 1
                case_extra = 0
                if (breaks.pop() if breaks else True) and not brace_inline:
                    newline()
                spec_list = False
                brace_inline = False
                put('}')
                breakable = True
                if _peek_word(source, index) in _AFTER_BRACE_WORD:
                    pending_space = True
                else:
                    following = _peek_char(source, index)
                    if following and following not in _AFTER_BRACE_CHAR:
                        newline()
                prev_value = True
            elif head == '(':
                if line_open and prev_word in _PAREN_KEYWORDS and not prev_prop:
                    pending_space = True
                put('(')
                paren += 1
                head_word = prev_word
                heads.append(head_word in _BODY_KEYWORDS)
                wrapped = False
                if wrap_at:
                    if line_length > wrap_at:
                        wrapped = True
                    elif head_word in _PAREN_KEYWORDS:
                        wrapped = _spans_wide(source, match.end(), ')', wrap_at)
                hangs.append(wrapped)
                prev_value = False
                breakable = True
                if wrapped:
                    hang += 1
                    newline()
            elif head == '[':
                indexed = prev_value or prev_char in ')]}\'"`'
                put('[')
                paren += 1
                depth += 1
                prev_value = False
                breakable = True
                if _peek_char(source, index) == ']':
                    brace_inline = True
                    breaks.append(False)
                elif not indexed:
                    breaks.append(True)
                    newline()
                else:
                    breaks.append(False)
            elif head == ')':
                pending_space = False
                if paren > 0:
                    paren -= 1
                if hangs and hangs.pop():
                    hang -= 1
                if wrap_at and line_length > wrap_at and line_open and paren == 0:
                    newline()
                put(')')
                breakable = True
                if heads and heads.pop() and paren == 0:
                    prev_value = False
                    pending_space = True
                else:
                    prev_value = True
            elif head == ']':
                pending_space = False
                if paren > 0:
                    paren -= 1
                if depth > 0:
                    depth -= 1
                if (breaks.pop() if breaks else True) and not brace_inline:
                    newline()
                brace_inline = False
                put(']')
                prev_value = True
                breakable = True
            elif head == ';':
                label = False
                pending_space = False
                put(';')
                if paren > 0:
                    pending_space = True
                else:
                    newline()
                prev_value = False
                breakable = False
            else:
                label = False
                pending_space = False
                in_call = paren > 0 and depth == 0
                if breakable and line_open and too_long(2):
                    hang_here()
                    newline()
                put(',')
                pending_space = True
                if in_call:
                    if wrap_at and line_length > wrap_at:
                        hang_here()
                        newline()
                elif break_commas and not spec_list:
                    newline()
                prev_value = False
                breakable = True
            prev_char = head
            prev_word = None
            continue

        postfix = prev_value
        if text == '?':
            if postfix and line_open:
                pending_space = True
            put(text)
            pending_space = True
            ternary = True
            breakable = True
        elif text in '!~' or text == '...' or text == '?.':
            put(text)
            breakable = False
        elif text == ':':
            pending_space = ternary
            if label:
                case_extra = 1
                case_depth = depth
                label = False
            put(text)
            pending_space = True
            breakable = True
            if case_extra:
                newline()
        elif text in ('++', '--'):
            put(text)
            if postfix:
                pending_space = True
            breakable = False
        elif text == '*' and prev_word in ('function', 'yield'):
            put(text)
            pending_space = True
            breakable = True
        elif text in '+-*' and not postfix:
            put(text)
            breakable = False
        else:
            if postfix and line_open:
                pending_space = True
            # No line terminator may separate an arrow's parameters from its
            # `=>`, so an over-budget line is left long instead of broken here.
            if wrap_at and line_length > wrap_at and line_open and text != '=>':
                hang_here()
                newline()
            put(text)
            pending_space = True
            breakable = True
        prev_char = ']' if text == '?.' else head
        prev_word = None
        prev_value = postfix and text in ('++', '--')

    if line_open:
        append('\n')

    return ''.join(out)


def build_formatter(indent='  ', wrap_at=0):
    """
    Build a byte-in/byte-out formatter for extracted JavaScript.

    Payloads are decoded with `surrogateescape`, so bytes that are not valid
    UTF-8 survive a decode/encode round trip untouched. That keeps formatting
    from ever being the reason an extraction fails or loses data.

    Args:
        indent (str): One level of indentation.
        wrap_at (int): Soft wrap width for argument lists, 0 disables wrapping.

    Returns:
        callable: Function mapping raw bytes to formatted bytes.
    """
    def format_bytes(payload):
        text = payload.decode('utf-8', 'surrogateescape')
        formatted = beautify_js(text, indent=indent, wrap_at=wrap_at)
        return formatted.encode('utf-8', 'surrogateescape')

    return format_bytes

ASSET_PATH_RE = re.compile(
    rb'[A-Za-z0-9._-]{1,80}-[0-9a-f]{8}\.[A-Za-z0-9]{1,10}(?:\.zst)?'
)


def find_zstd_frames(buf, start=0, end=None):
    """
    Locate every Zstandard frame in a buffer.

    Bun embeds non-JavaScript files (skills, templates, vendored libraries)
    as Zstandard frames inside the bundle section, so these are the payloads
    behind the `*.zst` asset names the JavaScript refers to.

    Args:
        buf (bytes|mmap): Buffer to scan.
        start (int): Offset to begin scanning at.
        end (int|None): Offset to stop scanning at.

    Returns:
        list: Frame offsets in ascending order.
    """
    if end is None:
        end = len(buf)
    frames = []
    cursor = start
    while cursor < end:
        found = buf.find(ZSTD_MAGIC, cursor, end)
        if found < 0:
            break
        frames.append(found)
        cursor = found + 1
    return frames


def load_zstd_decompressor():
    """
    Load an optional Zstandard decompressor.

    `unbuned` has no required dependencies, so this returns None when no
    Zstandard binding is installed. Callers then keep the compressed frame
    rather than guessing at its contents.

    Returns:
        object|None: A decompressor exposing `decompressobj`, or None.
    """
    try:
        import zstandard
    except ImportError:
        return None
    return zstandard.ZstdDecompressor()


def asset_name_from_graph(graph_name, raw, index):
    """
    Turn a module graph path into a filename, extension and kind.

    The graph records the bundler's own `dest_path` for every embedded file, so
    the name no longer has to be guessed from the payload. Two suffixes are
    Bun's plumbing rather than part of the name: a trailing `.zst` marks the
    compressed frame, and a `.txt` that Bun appends to keep a non-text asset on
    its text pipeline. Both are removed so `template.html-fb05d44d.txt.zst`
    writes as `template.html-fb05d44d.html`. The `-fb05d44d` hash Bun bakes
    into the recorded path is deliberately kept: it is part of the name the
    bundler stored, and dropping it would collide distinct assets that share a
    stem.

    Args:
        graph_name (bytes): The embedded file's path from the module graph.
        raw (bytes|None): Decompressed asset contents, used only for the kind.
        index (int): Zero-based frame index, used as a last resort.

    Returns:
        tuple: (name, extension, kind)
    """
    base = graph_name.decode('utf-8', 'replace').replace('\\', '/').rsplit('/', 1)[-1]
    if not base:
        base = 'asset-%04d' % index

    lowered = base.lower()
    if lowered.endswith('.zst'):
        base = base[:-4]
        lowered = base.lower()
    if lowered.endswith('.txt') and '.' in base[:-4]:
        base = base[:-4]
        lowered = base.lower()
    if base.endswith('.'):
        base = base[:-1]
        lowered = base.lower()

    hashed = GRAPH_HASHED_EXTENSION_RE.search(base)
    if hashed:
        name, extension_text = base, '.' + hashed.group(1).lower()
    else:
        stem, dot, extension = base.rpartition('.')
        if not dot or not stem or not extension.isalnum() or len(extension) > 8:
            name, extension_text = base, '.txt'
        else:
            name, extension_text = stem, '.' + extension.lower()

    kind = 'text'
    if raw is not None:
        head = raw[:512].lower()
        if head.startswith(b'---'):
            kind = 'markdown'
        elif b'<html' in head or b'<!doctype html' in head:
            kind = 'html'
        elif head.startswith(b'{') or head.startswith(b'['):
            kind = 'json'
        elif b'function' in head or b'const ' in head or b'var ' in head:
            kind = 'script'

    if extension_text == GRAPH_PLACEHOLDER_EXTENSION:
        without_hash = name.rsplit('-', 1)[0] if '-' in name else name
        inner_stem, inner_dot, inner_extension = without_hash.rpartition('.')
        if inner_dot and inner_stem and inner_extension.isalnum() and len(inner_extension) <= 8:
            extension_text = '.' + inner_extension.lower()

    native = binary_format_extension(raw)
    if native is not None:
        if extension_text == '.txt':
            name, extension_text = base, native
        kind = 'binary'
    elif extension_text in ASSET_KIND_BY_EXTENSION:
        kind = ASSET_KIND_BY_EXTENSION[extension_text]

    return name, extension_text, kind


def binary_format_extension(raw):
    """
    Name the native executable format a payload is stored in.

    Args:
        raw (bytes|None): Decompressed asset contents.

    Returns:
        str|None: An extension including the leading dot, or None when the
            payload is not a recognised native format.
    """
    if not raw:
        return None
    for magic, extension in NATIVE_FORMAT_EXTENSIONS:
        if raw.startswith(magic):
            return extension
    return None


def sniff_asset(raw, index):
    """
    Guess a filename and content type for a decompressed asset.

    Bun renames every embedded file to `<name>-<hash>.<ext>.zst`, so the stored
    name says little. The payload itself is far more descriptive, and these
    assets are largely skill definitions and templates with structured headers,
    so front matter, titles and top-level headings are mined for a real name.

    Args:
        raw (bytes): Decompressed asset contents.
        index (int): Zero-based frame index, used as a last resort.

    Returns:
        tuple: (slug, extension, kind)
    """
    head = raw[:4096]
    lowered = head.lower()

    name = None
    extension = '.txt'
    kind = 'text'

    front_matter = head.startswith(b'---')
    if front_matter:
        match = re.search(rb'(?m)^name:\s*["\']?([A-Za-z0-9._-]{1,80})', head)
        if match:
            name = match.group(1).decode('ascii', 'ignore')
        extension, kind = '.md', 'markdown'
    elif b'<title' in lowered or lowered.startswith(b'<!doctype html') or lowered.startswith(b'<html'):
        match = re.search(rb'<title[^>]*>(.{1,120}?)</title>', head, re.IGNORECASE | re.DOTALL)
        if match:
            name = re.sub(rb'\s+', b'-', match.group(1).strip()).decode('ascii', 'ignore')
        extension, kind = '.html', 'html'
    else:
        heading = re.search(rb'(?m)^#\s+([^\n#]{1,90})', head)
        if heading and not re.search(rb'(?m)^\s*(function|const|let|var|import|export)\b', head):
            name = re.sub(rb'\s+', b'-', heading.group(1).strip()).decode('ascii', 'ignore')
            extension, kind = '.md', 'markdown'
        elif head.startswith(b'#!'):
            name, extension, kind = 'script', '.sh', 'script'
        elif head.startswith(b'/*!') or re.match(rb'^\s*(//|/\*)', head):
            banner = re.search(rb'^\s*(?://|/\*)\s*\*?\s*([A-Za-z@][\w.@/-]{2,60})', head)
            if banner:
                name = banner.group(1).decode('ascii', 'ignore')
            extension, kind = '.js', 'script'
        elif head.startswith(b'{') or head.startswith(b'['):
            extension, kind = '.json', 'json'
        elif re.search(rb'(?m)^\s*(function|const|let|var|import|export|class)\s', head):
            extension, kind = '.js', 'script'

    if not name:
        name = 'asset-%04d' % index

    name = _SLUG_STRIP_RE.sub(b'-', name.encode('ascii', 'ignore')).strip(b'-').decode('ascii', 'ignore')
    if not name:
        name = 'asset-%04d' % index

    return name[:60], extension, kind


def write_assets(extraction, exe_path, output_dir, quiet=False):
    """
    Extract every non-JavaScript file the executable ships.

    When the module graph can be read, every embedded file carries its own
    offset, length, name and encoding, so the payload is sliced out exactly and
    named from the graph. The bundled JavaScript only ever refers to these files
    by a hashed name, so the graph is the only place a real one exists. Graph
    payloads are not always compressed: a Windows binary stores its native
    helpers verbatim, so the recorded length is the length of the file itself.

    An executable may also ship frames the graph never mentions, so the section
    is still scanned for Zstandard frames that neither the graph nor the source
    maps claim. Those keep the name their contents imply.

    Sources recovered from source maps are deliberately excluded. They are the
    original code tree rather than shipped assets, and `write_sources` writes
    them under their real paths.

    Args:
        extraction (Extraction): Completed extraction.
        exe_path (Path): Path to the source executable.
        output_dir (Path): Destination directory.
        quiet (bool): Suppress progress output.

    Returns:
        list[Path]: Paths written, including the asset manifest.
    """
    data, close = open_binary(exe_path)
    try:
        base = extraction.section.file_offset
        section = data[base:base + extraction.section_size]

        referenced = sorted(set(ASSET_PATH_RE.findall(extraction.js)))

        claimed = set(source.offset for source in extraction.sources)
        items = []

        graph = extraction.graph
        if graph is not None:
            for entry in graph.files:
                if entry.loader in GRAPH_CODE_LOADERS:
                    continue
                if not entry.name or not entry.offset or not entry.length:
                    continue
                if entry.offset in claimed:
                    continue
                claimed.add(entry.offset)
                items.append((entry.offset, entry.length, entry.name, entry.encoding))

        for offset in find_zstd_frames(section):
            if offset in claimed:
                continue
            items.append((offset, None, None, 0))

        if not items:
            return []

        items.sort()
        assets_dir = output_dir / 'assets'
        assets_dir.mkdir(parents=True, exist_ok=True)

        decompressor = load_zstd_decompressor()
        entries = []
        used = {}
        written = []

        for index, item in enumerate(items):
            offset, length, graph_name, encoding = item
            if length is None:
                frame = section[offset:]
            else:
                frame = section[offset:offset + length]

            compressed = frame.startswith(ZSTD_MAGIC)
            raw = None
            if compressed and decompressor is not None:
                try:
                    raw = decompressor.decompressobj().decompress(frame)
                except Exception:
                    raw = None
                if raw is None and length is not None:
                    try:
                        raw = decompressor.decompressobj().decompress(section[offset:])
                    except Exception:
                        raw = None
            if raw is None:
                raw = frame

            stored_bytes = len(raw)
            transcoded = False
            if not compressed and encoding == 2:
                try:
                    raw = raw.decode('utf-16-le').encode('utf-8')
                    transcoded = True
                except Exception:
                    transcoded = False

            if graph_name:
                name, extension, kind = asset_name_from_graph(graph_name, raw, index)
            else:
                name, extension, kind = sniff_asset(raw, index)

            candidate = '%s%s' % (name, extension)
            count = used.get(candidate, 0)
            used[candidate] = count + 1
            if count:
                candidate = '%s-%d%s' % (name, count, extension)

            path = assets_dir / ('%04d-%s' % (index, candidate))
            with open(str(path), 'wb') as handle:
                handle.write(raw)

            entries.append({
                'index': index,
                'file': 'assets/' + path.name,
                'section_offset': offset,
                'section_bytes': length,
                'bytes': len(raw),
                'stored_bytes': stored_bytes,
                'compressed': compressed,
                'transcoded': transcoded,
                'encoding': GRAPH_ENCODING_NAMES.get(encoding, 'encoding-%d' % encoding) if graph_name else None,
                'kind': kind,
                'name': graph_name.decode('utf-8', 'replace') if graph_name else None,
            })
            written.append(path)

        named = sum(1 for entry in entries if entry['name'])
        payload = {
            'source': extraction.source_path,
            'decompressed': decompressor is not None,
            'asset_count': len(entries),
            'named_from_module_graph': named,
            'referenced_names': [name.decode('ascii', 'ignore') for name in referenced],
            'assets': entries,
        }
        manifest_path = assets_dir / 'assets.json'
        with open(str(manifest_path), 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, indent=2)
        written.append(manifest_path)

        if not quiet:
            state = 'decompressed' if decompressor is not None else 'raw .zst (install zstandard to decompress)'
            print("Assets: {} files in {} [{}]".format(len(entries), assets_dir, state))
            print("Asset names from module graph: {} of {}".format(named, len(entries)))
            print("Referenced asset names: {}".format(len(referenced)))

        return written
    finally:
        close()


def write_sources(extraction, exe_path, output_dir, quiet=False):
    """
    Write every original source file recovered from the embedded source maps.

    A compiled executable keeps the text every module was built from, so this
    is what turns a bundle back into the project it was compiled from. The
    paths come from the source map itself, so the tree on disk mirrors the
    original layout and a shared dependency lands where the map says it does
    instead of under a generated name.

    The same file can back more than one chunk, so a path already written is
    recorded as a duplicate rather than written twice or overwritten.

    Args:
        extraction (Extraction): Completed extraction.
        exe_path (Path): Path to the source executable.
        output_dir (Path): Destination directory.
        quiet (bool): Suppress progress output.

    Returns:
        list[Path]: Paths written, including the source manifest.
    """
    if not extraction.sources:
        return []

    data, close = open_binary(exe_path)
    try:
        base = extraction.section.file_offset
        section = data[base:base + extraction.section_size]
        decompressor = load_zstd_decompressor()

        sources_dir = output_dir / 'sources'
        sources_dir.mkdir(parents=True, exist_ok=True)

        entries = []
        written = []
        stored = {}
        duplicates = 0
        unusable = 0

        for source in extraction.sources:
            relative = source_output_path(source.path)
            if relative is None:
                unusable += 1
                continue

            frame = section[source.offset:source.offset + source.length]
            raw = None
            if decompressor is not None:
                try:
                    raw = decompressor.decompressobj().decompress(frame)
                except Exception:
                    raw = None
            if raw is None:
                raw, compressed = frame, True
            else:
                compressed = False

            path = sources_dir / relative
            known = stored.get(relative)
            if known is None:
                path.parent.mkdir(parents=True, exist_ok=True)
                with open(str(path), 'wb') as handle:
                    handle.write(raw)
                stored[relative] = len(raw)
                written.append(path)
            else:
                duplicates += 1

            entries.append({
                'module_index': source.module_index,
                'module': source.module_name,
                'path': source.path,
                'file': 'sources/' + relative,
                'section_offset': source.offset,
                'section_bytes': source.length,
                'bytes': len(raw),
                'compressed': compressed,
                'duplicate': known is not None,
                'identical_to_written': known == len(raw) if known is not None else None,
            })

        manifest_name = '_sources.json' if 'sources.json' in stored else 'sources.json'
        payload = {
            'source': extraction.source_path,
            'decompressed': decompressor is not None,
            'module_records': extraction.source_map_count,
            'source_count': len(entries),
            'unique_paths': len(stored),
            'duplicate_sources': duplicates,
            'unusable_paths': unusable,
            'sources': entries,
        }
        manifest_path = sources_dir / manifest_name
        with open(str(manifest_path), 'w', encoding='utf-8') as handle:
            json.dump(payload, handle, indent=2)
        written.append(manifest_path)

        if not quiet:
            state = 'decompressed' if decompressor is not None else 'raw (install zstandard to decompress)'
            print("Sources: {} files in {} from {} source maps [{}]".format(
                len(entries), sources_dir, extraction.source_map_count, state
            ))
            print("Original source bytes: {:,}".format(sum(entry['bytes'] for entry in entries)))
            if duplicates:
                print("Sources shared between chunks: {}".format(duplicates))
            if unusable:
                print("Sources with an unusable path: {}".format(unusable))

        return written
    finally:
        close()


def build_manifest(extraction, entries=None):
    """
    Build the JSON manifest describing an extraction.

    Args:
        extraction (Extraction): Completed extraction.
        entries (list|None): Per-module manifest entries. Omit to report the
            module count without materialising per-module records.

    Returns:
        dict: Manifest ready for serialisation.
    """
    manifest = {
        'source': extraction.source_path,
        'container': extraction.section.container,
        'section': {
            'name': extraction.section.name,
            'file_offset': extraction.section.file_offset,
            'size': extraction.section_size,
        },
        'executable_bytes': extraction.source_size,
        'javascript': {
            'offset': extraction.section.file_offset + max(extraction.js_offset, 0),
            'bytes': extraction.js_length,
            'trailing_binary_trimmed': extraction.trimmed,
        },
        'bytecode_compiled': extraction.uses_bytecode,
        'bytecode_module_count': extraction.bytecode_module_count,
        'module_count': extraction.module_count,
    }

    graph = extraction.graph
    if graph is not None:
        loaders = {}
        formats = {}
        for entry in graph.files:
            loader = GRAPH_LOADER_NAMES.get(entry.loader, 'loader-%d' % entry.loader)
            loaders[loader] = loaders.get(loader, 0) + 1
            module_format = GRAPH_FORMAT_NAMES.get(entry.module_format, 'format-%d' % entry.module_format)
            formats[module_format] = formats.get(module_format, 0) + 1
        entry_point = None
        if 0 <= graph.entry_point_id < len(graph.files):
            entry_point = graph.files[graph.entry_point_id].name.decode('utf-8', 'replace') or None
        manifest['module_graph'] = {
            'file_count': len(graph.files),
            'entry_point': entry_point,
            'startup_module_count': graph.startup_module_count,
            'byte_count': graph.byte_count,
            'flags': graph.flags,
            'flag_names': graph_flag_names(graph.flags),
            'loaders': loaders,
            'module_formats': formats,
            'with_bytecode': sum(1 for entry in graph.files if entry.bytecode_length),
            'with_sourcemap': sum(1 for entry in graph.files if entry.sourcemap_length),
            'with_module_info': sum(1 for entry in graph.files if entry.module_info_length),
        }

    if extraction.sources:
        manifest['source_maps'] = {
            'module_records': extraction.source_map_count,
            'source_count': extraction.source_count,
            'unique_paths': extraction.source_paths,
            'stored_bytes': sum(source.length for source in extraction.sources),
        }

    if entries is not None:
        manifest['modules'] = entries
    return manifest


def describe(extraction):
    """
    Render a human-readable report about an extraction.

    Args:
        extraction (Extraction): Completed extraction.

    Returns:
        str: Multi-line report.
    """
    lines = [
        "Container: {} ({} section, {} bytes at offset {})".format(
            extraction.section.container,
            extraction.section.name,
            extraction.section_size,
            extraction.section.file_offset,
        ),
        "Executable: {} bytes".format(extraction.source_size),
        "JavaScript: {} bytes at section offset {}".format(extraction.js_length, extraction.js_offset),
    ]
    if extraction.trimmed:
        lines.append("Trimmed: {} trailing binary bytes".format(extraction.trimmed))
    lines.append("Modules: {}".format(extraction.module_count))
    if extraction.uses_bytecode:
        lines.append(
            "Bytecode: JSC bytecode is embedded; {} of {} modules execute bytecode, not the source above".format(
                extraction.bytecode_module_count, extraction.module_count
            )
        )
    cjs_modules = sum(1 for header in extraction.module_headers if header[3])
    if cjs_modules:
        lines.append("CommonJS modules: {}".format(cjs_modules))
    graph = extraction.graph
    if graph is not None:
        entry_point = None
        if 0 <= graph.entry_point_id < len(graph.files):
            entry_point = graph.files[graph.entry_point_id].name.decode('utf-8', 'replace')
        lines.append("Module graph: {} embedded files".format(len(graph.files)))
        if entry_point:
            lines.append("Entry point: {}".format(entry_point))
        if graph.startup_module_count:
            lines.append(
                "Startup modules: {} in the entry point's static import closure".format(
                    graph.startup_module_count
                )
            )
        loaders = {}
        for entry in graph.files:
            loader = GRAPH_LOADER_NAMES.get(entry.loader, 'loader-%d' % entry.loader)
            loaders[loader] = loaders.get(loader, 0) + 1
        summary = ', '.join(
            '{} {}'.format(count, name) for name, count in sorted(loaders.items(), key=lambda item: -item[1])
        )
        lines.append("Graph loaders: {}".format(summary))
    if extraction.sources:
        lines.append(
            "Sources: {} original files recovered from {} source maps".format(
                extraction.source_count, extraction.source_map_count
            )
        )
    return "\n".join(lines)


def extract_bun_js(exe_path, output_dir=None, split_modules=False, dump_bytecode_blob=False,
                   dump_assets=False, dump_sources=False, chunk_size=1000, threshold=0.3,
                   cputype=None, skip_existing=False, quiet=False, format_js=False,
                   indent=2, wrap_at=0):
    """
    Extract JavaScript from a Bun-compiled executable and write it to disk.

    Args:
        exe_path (str|Path): Path to the executable.
        output_dir (str|Path|None): Destination directory, default
            `output/<executable-name>` relative to the working directory.
        split_modules (bool): Also write one file per compiled module.
        dump_bytecode_blob (bool): Also write the surrounding bytecode regions.
        dump_assets (bool): Also extract the non-JavaScript files the executable embeds.
        dump_sources (bool): Also write the original sources recovered from the
            embedded source maps.
        chunk_size (int): Boundary scan granularity.
        threshold (float): Boundary scan non-text ratio.
        cputype (int|None): CPU type to select from a universal Mach-O.
        skip_existing (bool): Leave an existing output file untouched.
        quiet (bool): Suppress progress output.
        format_js (bool): Reformat the JavaScript for reading.
        indent (int): Spaces per indentation level.
        wrap_at (int): Soft wrap width for argument lists, 0 disables wrapping.

    Returns:
        bool: True if extraction succeeded, False otherwise.
    """
    exe_path = Path(exe_path)
    extraction, error_message = extract_bundle(exe_path, chunk_size, threshold, cputype)
    if extraction is not None:
        extraction.source_path = exe_path.name
    if extraction is None:
        print(error_message)
        return False

    if output_dir is None:
        output_dir = Path('output') / exe_path.stem
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    output_file = output_dir / (exe_path.stem + '.js')
    if skip_existing and output_file.exists():
        if not quiet:
            print("Skipped: {} already exists".format(output_file))
        return True

    formatter = None
    payload = extraction.js
    if format_js:
        formatter = build_formatter(' ' * indent, wrap_at)
        payload = formatter(payload)

    with open(str(output_file), 'wb') as handle:
        handle.write(payload)

    written = [output_file]
    if split_modules:
        module_paths, _manifest = write_modules(extraction, output_dir, quiet, formatter)
        written.extend(module_paths)
    if dump_assets:
        written.extend(write_assets(extraction, exe_path, output_dir, quiet))
    if dump_sources:
        written.extend(write_sources(extraction, exe_path, output_dir, quiet))
    if dump_bytecode_blob:
        written.extend(dump_bytecode(extraction, exe_path, output_dir))

    if not quiet:
        print("Extracted: {}".format(output_file))
        print("Size: {:,} bytes{}".format(
            extraction.js_length,
            ' (formatted)' if format_js else '',
        ))
        print(describe(extraction))
        if len(written) > 1:
            print("Wrote: {} files".format(len(written)))

    return True


def build_parser():
    """
    Build the command-line argument parser.

    Returns:
        argparse.ArgumentParser: Configured parser.
    """
    parser = argparse.ArgumentParser(
        prog='unbuned',
        description='Extract JavaScript from Bun-compiled executables.',
    )
    parser.add_argument('executable', help='Path to the Bun-compiled executable')
    parser.add_argument('-o', '--output', help='Output directory (default: output/<name>)')
    parser.add_argument('-m', '--modules', action='store_true',
                        help='Also write one file per compiled module plus manifest.json')
    parser.add_argument('--assets', action='store_true',
                        help='Also extract the non-JavaScript files the executable embeds')
    parser.add_argument('--sources', action='store_true',
                        help='Also write the original sources recovered from the source maps')
    parser.add_argument('-a', '--all', action='store_true',
                        help='Dump everything: modules, sources, assets, manifests and bytecode')
    parser.add_argument('--bytecode', action='store_true',
                        help='Also dump the bytecode regions surrounding the JavaScript')
    parser.add_argument('--inspect', action='store_true',
                        help='Report on the executable without writing any files')
    parser.add_argument('--json', action='store_true',
                        help='Emit the inspection report as JSON')
    parser.add_argument('--format', dest='format_js', action='store_true',
                        help='Reformat the extracted JavaScript for reading')
    parser.add_argument('--indent', type=int, default=2,
                        help='Spaces per indentation level with --format (default: 2)')
    parser.add_argument('--wrap-at', type=int, default=100,
                        help='Column at which --format wraps long lines (default: 100, 0 disables)')
    parser.add_argument('--arch', type=int, help='CPU type to select from a universal Mach-O')
    parser.add_argument('--chunk-size', type=int, default=1000,
                        help='Boundary scan granularity in bytes (default: 1000)')
    parser.add_argument('--threshold', type=float, default=0.3,
                        help='Non-text ratio that marks the end of JavaScript (default: 0.3)')
    parser.add_argument('--skip-existing', action='store_true',
                        help='Do not overwrite an existing output file')
    parser.add_argument('-q', '--quiet', action='store_true', help='Suppress progress output')
    return parser


def main(argv=None):
    """
    Command-line entry point.

    Args:
        argv (list|None): Argument vector, defaults to `sys.argv[1:]`.

    Returns:
        int: Process exit code.
    """
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.inspect:
        extraction, error_message = extract_bundle(
            args.executable, args.chunk_size, args.threshold, args.arch
        )
        if extraction is None:
            print(error_message)
            return 1
        extraction.source_path = Path(args.executable).name
        if args.json:
            print(json.dumps(build_manifest(extraction), indent=2))
        else:
            print(describe(extraction))
        return 0

    ok = extract_bun_js(
        args.executable,
        output_dir=args.output,
        split_modules=args.modules or args.all,
        dump_assets=args.assets or args.all,
        dump_sources=args.sources or args.all,
        dump_bytecode_blob=args.bytecode or args.all,
        chunk_size=args.chunk_size,
        threshold=args.threshold,
        cputype=args.arch,
        skip_existing=args.skip_existing,
        quiet=args.quiet,
        format_js=args.format_js,
        indent=args.indent,
        wrap_at=args.wrap_at,
    )
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
