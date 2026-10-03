import io
import json
import os
import re
import struct
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import unbuned


def build_source_map(sources, mapping_length=7):
    """
    Build a standalone source map record the way the compiler writes it.

    Args:
        sources (list): `(path, content)` pairs in the order the map holds them.
        mapping_length (int): Length to reserve for the raw VLQ mapping.

    Returns:
        bytes: A self-consistent source map record.
    """
    sources = [
        (path.encode() if isinstance(path, str) else path,
         content.encode() if isinstance(content, str) else content)
        for path, content in sources
    ]
    count = len(sources)
    paths_at = unbuned.SOURCE_MAP_HEADER_SIZE
    contents_at = paths_at + unbuned.SOURCE_MAP_POINTER_SIZE * count
    payload_at = contents_at + unbuned.SOURCE_MAP_POINTER_SIZE * count + mapping_length

    payload = bytearray()
    paths = []
    contents = []
    cursor = 0
    for path, content in sources:
        paths.append((cursor, len(path)))
        payload.extend(path)
        cursor += len(path)
    for _path, content in sources:
        contents.append((cursor, len(content)))
        payload.extend(content)
        cursor += len(content)

    blob = bytearray(payload_at)
    struct.pack_into("<II", blob, 0, count, mapping_length)
    for index, item in enumerate(paths):
        struct.pack_into(
            "<II", blob, paths_at + unbuned.SOURCE_MAP_POINTER_SIZE * index,
            payload_at + item[0], item[1],
        )
    for index, item in enumerate(contents):
        struct.pack_into(
            "<II", blob, contents_at + unbuned.SOURCE_MAP_POINTER_SIZE * index,
            payload_at + item[0], item[1],
        )
    blob.extend(payload)
    return bytes(blob)


def build_pe_fixture(section_data):
    pe_offset = 0x80
    optional_header_size = 0
    section_table_offset = pe_offset + 24 + optional_header_size
    raw_offset = 0x200
    raw_size = len(section_data)
    virtual_size = raw_size

    data = bytearray(raw_offset + raw_size)
    data[:2] = b"MZ"
    data[0x3C:0x40] = struct.pack("<I", pe_offset)
    data[pe_offset:pe_offset+4] = b"PE\x00\x00"
    data[pe_offset+6:pe_offset+8] = struct.pack("<H", 1)
    data[pe_offset+20:pe_offset+22] = struct.pack("<H", optional_header_size)

    section_offset = section_table_offset
    data[section_offset:section_offset+8] = b".bun\x00\x00\x00\x00"
    data[section_offset+8:section_offset+12] = struct.pack("<I", virtual_size)
    data[section_offset+16:section_offset+20] = struct.pack("<I", raw_size)
    data[section_offset+20:section_offset+24] = struct.pack("<I", raw_offset)
    data[raw_offset:raw_offset+raw_size] = section_data
    return bytes(data)


def build_macho_fixture(section_data, section_name=b"__bun", include_false_positive=True):
    header_size = 32
    segment_command_size = 72
    section_size = 80
    load_command_size = segment_command_size + section_size
    file_offset = 0x100

    data = bytearray(file_offset + len(section_data))
    struct.pack_into(
        "<IiiIIIII",
        data,
        0,
        unbuned.MH_MAGIC_64,
        0,
        0,
        2,
        1,
        load_command_size,
        0,
        0,
    )

    struct.pack_into(
        "<II16sQQQQiiII",
        data,
        header_size,
        unbuned.LC_SEGMENT_64,
        load_command_size,
        b"__BUN\x00" + (b"\x00" * 10),
        0,
        0x1000,
        file_offset,
        len(section_data),
        3,
        3,
        1,
        0,
    )

    struct.pack_into(
        "<16s16sQQIIIIIIII",
        data,
        header_size + segment_command_size,
        section_name.ljust(16, b"\x00"),
        b"__BUN\x00" + (b"\x00" * 10),
        0,
        len(section_data),
        file_offset,
        0,
        0,
        0,
        0x10000000,
        0,
        0,
        0,
    )

    if include_false_positive:
        false_positive = b"noise // @bun\nconsole.log(\"wrong\");\n"
        data[header_size + load_command_size:header_size + load_command_size + len(false_positive)] = false_positive

    data[file_offset:file_offset+len(section_data)] = section_data
    return bytes(data)


def build_fat_fixture():
    return struct.pack(">II", unbuned.FAT_MAGIC, 1) + b"\x00" * 32


def build_elf_fixture(section_data, endian="<", is_64_bit=True):
    shstrtab_data = b"\x00.shstrtab\x00.bun\x00"
    shoff = 0x100
    shentsize = 64 if is_64_bit else 40
    section_offset = 0x400
    strtab_offset = 0x300
    file_size = section_offset + len(section_data)

    data = bytearray(max(file_size, strtab_offset + len(shstrtab_data), shoff + 3 * shentsize))
    data[0:4] = b"\x7fELF"
    data[4] = 2 if is_64_bit else 1
    data[5] = 1 if endian == "<" else 2
    data[6] = 1

    struct.pack_into(endian + "HHI", data, 0x10, 2, 0x3E, 1)

    if is_64_bit:
        struct.pack_into(endian + "Q", data, 0x28, shoff)
        struct.pack_into(endian + "HHH", data, 0x3A, shentsize, 3, 1)
        sh_fmt = endian + "IIQQQQIIQQ"
    else:
        struct.pack_into(endian + "I", data, 0x20, shoff)
        struct.pack_into(endian + "HHH", data, 0x2E, shentsize, 3, 1)
        sh_fmt = endian + "IIIIIIIIII"

    data[strtab_offset:strtab_offset + len(shstrtab_data)] = shstrtab_data

    null_header = shoff
    strtab_header = shoff + shentsize
    bun_header = shoff + 2 * shentsize

    struct.pack_into(sh_fmt, data, null_header, *([0] * 10))
    struct.pack_into(
        sh_fmt,
        data,
        strtab_header,
        1,
        3,
        0,
        0,
        strtab_offset,
        len(shstrtab_data),
        0,
        0,
        1,
        0,
    )
    struct.pack_into(
        sh_fmt,
        data,
        bun_header,
        11,
        1,
        0,
        0,
        section_offset,
        len(section_data),
        0,
        0,
        1,
        0,
    )
    data[section_offset:section_offset + len(section_data)] = section_data
    return bytes(data)


def build_fat_with_thin_fixture(inner_macho):
    offset = 0x4000
    header = struct.pack(">II", unbuned.FAT_MAGIC, 1) + struct.pack(
        ">iiIII",
        0x0100000C,
        0,
        offset,
        len(inner_macho),
        14,
    )
    padding = b"\x00" * (offset - len(header))
    return header + padding + inner_macho


class ExtractBunJsTests(unittest.TestCase):
    def run_extraction(self, fixture_bytes, filename):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / filename
            fixture_path.write_bytes(fixture_bytes)

            previous_cwd = Path.cwd()
            stdout = io.StringIO()
            try:
                os.chdir(tmp_path)
                with redirect_stdout(stdout):
                    result = unbuned.extract_bun_js(fixture_path)
            finally:
                os.chdir(previous_cwd)

            output_file = tmp_path / "output" / fixture_path.stem / f"{fixture_path.stem}.js"
            extracted = None
            if output_file.exists():
                extracted = output_file.read_text(encoding="utf-8")

            return result, stdout.getvalue(), extracted

    def test_extracts_from_pe_bun_section(self):
        section_data = (
            b"prefix"
            b"// @bun\nconsole.log(\"pe\");\n"
            + bytes(range(1, 64))
        )

        result, output, extracted = self.run_extraction(build_pe_fixture(section_data), "sample.exe")

        self.assertTrue(result)
        self.assertIn(f"Extracted: {Path('output') / 'sample' / 'sample.js'}", output)
        self.assertEqual(extracted, '// @bun\nconsole.log("pe");\n')

    def test_extracts_from_macho_bun_section_and_ignores_false_positive(self):
        section_data = (
            b"/$bunfs/root/sample\x00"
            b"// @bun\nconsole.log(\"mac\");\n"
            b"\x00metadata"
        )

        result, output, extracted = self.run_extraction(build_macho_fixture(section_data), "sample")

        self.assertTrue(result)
        self.assertIn(f"Extracted: {Path('output') / 'sample' / 'sample.js'}", output)
        self.assertEqual(extracted, '// @bun\nconsole.log("mac");\n')

    def test_extracts_from_magic_fallback(self):
        fixture_bytes = (
            b"header"
            + unbuned.BUN_MAGIC
            + b"// @bun\nconsole.log(\"fallback\");\n"
            + bytes(range(1, 32))
        )

        result, output, extracted = self.run_extraction(fixture_bytes, "fallback.bin")

        self.assertTrue(result)
        self.assertIn(f"Extracted: {Path('output') / 'fallback' / 'fallback.js'}", output)
        self.assertEqual(extracted, '// @bun\nconsole.log("fallback");\n')

    def test_reports_missing_macho_bun_section(self):
        section_data = b"// @bun\nconsole.log(\"mac\");\n\x00"

        result, output, _ = self.run_extraction(
            build_macho_fixture(section_data, section_name=b"__txt"),
            "missing-bun",
        )

        self.assertFalse(result)
        self.assertIn("Could not find __BUN,__bun section in Mach-O executable", output)

    def test_reports_invalid_fat_macho(self):
        result, output, _ = self.run_extraction(build_fat_fixture(), "fat-binary")

        self.assertFalse(result)
        self.assertIn("Invalid FAT/universal Mach-O architecture slice", output)

    def test_reports_missing_bundle_for_short_input(self):
        result, output, _ = self.run_extraction(b"MZ", "too-short.exe")

        self.assertFalse(result)
        self.assertIn("Unsupported executable format", output)


class BinaryFidelityTests(unittest.TestCase):
    """The extractor must return bytes, not re-encoded text."""

    def extract(self, section_data, filename="sample.exe"):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / filename
            fixture_path.write_bytes(build_pe_fixture(section_data))

            previous_cwd = Path.cwd()
            try:
                os.chdir(tmp_path)
                with redirect_stdout(io.StringIO()):
                    result = unbuned.extract_bun_js(fixture_path)
            finally:
                os.chdir(previous_cwd)

            output_file = tmp_path / "output" / fixture_path.stem / (fixture_path.stem + ".js")
            return result, output_file.read_bytes() if output_file.exists() else None

    def test_output_preserves_lf_instead_of_translating_to_crlf(self):
        source = b'// @bun\nconsole.log("a");\nconsole.log("b");\n\x00\x01\x02'
        result, extracted = self.extract(source)

        self.assertTrue(result)
        self.assertEqual(extracted, b'// @bun\nconsole.log("a");\nconsole.log("b");\n')
        self.assertEqual(extracted.count(b"\r\n"), 0)
        self.assertEqual(extracted.count(b"\n"), 3)

    def test_output_contains_no_replacement_characters(self):
        source = b'// @bun\nconst a = 1;\n' + bytes(range(200, 256))
        result, extracted = self.extract(source)

        self.assertTrue(result)
        self.assertNotIn(b"\xef\xbf\xbd", extracted)
        self.assertEqual(extracted, b'// @bun\nconst a = 1;\n')

    def test_trailing_binary_is_trimmed_from_output(self):
        source = b'// @bun\nlet x = 1;\n' + bytes(range(128, 256)) + b"\x7d"
        result, extracted = self.extract(source)

        self.assertTrue(result)
        self.assertEqual(extracted, b'// @bun\nlet x = 1;\n')
        self.assertEqual([b for b in extracted if unbuned.is_binary_byte(b)], [])

    def test_utf8_payload_inside_a_module_survives_extraction(self):
        body = b"var s = 'caf\xc3\xa9 \xe2\x9c\x93';\n" * 100
        source = b'// @bun\n' + body + bytes(range(128, 256))
        result, extracted = self.extract(source)

        self.assertTrue(result)
        self.assertTrue(source.startswith(extracted))
        # The end of the region is found statistically, so the final partial
        # line of the last module may be dropped. Losing source is the safe
        # direction; emitting bytecode would not be.
        self.assertGreaterEqual(extracted.count(b"var s ="), 95)
        self.assertIn(b"caf\xc3\xa9 \xe2\x9c\x93", extracted)
        self.assertNotIn(b"\xef\xbf\xbd", extracted)
        extracted.decode("utf-8")


    def test_binary_starting_inside_a_chunk_does_not_truncate_source(self):
        body = "".join("var v%d = %d;\n" % (index, index) for index in range(90))
        source = "// @bun\n" + body
        section_data = source.encode("ascii") + bytes(range(1, 256)) * 12

        self.assertNotEqual(len(source) % 1000, 0)

        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "chunked.exe"
            path.write_bytes(build_pe_fixture(section_data))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.js, source.encode("ascii"))
        self.assertEqual(extraction.js_length, len(source))

    def test_boundary_is_a_code_unit_not_a_window(self):
        wide = '// @bun\nvar wide = "\u00e9\u0410\u4e2d";\nvar after = 1;\n'
        trailer = ''.join(chr(0x80 + (offset % 0x20)) for offset in range(900))
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(build_pe_fixture((wide + trailer).encode("utf-16-le")))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.js_length, len(wide) * 2)
        self.assertEqual(
            unbuned.decode_text(extraction.js, extraction.encoding),
            wide.encode("utf-8"),
        )


class ModuleSplitTests(unittest.TestCase):
    """NUL-delimited `// @bun` module headers must split the bundle."""

    def split(self, section_data):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))
            extraction, error = unbuned.extract_bundle(fixture_path)
            self.assertIsNone(error)
            return extraction

    def test_counts_modules_and_reports_cjs_and_bytecode(self):
        source = (
            b"// @bun\nvar a = 1;\n\x00"
            b"// @bun @bytecode\nvar b = 2;\n\x00"
            b"// @bun @bun-cjs\nmodule.exports = 3;\n\x00"
            b"// @bun @bytecode @bun-cjs\nmodule.exports = 4;\n"
        ) + bytes(range(1, 80))

        extraction = self.split(source)

        modules = extraction.modules()
        self.assertEqual(len(modules), 4)
        self.assertEqual([m.cjs for m in modules], [False, False, True, True])
        self.assertEqual([m.bytecode for m in modules], [False, True, False, True])
        self.assertTrue(extraction.uses_bytecode)

    def test_module_slices_reassemble_into_the_extracted_javascript(self):
        source = b"// @bun\nvar a = 1;\n\x00// @bun @bytecode\nvar b = 2;\n" + bytes(range(1, 90))
        extraction = self.split(source)

        rebuilt = b"".join(
            extraction.js[module.offset:module.offset + module.size]
            for module in extraction.modules()
        )
        self.assertEqual(rebuilt, extraction.js)

    def test_marker_inside_a_string_is_not_a_module(self):
        source = b'// @bun\nvar s = "// @bun\\nnot a header";\nvar t = 1;\n' + bytes(range(1, 90))
        extraction = self.split(source)

        self.assertEqual(len(extraction.modules()), 1)
        self.assertIn(b"not a header", extraction.js)

    def test_module_slugs_are_filesystem_safe(self):
        source = b'// @bun\nimport x from "node:fs/promises";\nvar a = 1;\n' + bytes(range(1, 90))
        extraction = self.split(source)

        slug = extraction.modules()[0].slug
        self.assertTrue(slug)
        self.assertNotIn("/", slug)
        self.assertNotIn("\\", slug)
        self.assertNotIn(":", slug)


def build_graph(entries, entry_point_id=0, startup=0, string_table=True, startup_flag=True):
    base = unbuned.GRAPH_POINTER_BASE
    flags = (1 << 5) | (1 << 6)
    if startup_flag:
        flags |= 1 << 8
    if string_table:
        flags |= 1 << 7

    body = b"// @bun\n"
    sources = b"".join(payload for _name, payload, *_rest in entries)
    sourcemaps = b"".join(
        rest[4] if len(rest) > 4 else b"" for _name, _payload, *rest in entries
    )
    table = bytes(unbuned.GRAPH_FILE_RECORD_SIZE * len(entries))

    source_base = base + len(body)
    sourcemap_base = source_base + len(sources)
    table_base = sourcemap_base + len(sourcemaps)
    hashes_base = table_base + len(table)
    builtin_base = hashes_base + (4 * len(entries))
    cursor = builtin_base + 4
    if string_table:
        cursor += 8
    startup_offset = cursor
    cursor += 4

    name_offsets = []
    for name, _payload, *_rest in entries:
        name_offsets.append(cursor)
        cursor += len(name) + 1
    argv_base = cursor

    sourcemap_offsets = []
    walked = sourcemap_base
    for _name, _payload, *rest in entries:
        sourcemap_offsets.append(walked)
        walked += len(rest[4]) if len(rest) > 4 else 0

    table = bytearray()
    source_cursor = base
    for index, (name, payload, *rest) in enumerate(entries):
        loader = rest[0] if len(rest) > 0 else 1
        module_format = rest[1] if len(rest) > 1 else 1
        side = rest[2] if len(rest) > 2 else 0
        encoding = rest[3] if len(rest) > 3 else 1
        length = len(payload) + (len(body) if index == 0 else 0)
        table.extend(struct.pack("<II", name_offsets[index] - base, len(name) + 1))
        table.extend(struct.pack("<II", source_cursor - base, length))
        sourcemap = rest[4] if len(rest) > 4 else b""
        if sourcemap:
            table.extend(struct.pack(
                "<II", sourcemap_offsets[index] - base, len(sourcemap)
            ))
        else:
            table.extend(struct.pack("<II", 0, 0))
        table.extend(struct.pack("<II", 0, 0))
        table.extend(struct.pack("<II", 0, 0))
        table.extend(struct.pack("<II", 0, 0))
        table.extend(bytes((encoding, loader, module_format, side)))
        source_cursor += length

    blob = bytearray()
    blob.extend(b"\x00" * base)
    blob.extend(body)
    blob.extend(sources)
    blob.extend(sourcemaps)
    blob.extend(table)
    blob.extend(b"\x00\x00\x00\x00" * len(entries))
    blob.extend(struct.pack("<I", 0))
    if string_table:
        blob.extend(struct.pack("<II", 0, 0))
    assert len(blob) == startup_offset, (len(blob), startup_offset)
    blob.extend(struct.pack("<I", startup))
    for name, _payload, *_rest in entries:
        blob.extend(name)
        blob.append(0)
    assert len(blob) == argv_base
    blob.append(0)
    byte_count = len(blob) - base
    blob.extend(struct.pack(
        "<QIIIIII",
        byte_count,
        table_base - base,
        len(table),
        entry_point_id,
        argv_base - base,
        0,
        flags,
    ))
    blob.extend(unbuned.BUN_TRAILER)
    return bytes(blob), source_base, table_base, hashes_base, builtin_base, name_offsets


class ModuleGraphTests(unittest.TestCase):
    """Bun's standalone module graph must yield real embedded file names."""

    def section_from_graph(self, blob):
        return blob

    def test_parses_names_offsets_and_header_metadata(self):
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0),
            (b"B:/~BUN/root/chunk-9fxe9jf7.js\x00", b"// @bun\nvar chunk = 2;\n", 1, 1, 1, 0),
        ]
        blob, source_base, _table_base, _hashes, _builtin, _names = build_graph(
            entries, entry_point_id=0, startup=2
        )
        section = blob

        graph = unbuned.read_module_graph(section)

        self.assertIsNotNone(graph)
        self.assertEqual(len(graph.files), 2)
        self.assertEqual(graph.entry_point_id, 0)
        self.assertEqual(graph.startup_module_count, 2)
        self.assertEqual(
            [entry.name for entry in graph.files],
            [b"B:/~BUN/root/cli", b"B:/~BUN/root/chunk-9fxe9jf7.js"],
        )
        self.assertEqual(graph.files[0].offset, unbuned.GRAPH_POINTER_BASE)
        self.assertEqual(graph.files[0].loader, 1)
        self.assertEqual(graph.files[0].module_format, 1)
        self.assertEqual(graph.files[1].side, 1)

    def test_a_corrupt_builtin_count_cannot_hang_the_startup_walk(self):
        entries = [(b"B:/~BUN/root/cli\x00", b"// @bun\nvar a = 1;\n", 1, 1, 0, 0)]
        blob, _source, table_base, _hashes, _builtin, _names = build_graph(entries, startup=1)
        section = bytearray(blob)
        builtin_count_at = table_base + unbuned.GRAPH_FILE_RECORD_SIZE + 4

        for corrupt in (2, 3, 0xFFFF, 0x10000, 0x7FFFFFFF):
            trial = bytearray(section)
            trial[builtin_count_at:builtin_count_at + 4] = struct.pack("<I", corrupt)
            graph = unbuned.read_module_graph(bytes(trial))

            self.assertIsNotNone(graph)
            self.assertEqual(graph.startup_module_count, 0)

    def test_module_files_use_the_graph_name_when_one_is_known(self):
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nimport fs from \"node:fs\";\nvar a = 1;\n", 1, 1, 0, 0),
        ]
        blob, *_rest = build_graph(entries)
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            extraction, error = unbuned.extract_bundle(fixture)
            self.assertIsNone(error)
            output = root / "out"
            written, manifest = unbuned.write_modules(extraction, output, quiet=True)

        self.assertTrue(written)
        entry = manifest["modules"][0]
        self.assertIn("cli", entry["file"])
        self.assertEqual(entry["name"], "B:/~BUN/root/cli")
        self.assertEqual(manifest["module_graph"]["entry_point"], "B:/~BUN/root/cli")

    def test_startup_count_needs_its_flag_and_a_sane_value(self):
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar a = 1;\n", 1, 1, 0, 0),
            (b"B:/~BUN/root/b.js\x00", b"// @bun\nvar b = 2;\n", 1, 1, 0, 0),
        ]
        without_flag, *_rest = build_graph(entries, startup=2, startup_flag=False)
        graph = unbuned.read_module_graph(self.section_from_graph(without_flag))
        self.assertIsNotNone(graph)
        self.assertEqual(graph.startup_module_count, 0)
        self.assertFalse(graph.flags & unbuned.GRAPH_FLAG_STARTUP_MODULE_COUNT)

        absurd, *_rest = build_graph(entries, startup=99)
        graph = unbuned.read_module_graph(self.section_from_graph(absurd))
        self.assertIsNotNone(graph)
        self.assertEqual(graph.startup_module_count, 0)

    def test_a_name_longer_than_the_scan_limit_is_refused(self):
        limit = unbuned.GRAPH_NAME_LIMIT
        section = b"\x00" * unbuned.GRAPH_POINTER_BASE + b"n" * (limit + 32) + b"\x00"
        self.assertEqual(unbuned.read_graph_string(section, 0, limit + 64), b"")
        shorter = b"\x00" * unbuned.GRAPH_POINTER_BASE + b"n" * (limit - 1) + b"\x00"
        self.assertEqual(
            unbuned.read_graph_string(shorter, 0, limit),
            b"n" * (limit - 1),
        )

    def test_the_graph_is_found_in_every_container_format(self):
        entries = [(b"B:/~BUN/root/cli\x00", b"// @bun\nvar a = 1;\n", 1, 1, 0, 0)]
        blob, *_rest = build_graph(entries, entry_point_id=0, startup=1)
        section = blob

        for builder in (build_pe_fixture, build_macho_fixture, build_elf_fixture):
            with tempfile.TemporaryDirectory() as tmpdir:
                fixture = Path(tmpdir) / "sample.bin"
                fixture.write_bytes(builder(section))
                extraction, error = unbuned.extract_bundle(fixture)

            self.assertIsNone(error)
            self.assertIsNotNone(extraction.graph)
            self.assertEqual(extraction.graph.files[0].name, b"B:/~BUN/root/cli")
            self.assertEqual(unbuned.module_graph_names(extraction), {0: "cli"})

    def test_names_work_for_posix_and_windows_style_graph_paths(self):
        module_graph_name = b"C:/root/chunk-9fxe9jf7.js"
        self.assertEqual(unbuned._slug_from_graph_name(module_graph_name), "chunk-9fxe9jf7")
        self.assertEqual(unbuned._slug_from_graph_name(b"C:\\root\\chunk-9fxe9jf7.js"),
                         "chunk-9fxe9jf7")
        self.assertEqual(unbuned._slug_from_graph_name(b"B:/~BUN/root/cli"), "cli")
        self.assertEqual(unbuned._slug_from_graph_name(b"/home/user/app/main.tsx"), "main")

        self.assertEqual(
            unbuned.asset_name_from_graph(b"/opt/assets/report.md.zst", b"# x", 0)[:2],
            ("report", ".md"),
        )
        self.assertEqual(
            unbuned.asset_name_from_graph(b"assets\\pages\\index.html-aabbccdd.txt.zst",
                                          b"<html>", 0)[:2],
            ("index.html-aabbccdd", ".html"),
        )

    def test_module_names_come_from_the_graph_not_the_import_slug(self):
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nimport fs from \"node:fs\";\nvar a = 1;\n", 1, 1, 0, 0),
        ]
        blob, source_base, _table_base, _hashes, _builtin, _names = build_graph(entries)
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            extraction, error = unbuned.extract_bundle(fixture)
        self.assertIsNone(error)
        module = extraction.modules()[0]

        names = unbuned.module_graph_names(extraction)

        self.assertEqual(module.slug, "node-fs")
        self.assertEqual(names.get(module.offset), "cli")
        self.assertEqual(
            unbuned.module_graph_entry_name(extraction, module.offset),
            b"B:/~BUN/root/cli",
        )

    def test_graph_absent_returns_no_files(self):
        self.assertIsNone(unbuned.read_module_graph(b"not a bun graph"))
        self.assertEqual(unbuned.read_graph_files(b"not a bun graph"), [])

    def test_truncated_or_corrupt_graph_is_rejected(self):
        entries = [(b"B:/~BUN/root/cli\x00", b"// @bun\nvar a = 1;\n", 1, 1, 0, 0)]
        blob, _source, _table, _hashes, _builtin, _names = build_graph(entries)
        section = blob

        self.assertIsNone(unbuned.read_module_graph(section[:-unbuned.GRAPH_HEADER_SIZE]))

        corrupt = bytearray(section)
        corrupt[len(corrupt) - len(unbuned.BUN_TRAILER) - unbuned.GRAPH_HEADER_SIZE] ^= 0xFF
        self.assertIsNone(unbuned.read_module_graph(bytes(corrupt)))

        header = len(section) - len(unbuned.BUN_TRAILER) - unbuned.GRAPH_HEADER_SIZE

        ragged = bytearray(section)
        ragged[header + 12:header + 16] = struct.pack("<I", 7)
        self.assertIsNone(unbuned.read_module_graph(bytes(ragged)))

        overlong = bytearray(section)
        overlong[header + 12:header + 16] = struct.pack("<I", 100)
        self.assertIsNone(unbuned.read_module_graph(bytes(overlong)))

        empty = bytearray(section)
        empty[header + 12:header + 16] = struct.pack("<I", 0)
        self.assertIsNone(unbuned.read_module_graph(bytes(empty)))

        self.assertIsNone(unbuned.read_module_graph(b"\x00" * 64 + unbuned.BUN_TRAILER))

        far = bytearray(section)
        far[header + 8:header + 12] = struct.pack("<I", 0xFFFF0000)
        self.assertIsNone(unbuned.read_module_graph(bytes(far)))

        far_name = bytearray(section)
        far_name[header + 20:header + 24] = struct.pack("<I", 0xFFFF0000)
        graph = unbuned.read_module_graph(bytes(far_name))
        self.assertIsNotNone(graph)
        self.assertEqual(graph.files[0].name, b"B:/~BUN/root/cli")

        unterminated = b"\x00" * unbuned.GRAPH_POINTER_BASE
        unterminated += b"A" * (unbuned.GRAPH_NAME_LIMIT * 2)
        self.assertEqual(unbuned.read_graph_string(unterminated, 0, 4096), b"")

        long_name = b"\x00" * unbuned.GRAPH_POINTER_BASE + b"n" * unbuned.GRAPH_NAME_LIMIT + b"\x00"
        self.assertEqual(
            unbuned.read_graph_string(long_name, 0, unbuned.GRAPH_NAME_LIMIT + 1),
            b"n" * unbuned.GRAPH_NAME_LIMIT,
        )

    def test_manifest_and_report_carry_graph_metadata(self):
        entries = [(b"B:/~BUN/root/cli\x00", b"// @bun\nvar a = 1;\n", 1, 1, 0, 0)]
        blob, _source, _table, _hashes, _builtin, _names = build_graph(entries, startup=1)
        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            extraction, error = unbuned.extract_bundle(fixture)
        self.assertIsNone(error)

        manifest = unbuned.build_manifest(extraction)
        report = unbuned.describe(extraction)

        self.assertEqual(manifest["module_graph"]["file_count"], 1)
        self.assertEqual(manifest["module_graph"]["entry_point"], "B:/~BUN/root/cli")
        self.assertEqual(manifest["module_graph"]["startup_module_count"], 1)
        self.assertIn("has_source_hashes", manifest["module_graph"]["flag_names"])
        self.assertIn("Entry point: B:/~BUN/root/cli", report)
        self.assertIn("Startup modules: 1", report)

    def test_asset_names_drop_bun_plumbing_but_keep_the_hash(self):
        self.assertEqual(
            unbuned.asset_name_from_graph(b"B:/~BUN/root/chart.umd.min.js", b"var a=1;", 0)[:2],
            ("chart.umd.min", ".js"),
        )
        self.assertEqual(
            unbuned.asset_name_from_graph(b"B:/~BUN/root/SKILL-f2840619.md.zst", b"# x", 0)[:2],
            ("SKILL-f2840619", ".md"),
        )
        self.assertEqual(
            unbuned.asset_name_from_graph(
                b"B:/~BUN/root/template.html-fb05d44d.txt.zst", b"<html>", 0
            )[:2],
            ("template.html-fb05d44d", ".html"),
        )


class SourceMapTests(unittest.TestCase):
    """Original sources hidden in Bun's standalone source maps must come back."""

    def build_graph_with_sources(self, sources, assets=(), entry_point_id=0):
        """Build a graph whose first module carries a source map and assets."""
        sourcemap = build_source_map(sources)
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0, sourcemap),
        ]
        for name, payload, loader, encoding in assets:
            entries.append((name, payload, loader, 0, 0, encoding))
        return build_graph(entries, entry_point_id=entry_point_id)[0]

    def test_reads_paths_and_content_ranges_from_a_source_map(self):
        sources = [
            ("src/utils/clock.ts", "export const clock = 1;\n"),
            ("../../node_modules/left-pad/index.js", "module.exports = 1;\n"),
        ]

        paths, contents = unbuned.read_source_map(build_source_map(sources))

        self.assertEqual(paths, [path for path, _content in sources])
        self.assertEqual(len(contents), 2)
        blob = build_source_map(sources)
        for (_path, content), (offset, length) in zip(sources, contents):
            self.assertEqual(blob[offset:offset + length], content.encode())

    def test_the_first_path_must_start_where_the_payload_does(self):
        blob = bytearray(build_source_map([("src/a.ts", "a")]))
        paths_at = unbuned.SOURCE_MAP_HEADER_SIZE

        struct.pack_into("<I", blob, paths_at, struct.unpack_from("<I", blob, paths_at)[0] + 1)

        self.assertIsNone(unbuned.read_source_map(bytes(blob)))

    def test_rejects_source_maps_that_are_empty_or_implausible(self):
        self.assertIsNone(unbuned.read_source_map(b""))
        self.assertIsNone(unbuned.read_source_map(b"\x00" * 8))

        header_only = struct.pack("<II", 0, 0)
        self.assertIsNone(unbuned.read_source_map(header_only))

        absurd = struct.pack("<II", unbuned.SOURCE_MAP_SOURCE_LIMIT + 1, 4)
        self.assertIsNone(unbuned.read_source_map(absurd + b"\x00" * 16))

        truncated = build_source_map([("src/a.ts", "a")])[:-4]
        self.assertIsNone(unbuned.read_source_map(truncated))

    def test_rejects_pointers_that_run_past_the_record(self):
        blob = bytearray(build_source_map([("src/a.ts", "a")]))
        contents_at = unbuned.SOURCE_MAP_HEADER_SIZE + unbuned.SOURCE_MAP_POINTER_SIZE

        struct.pack_into("<II", blob, contents_at, len(blob) + 8, 4)

        self.assertIsNone(unbuned.read_source_map(bytes(blob)))

    def test_normalises_bundler_relative_source_paths(self):
        self.assertEqual(
            unbuned.source_output_path("../../node_modules/left-pad/index.js"),
            "node_modules/left-pad/index.js",
        )
        self.assertEqual(unbuned.source_output_path("./src/utils/clock.ts"), "src/utils/clock.ts")
        self.assertEqual(unbuned.source_output_path("src\\win\\path.ts"), "src/win/path.ts")
        self.assertEqual(unbuned.source_output_path("C:\\src\\drive.ts"), "C-/src/drive.ts")
        self.assertIsNone(unbuned.source_output_path("../../.."))
        self.assertIsNone(unbuned.source_output_path(""))
        self.assertEqual(unbuned.source_output_path("src/a?b.ts"), "src/a-b.ts")

    def test_graph_sources_keep_their_module_attribution(self):
        sources = [("src/index.ts", "export const a = 1;\n")]
        blob = self.build_graph_with_sources(sources)

        graph_sources = unbuned.read_graph_sources(blob, unbuned.read_module_graph(blob))

        self.assertEqual(len(graph_sources), 1)
        self.assertEqual(graph_sources[0].path, "src/index.ts")
        self.assertEqual(graph_sources[0].module_index, 0)
        self.assertEqual(graph_sources[0].module_name, "B:/~BUN/root/cli")
        self.assertEqual(
            blob[graph_sources[0].offset:][:len(sources[0][1])],
            sources[0][1].encode(),
        )

    def test_a_record_shorter_than_its_own_header_is_refused(self):
        for size in range(0, 24):
            blob = struct.pack("<II", 1, 7) + b"\x00" * max(0, size - 8)
            self.assertIsNone(unbuned.read_source_map(blob), size)

    def test_a_path_pointer_that_leaves_the_record_is_refused(self):
        blob = bytearray(build_source_map([("src/a.ts", "a"), ("src/b.ts", "b")]))
        paths_at = unbuned.SOURCE_MAP_HEADER_SIZE

        struct.pack_into("<II", blob, paths_at + unbuned.SOURCE_MAP_POINTER_SIZE, 0, 4)

        self.assertIsNone(unbuned.read_source_map(bytes(blob)))

    def test_a_source_count_above_the_limit_is_refused(self):
        limit = unbuned.SOURCE_MAP_SOURCE_LIMIT
        unbuned.SOURCE_MAP_SOURCE_LIMIT = 1
        try:
            blob = build_source_map([("src/a.ts", "a"), ("src/b.ts", "b")])
            self.assertIsNone(unbuned.read_source_map(blob))
        finally:
            unbuned.SOURCE_MAP_SOURCE_LIMIT = limit

    def test_a_source_shared_between_chunks_is_written_once(self):
        shared = "export const shared = 1;\n"
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0,
             build_source_map([("src/shared.ts", shared)])),
            (b"B:/~BUN/root/other.js\x00", b"// @bun\nvar other = 2;\n", 1, 1, 0, 0,
             build_source_map([("src/shared.ts", shared), ("src/extra.ts", "const e = 1;\n")])),
        ]
        blob = build_graph(entries)[0]

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_sources=True)

            written = sorted(
                path.relative_to(output / "sources").as_posix()
                for path in (output / "sources").rglob("*") if path.is_file()
            )
            manifest = json.loads((output / "sources" / "sources.json").read_text(encoding="utf-8"))

        self.assertEqual(written, ["sources.json", "src/extra.ts", "src/shared.ts"])
        self.assertEqual(manifest["source_count"], 3)
        self.assertEqual(manifest["unique_paths"], 2)
        self.assertEqual(manifest["duplicate_sources"], 1)
        duplicated = [entry for entry in manifest["sources"] if entry["duplicate"]]
        self.assertEqual(len(duplicated), 1)
        self.assertEqual(duplicated[0]["module_index"], 1)
        self.assertTrue(duplicated[0]["identical_to_written"])

    def test_sources_are_written_under_their_recorded_paths(self):
        sources = [
            ("src/utils/clock.ts", "export const clock = 1;\n"),
            ("../../node_modules/left-pad/index.js", "module.exports = 1;\n"),
        ]
        blob = self.build_graph_with_sources(sources)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                result = unbuned.extract_bun_js(
                    fixture, output_dir=output, dump_sources=True,
                )

            self.assertTrue(result)
            written = output / "sources" / "src" / "utils" / "clock.ts"
            self.assertEqual(written.read_bytes(), sources[0][1].encode())
            shared = output / "sources" / "node_modules" / "left-pad" / "index.js"
            self.assertEqual(shared.read_bytes(), sources[1][1].encode())
            manifest = json.loads((output / "sources" / "sources.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["source_count"], 2)
        self.assertEqual(manifest["unique_paths"], 2)
        self.assertEqual(manifest["module_records"], 1)
        self.assertEqual(manifest["duplicate_sources"], 0)
        self.assertEqual(
            sorted(entry["path"] for entry in manifest["sources"]),
            sorted(path for path, _content in sources),
        )
        self.assertIn("Sources: 2 files", stdout.getvalue())

    def test_a_manifest_written_by_the_project_is_not_clobbered(self):
        sources = [("sources.json", "{}"), ("src/a.ts", "export const a = 1;\n")]
        blob = self.build_graph_with_sources(sources)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_sources=True)

            self.assertEqual((output / "sources" / "sources.json").read_bytes(), b"{}")
            manifest = json.loads((output / "sources" / "_sources.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["source_count"], 2)

    def test_source_frames_are_not_written_as_assets(self):
        stored = b"\x28\xb5\x2f\xfd" + b"compressed original source"
        sources = [("src/utils/clock.ts", stored)]
        assets = [(b"B:/~BUN/root/skill.md-abcdef12.asset\x00", b"---\nname: skill\n", 5, 1)]
        blob = self.build_graph_with_sources(sources, assets=assets)

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(
                    fixture, output_dir=output, dump_assets=True, dump_sources=True,
                )

            manifest = json.loads((output / "assets" / "assets.json").read_text(encoding="utf-8"))
            source_offsets = set(
                entry["section_offset"]
                for entry in json.loads(
                    (output / "sources" / "sources.json").read_text(encoding="utf-8")
                )["sources"]
            )

        self.assertEqual(manifest["asset_count"], 1)
        self.assertNotIn(manifest["assets"][0]["section_offset"], source_offsets)
        self.assertEqual(manifest["assets"][0]["file"].endswith("skill.md-abcdef12.md"), True)

    def test_sources_are_decompressed_when_a_zstd_binding_exists(self):
        try:
            import zstandard
        except ImportError:
            self.skipTest("zstandard is not installed")

        content = "export const decompressed = true;\n"
        compressed = zstandard.ZstdCompressor().compress(content.encode())
        blob = self.build_graph_with_sources([("src/packed.ts", compressed)])

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_sources=True)

            written = (output / "sources" / "src" / "packed.ts").read_bytes()

        self.assertEqual(written, content.encode())

    def test_extraction_and_manifest_report_source_counts(self):
        blob = self.build_graph_with_sources(
            [("src/index.ts", "export const a = 1;\n"), ("src/other.ts", "export const b = 2;\n")]
        )

        with tempfile.TemporaryDirectory() as tmpdir:
            fixture = Path(tmpdir) / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            extraction, error = unbuned.extract_bundle(fixture)

        self.assertIsNone(error)
        self.assertEqual(extraction.source_count, 2)
        self.assertEqual(extraction.source_paths, 2)
        self.assertEqual(extraction.source_map_count, 1)
        manifest = unbuned.build_manifest(extraction)
        self.assertEqual(manifest["source_maps"]["source_count"], 2)
        self.assertEqual(manifest["source_maps"]["module_records"], 1)
        self.assertIn("Sources: 2 original files", unbuned.describe(extraction))


class FormatterEscapingTests(unittest.TestCase):
    """The formatter must never split a token that JavaScript cannot rejoin."""

    def test_an_escape_inside_an_identifier_stays_one_token(self):
        source = 'var o={espa\\u{f1}ol:"es",other:1};'

        formatted = unbuned.beautify_js(source, indent="  ", wrap_at=0)

        self.assertIn('\\u{f1}ol', formatted)
        self.assertNotIn('\\u ', formatted)
        self.assertEqual(
            "".join(source.split()),
            "".join(formatted.split()),
        )

    def test_an_arrow_is_never_wrapped_onto_its_own_line(self):
        source = "var f=" + "a" * 30 + "(t)=>Y9t(t);"

        formatted = unbuned.beautify_js(source, indent="  ", wrap_at=40)

        self.assertGreater(len(source), 40)
        self.assertIn("(t) =>", formatted)
        for line in formatted.splitlines():
            self.assertFalse(line.strip().startswith("=>"), line)

    def test_a_long_regex_is_not_formatted_as_code(self):
        body = "\\uD83C" * 600
        source = "var re=/" + body + "/;var hit=re.test(x);"

        formatted = unbuned.beautify_js(source, indent="  ", wrap_at=100)

        self.assertIn("/" + body + "/", formatted)
        self.assertNotIn("(? :", formatted)
        self.assertEqual(
            "".join(source.split()),
            "".join(formatted.split()),
        )

    def test_division_still_reads_as_division_after_the_raise(self):
        source = "var q=a/b/c/d/e;"

        formatted = unbuned.beautify_js(source, indent="  ", wrap_at=100)

        self.assertEqual(
            "".join(source.split()),
            "".join(formatted.split()),
        )


class Utf16BundleTests(unittest.TestCase):
    """Bundles whose JavaScript is stored as UTF-16 rather than plain bytes."""

    WIDE_SOURCE = '// @bun\nvar greeting = "wide";\nconsole.log(greeting);\n'

    def build_wide_fixture(self, source, encoding):
        """
        Build a PE fixture whose Bun section holds UTF-16 encoded source.

        The trailer is encoded too and is built from C1 control characters,
        which are binary in any encoding rather than merely printable.

        Args:
            source (str): JavaScript text to embed.
            encoding (str): Text encoding to store it in.

        Returns:
            bytes: A complete PE image carrying the wide bundle.
        """
        trailer = ''.join(chr(0x80 + (offset % 0x20)) for offset in range(600))
        return build_pe_fixture((source + trailer).encode(encoding))

    def test_detects_little_endian_marker(self):
        bundle = self.WIDE_SOURCE.encode("utf-16-le")
        offset, encoding = unbuned.detect_bun_marker(bundle)
        self.assertEqual(offset, 0)
        self.assertEqual(encoding, "utf-16-le")

    def test_detects_big_endian_marker(self):
        bundle = self.WIDE_SOURCE.encode("utf-16-be")
        offset, encoding = unbuned.detect_bun_marker(bundle)
        self.assertEqual(offset, 0)
        self.assertEqual(encoding, "utf-16-be")

    def test_plain_marker_is_not_mislabelled_as_wide(self):
        offset, encoding = unbuned.detect_bun_marker(b"// @bun\nvar a = 1;\n")
        self.assertEqual(offset, 0)
        self.assertIsNone(encoding)

    def test_missing_marker_reports_no_encoding(self):
        self.assertEqual(unbuned.detect_bun_marker(b"no javascript here"),
                         (None, None))

    def test_non_text_ratio_ignores_utf16_padding(self):
        plain = self.WIDE_SOURCE.encode("ascii")
        wide = self.WIDE_SOURCE.encode("utf-16-le")
        self.assertEqual(unbuned.non_text_ratio(plain), 0.0)
        self.assertEqual(unbuned.non_text_ratio(wide, "utf-16-le"), 0.0)
        self.assertGreater(unbuned.non_text_ratio(wide), 0.0)

    def test_extracts_from_utf16le_section(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(self.build_wide_fixture(self.WIDE_SOURCE, "utf-16-le"))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.encoding, "utf-16-le")
        self.assertEqual(extraction.module_count, 1)
        self.assertEqual(extraction.js_length, len(self.WIDE_SOURCE) * 2)
        self.assertEqual(
            unbuned.decode_text(extraction.js, extraction.encoding),
            self.WIDE_SOURCE.encode("utf-8"),
        )

    def test_extracts_from_utf16be_section(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(self.build_wide_fixture(self.WIDE_SOURCE, "utf-16-be"))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.encoding, "utf-16-be")
        self.assertEqual(
            unbuned.decode_text(extraction.js, extraction.encoding),
            self.WIDE_SOURCE.encode("utf-8"),
        )

    def test_trailing_binary_is_trimmed_from_wide_bundle(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(self.build_wide_fixture(self.WIDE_SOURCE, "utf-16-le"))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertLess(extraction.js_length, extraction.section_size)
        self.assertEqual(
            unbuned.decode_text(extraction.js, extraction.encoding),
            self.WIDE_SOURCE.encode("utf-8"),
        )

    def test_offsets_stay_in_raw_byte_space(self):
        first = '// @bun\nvar a = 1;\n'
        source = first + '// @bun\nvar b = 2;\n'
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(self.build_wide_fixture(source, "utf-16-le"))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.module_count, 2)
        self.assertEqual(
            [header[0] for header in extraction.module_headers],
            [0, len(first) * 2],
        )
        self.assertEqual(
            [module.slug for module in extraction.modules()],
            ["var-a-1", "var-b-2"],
        )

    def test_marker_inside_a_string_is_not_a_module(self):
        source = '// @bun\nvar text = "\\n// @bun\\nvar c = 3;";\n'
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "wide.exe"
            path.write_bytes(self.build_wide_fixture(source, "utf-16-le"))
            extraction, error = unbuned.extract_bundle(path)

        self.assertIsNone(error)
        self.assertEqual(extraction.module_count, 1)

    def run_container(self, fixture_bytes, filename):
        """
        Extract a fixture through the public entry point and read the result.

        Args:
            fixture_bytes (bytes): Complete container image.
            filename (str): Name to give the fixture on disk.

        Returns:
            bytes: The written JavaScript file, empty when nothing was written.
        """
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / filename
            fixture_path.write_bytes(fixture_bytes)

            previous_cwd = Path.cwd()
            try:
                os.chdir(tmp_path)
                with redirect_stdout(io.StringIO()):
                    unbuned.extract_bun_js(fixture_path)
            finally:
                os.chdir(previous_cwd)

            output_file = tmp_path / "output" / fixture_path.stem / (fixture_path.stem + ".js")
            return output_file.read_bytes() if output_file.exists() else b""

    def test_utf16_survives_every_container(self):
        source = '// @bun\nvar wide = "utf16";\nconsole.log(wide);\n'
        trailer = "".join(chr(0x80 + (offset % 0x20)) for offset in range(600))

        for encoding in ("utf-16-le", "utf-16-be"):
            blob = (source + trailer).encode(encoding)
            containers = (
                ("pe", build_pe_fixture(blob)),
                ("macho", build_macho_fixture(blob)),
                ("elf", build_elf_fixture(blob)),
                ("fat", build_fat_with_thin_fixture(build_macho_fixture(blob))),
            )
            for name, fixture in containers:
                with self.subTest(encoding=encoding, container=name):
                    self.assertEqual(
                        self.run_container(fixture, "wide-" + name),
                        source.encode("utf-8"),
                    )

    def test_nul_terminator_respects_the_code_unit_grid(self):
        self.assertEqual(unbuned.find_code_unit_nul(b"a\x00b", None), 1)
        self.assertEqual(unbuned.find_code_unit_nul("a\x00b".encode("utf-16-le"),
                                                    "utf-16-le"), 2)
        self.assertEqual(unbuned.find_code_unit_nul(b"no terminator here", None), None)


    def test_written_output_is_utf8_without_padding(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            path = tmp_path / "wide.exe"
            path.write_bytes(self.build_wide_fixture(self.WIDE_SOURCE, "utf-16-le"))

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = unbuned.main([str(path), "-o", str(tmp_path / "out")])

            written = (tmp_path / "out" / "wide.js").read_bytes()

        self.assertEqual(code, 0)
        self.assertNotIn(b"\x00", written)
        self.assertEqual(written, self.WIDE_SOURCE.encode("utf-8"))

    def test_module_file_is_decoded_to_utf8(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            path = tmp_path / "wide.exe"
            path.write_bytes(self.build_wide_fixture(self.WIDE_SOURCE, "utf-16-le"))

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = unbuned.main([str(path), "-o", str(tmp_path / "out"), "--modules"])

            manifest = json.loads((tmp_path / "out" / "manifest.json").read_text())
            written = (tmp_path / "out" / manifest["modules"][0]["file"]).read_bytes()

        self.assertEqual(code, 0)
        self.assertNotIn(b"\x00", written)
        self.assertEqual(written, self.WIDE_SOURCE.encode("utf-8"))
        self.assertEqual(manifest["modules"][0]["header"], "// @bun")
        self.assertEqual(manifest["javascript"]["encoding"], "utf-16-le")


class ElfAndFatTests(unittest.TestCase):
    """ELF section parsing and universal Mach-O slice selection."""

    def test_extracts_from_elf_bun_section(self):
        section_data = b'// @bun\nconsole.log("elf");\n' + bytes(range(128, 200))
        result, output, extracted = self._run(build_elf_fixture(section_data), "sample-elf")

        self.assertTrue(result)
        self.assertEqual(extracted, '// @bun\nconsole.log("elf");\n')

    def test_extracts_from_elf_bun_section_big_endian(self):
        section_data = b'// @bun\nconsole.log("elf-be");\n' + bytes(range(128, 200))
        result, _output, extracted = self._run(
            build_elf_fixture(section_data, endian=">"),
            "sample-elf-be",
        )

        self.assertTrue(result)
        self.assertEqual(extracted, '// @bun\nconsole.log("elf-be");\n')

    def test_extracts_first_slice_of_universal_macho(self):
        inner = build_macho_fixture(
            b"/$bunfs/root/sample\x00// @bun\nconsole.log(\"fat\");\n\x00metadata"
        )
        result, _output, extracted = self._run(build_fat_with_thin_fixture(inner), "sample-fat")

        self.assertTrue(result)
        self.assertEqual(extracted, '// @bun\nconsole.log("fat");\n')

    def test_reports_missing_cpu_type_in_universal_macho(self):
        inner = build_macho_fixture(b"// @bun\nconsole.log(\"fat\");\n\x00")
        slices, error = unbuned.parse_fat_arches(build_fat_with_thin_fixture(inner))

        self.assertIsNone(error)
        self.assertEqual(len(slices), 1)

        _offset, _size, message = unbuned.select_fat_slice(
            build_fat_with_thin_fixture(inner),
            0x01000007,
        )
        self.assertIn("not present", message)

    def _run(self, fixture_bytes, filename):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / filename
            fixture_path.write_bytes(fixture_bytes)

            previous_cwd = Path.cwd()
            stdout = io.StringIO()
            try:
                os.chdir(tmp_path)
                with redirect_stdout(stdout):
                    result = unbuned.extract_bun_js(fixture_path)
            finally:
                os.chdir(previous_cwd)

            output_file = tmp_path / "output" / fixture_path.stem / (fixture_path.stem + ".js")
            extracted = output_file.read_text(encoding="utf-8") if output_file.exists() else None
            return result, stdout.getvalue(), extracted


class AssetExtractionTests(unittest.TestCase):
    """Zstandard-embedded non-JavaScript assets must be recoverable."""

    def test_finds_zstd_frames_in_a_buffer(self):
        prefix = b"// @bun\nvar a = 1;\n\x00"
        buf = prefix + b"\x28\xb5\x2f\xfd" + b"compressed" + b"// @bun\nvar b = 2;\n"

        frames = unbuned.find_zstd_frames(buf)

        self.assertEqual(frames, [len(prefix)])

    def test_sniffs_markdown_front_matter(self):
        raw = b"---\nname: my-skill\ndescription: does a thing\n---\n\n# My Skill\n"

        name, extension, kind = unbuned.sniff_asset(raw, 0)

        self.assertEqual(name, "my-skill")
        self.assertEqual(extension, ".md")
        self.assertEqual(kind, "markdown")

    def test_sniffs_html_title(self):
        raw = b"<!DOCTYPE html>\n<html><head><title>Workshop Page</title></head>"

        name, extension, kind = unbuned.sniff_asset(raw, 0)

        self.assertEqual(name, "Workshop-Page")
        self.assertEqual(extension, ".html")
        self.assertEqual(kind, "html")

    def test_sniffs_falls_back_to_a_placeholder(self):
        name, extension, kind = unbuned.sniff_asset(b"\x01\x02\x03binary", 7)

        self.assertEqual(name, "asset-0007")
        self.assertEqual(extension, ".txt")

    def test_asset_dump_degrades_without_a_zstd_binding(self):
        source = b"// @bun\nvar a = 1;\n" + b"\x28\xb5\x2f\xfd" + bytes(range(1, 60)) + bytes(range(1, 40))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(source))
            output_dir = tmp_path / "out"

            with redirect_stdout(io.StringIO()):
                result = unbuned.extract_bun_js(
                    fixture_path,
                    output_dir=output_dir,
                    dump_assets=True,
                )

            self.assertTrue(result)
            manifest = json.loads((output_dir / "assets" / "assets.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["asset_count"], 1)
            self.assertIn("assets", manifest)
            self.assertEqual(len(manifest["assets"]), 1)


    def test_assets_are_sliced_by_their_recorded_length(self):
        payload = b"MZ\x90\x00" + b"\x00" * 12 + b"binary helper"
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0),
            (b"B:/~BUN/root/helper-\x00", payload, 5, 0, 0, 0),
        ]
        blob = build_graph(entries)[0]

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_assets=True)

            files = sorted((output / "assets").glob("*helper*"))
            written = files[0].read_bytes() if files else None
            manifest = json.loads((output / "assets" / "assets.json").read_text(encoding="utf-8"))

        self.assertEqual(len(files), 1)
        self.assertEqual(written, payload)
        self.assertEqual(manifest["assets"][0]["section_bytes"], len(payload))
        self.assertFalse(manifest["assets"][0]["compressed"])

    def test_utf16_assets_are_written_as_utf8(self):
        text = "---\nname: skill\ndescription: does a thing\n---\n"
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0),
            (b"B:/~BUN/root/SKILL-aabbccdd.md\x00", text.encode("utf-16-le"), 13, 0, 0, 2),
        ]
        blob = build_graph(entries)[0]

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(blob))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_assets=True)

            files = sorted((output / "assets").glob("*SKILL*"))
            written = files[0].read_bytes() if files else None
            manifest = json.loads((output / "assets" / "assets.json").read_text(encoding="utf-8"))

        self.assertEqual(len(files), 1)
        self.assertEqual(written, text.encode())
        self.assertTrue(manifest["assets"][0]["transcoded"])
        self.assertEqual(manifest["assets"][0]["encoding"], "utf16")

    def test_a_duplicated_graph_asset_pointer_is_written_once(self):
        payload = b"---\nname: skill\ndescription: does a thing\n---\n"
        entries = [
            (b"B:/~BUN/root/cli\x00", b"// @bun\nvar cli = 1;\n", 1, 1, 0, 0),
            (b"B:/~BUN/root/skill-aabbccdd.md\x00", payload, 13, 0, 0, 1),
            (b"B:/~BUN/root/other-ddeeff00.md\x00", payload, 13, 0, 0, 1),
        ]
        blob, _source, table_base, *_rest = build_graph(entries)

        first = table_base + unbuned.GRAPH_FILE_RECORD_SIZE
        second = table_base + 2 * unbuned.GRAPH_FILE_RECORD_SIZE
        section = bytearray(blob)
        struct.pack_into("<II", section, second + 8, *struct.unpack_from("<II", section, first + 8))

        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            fixture = root / "sample.exe"
            fixture.write_bytes(build_pe_fixture(bytes(section)))
            output = root / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture, output_dir=output, dump_assets=True)

            manifest = json.loads((output / "assets" / "assets.json").read_text(encoding="utf-8"))

        self.assertEqual(manifest["asset_count"], 1)
        self.assertEqual(manifest["named_from_module_graph"], 1)
        self.assertEqual(manifest["assets"][0]["name"], "B:/~BUN/root/skill-aabbccdd.md")

    def test_native_assets_are_named_from_their_magic(self):
        self.assertEqual(unbuned.binary_format_extension(b"MZ\x90\x00rest"), ".exe")
        self.assertEqual(unbuned.binary_format_extension(b"\x7fELF\x02rest"), ".so")
        self.assertEqual(unbuned.binary_format_extension(b"\xcf\xfa\xed\xferest"), ".dylib")
        self.assertIsNone(unbuned.binary_format_extension(b"---\nname: skill"))
        self.assertIsNone(unbuned.binary_format_extension(None))

        name, extension, kind = unbuned.asset_name_from_graph(
            b"B:/~BUN/root/keytar-aabbccdd.", b"MZ\x90\x00rest", 0,
        )
        self.assertEqual((name, extension), ("keytar-aabbccdd", ".exe"))
        self.assertEqual(kind, "binary")

    def test_a_dll_named_by_the_graph_keeps_its_extension(self):
        name, extension, kind = unbuned.asset_name_from_graph(
            b"B:/~BUN/root/fff_c-aabbccdd.dll", b"MZ\x90\x00rest", 0,
        )

        self.assertEqual((name, extension), ("fff_c-aabbccdd", ".dll"))
        self.assertEqual(kind, "binary")

    def test_the_placeholder_asset_extension_is_recovered(self):
        name, extension, kind = unbuned.asset_name_from_graph(
            b"B:/~BUN/root/authentication.md-kckwz2e2.asset", b"# Authentication Pattern", 0,
        )

        self.assertEqual((name, extension), ("authentication.md-kckwz2e2", ".md"))
        self.assertEqual(kind, "markdown")


class CommandLineTests(unittest.TestCase):
    """Argument parsing and the non-writing inspection modes."""

    def test_inspect_writes_nothing_and_reports_modules(self):
        section_data = b"// @bun\nvar a = 1;\n\x00// @bun @bytecode\nvar b = 2;\n" + bytes(range(1, 90))
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = unbuned.main([str(fixture_path), "--inspect"])

            self.assertEqual(code, 0)
            self.assertIn("Modules: 2", stdout.getvalue())
            self.assertFalse((tmp_path / "output").exists())

    def test_inspect_json_is_machine_readable(self):
        section_data = b"// @bun\nvar a = 1;\n" + bytes(range(1, 90))
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                code = unbuned.main([str(fixture_path), "--inspect", "--json"])

            payload = json.loads(stdout.getvalue())
            self.assertEqual(code, 0)
            self.assertEqual(payload["container"], "pe")
            self.assertEqual(payload["module_count"], 1)
            self.assertNotIn("modules", payload)
            self.assertFalse(payload["bytecode_compiled"])

    def test_modules_flag_writes_manifest_and_per_module_files(self):
        section_data = (
            b"// @bun\nvar a = 1;\n\x00// @bun @bytecode\nvar b = 2;\n"
        ) + bytes(range(1, 90))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))
            output_dir = tmp_path / "out"

            with redirect_stdout(io.StringIO()):
                result = unbuned.extract_bun_js(fixture_path, output_dir=output_dir, split_modules=True)

            self.assertTrue(result)
            manifest = json.loads((output_dir / "manifest.json").read_text(encoding="utf-8"))
            module_files = sorted((output_dir / "modules").glob("*.js"))

            self.assertEqual(manifest["module_count"], 2)
            self.assertEqual(len(module_files), 2)
            self.assertTrue(manifest["bytecode_compiled"])
            self.assertTrue(all(entry["file"].startswith("modules/") for entry in manifest["modules"]))

    def test_missing_file_reports_an_error(self):
        stdout = io.StringIO()
        with redirect_stdout(stdout):
            code = unbuned.main(["does-not-exist.exe", "--inspect"])

        self.assertEqual(code, 1)
        self.assertIn("File not found", stdout.getvalue())


class FormatTests(unittest.TestCase):
    def assertFormatted(self, source, expected, **kwargs):
        self.assertEqual(unbuned.beautify_js(source, **kwargs), expected)

    def assertEquivalent(self, source, **kwargs):
        result = unbuned.beautify_js(source, **kwargs)
        self.assertEqual("".join(source.split()), "".join(result.split()))
        return result

    def assertQuotedTextIntact(self, source, **kwargs):
        result = self.assertEquivalent(source, **kwargs)
        for literal in re.findall(r'"[^"\n]*"|\'[^\'\n]*\'', source):
            self.assertIn(literal, result)
        return result

    def test_indents_blocks_and_breaks_statements(self):
        self.assertFormatted(
            "function f(a,b){if(a>b){return a+b}else{return a-b}}",
            "function f(a, b) {\n"
            "  if (a > b) {\n"
            "    return a + b\n"
            "  } else {\n"
            "    return a - b\n"
            "  }\n"
            "}\n",
        )

    def test_breaks_object_and_array_literals(self):
        self.assertFormatted(
            "x={a:1,b:[2,3]};",
            "x = {\n  a: 1,\n  b: [\n    2,\n    3\n  ]\n};\n",
        )

    def test_keeps_empty_braces_inline(self):
        self.assertFormatted("f(a,{},function(){});", "f(a, {}, function() {});\n")

    def test_spaces_keyword_control_heads(self):
        self.assertFormatted("if(a)b();else if(c)d();else e();", "if (a) b();\nelse if (c) d();\nelse e();\n")
        self.assertFormatted("for(let i=0;i<3;i++)f();", "for (let i = 0; i < 3; i++) f();\n")
        self.assertFormatted("while(x)y();", "while (x) y();\n")
        self.assertFormatted("try{a()}catch(e){b()}", "try {\n  a()\n} catch (e) {\n  b()\n}\n")

    def test_pads_operators_without_changing_unary_use(self):
        self.assertFormatted("a=b+c*d;", "a = b + c * d;\n")
        self.assertFormatted("a+=1;a-=1;a/=2;a*=3;", "a += 1;\na -= 1;\na /= 2;\na *= 3;\n")
        self.assertFormatted("f(-1,+2,!a,~b,c++ +d,e-- -g);", "f(-1, +2, !a, ~b, c++ + d, e-- - g);\n")
        self.assertFormatted("a?b:c;", "a ? b : c;\n")
        self.assertFormatted("x=a.b?.c?.[0];", "x = a.b?.c?.[0];\n")

    def test_keeps_templates_and_regex_intact(self):
        self.assertFormatted("t=`a${b}c${`d${e}`}`;", "t = `a${b}c${`d${e}`}`;\n")
        self.assertFormatted("r=/[{](\\/|a\\/b)/gi;", "r = /[{](\\/|a\\/b)/gi;\n")
        self.assertFormatted("if(!r.test(s))return/[/]/.test(x);", "if (!r.test(s)) return /[/]/.test(x);\n")
        self.assertFormatted("a=b/c;d=e/(f+g);", "a = b / c;\nd = e / (f + g);\n")

    def test_does_not_touch_string_or_comment_contents(self):
        self.assertFormatted(
            'var s="a{b}//c",t=/[{]/;/*x*/var b=1;',
            'var s = "a{b}//c",\nt = /[{]/;\n/*x*/var b = 1;\n',
        )

    def test_indents_switch_cases(self):
        self.assertFormatted(
            "switch(a){case 1:b();break;default:c()}",
            "switch (a) {\n  case 1:\n    b();\n    break;\n  default:\n    c()\n}\n",
        )

    def test_keeps_import_specifier_lists_on_one_line(self):
        self.assertFormatted(
            'import{a as b,c}from"m";',
            'import {a as b, c} from "m";\n',
        )

    def test_wraps_long_lines_at_safe_points(self):
        result = unbuned.beautify_js(
            "call(firstArgumentName, secondArgumentName, thirdArgumentName, "
            "fourthArgumentName, fifthArgumentName, sixthArgumentName, seventhArgumentName);"
        )
        lines = result.strip().split("\n")
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertLessEqual(len(line), 102)

    def test_wrap_can_be_disabled(self):
        source = "call(" + ", ".join("argument%d" % i for i in range(40)) + ");"
        self.assertEqual(unbuned.beautify_js(source, wrap_at=0), source + "\n")

    def test_indent_width_is_configurable(self):
        self.assertFormatted("if(a){b()}", "if (a) {\n    b()\n}\n", indent="    ")

    def test_preserves_token_stream_on_tricky_input(self):
        cases = [
            "a/=2;b*=3;c**=2;d>>=1;e instanceof F;g in h;",
            "for(;;)break;do x();while(y);",
            "l1:l2:for(;;)break l1;",
            "async function*g(){for await(const x of y)yield* x}",
            "x=a?b:c,d=e??f,g=h?.i,j=k?.[0];",
            "new A(1,-1,+2,!0,~3,a- -b,a-- -b,c++ +d);",
            "if(a)/re/.test(b);while(x)y/2;",
            "var re2=/[/]/,d=a/b/c;",
            "a=`${`${a}`}`;b=1/2;c='p;q';",
            "f(...args,g(1,2),{h:[1,3]},()=>({i:1}));",
            "if(a)\n  b();\nelse\n  c();",
            "unterminated = {a:1,",
            "class A{static#p=1;get v(){return this.#p}}",
            "x = {} / 2;",
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assertEquivalent(source)

    def test_quotes_never_pair_across_code(self):
        cases = [
            'h===""?this.indentate(l)+"<"+i+u+"?"+this.tagEndChar;',
            'p=f.endsWith("/")?f.slice(0,-1)+r:f+r;',
            'm.headers["content-length"]=String(n);',
            's.message=d??"Unknown";let q=L.for("smithy.ts."+c),b=q.get();',
            'throw new T({name:d},f);',
        ]
        for source in cases:
            with self.subTest(source=source):
                self.assertQuotedTextIntact(source)

    def test_regex_slashes_stay_inside_the_pattern(self):
        result = self.assertQuotedTextIntact(
            'e.replace(/&/g,"&amp;").replace(/[<>]/g,"&lt;").replace(/\\//g,"/");'
        )
        self.assertIn('/&/g', result)
        self.assertIn('/[<>]/g', result)
        self.assertIn('/\\//g', result)

    def test_template_text_survives_a_run_of_code_before_it(self):
        source = (
            'var E=E(function(J){return J.parseXML({from:!1})});'
            'process.emitWarning(`NodeDeprecationWarning: will\\nno longer support Node.js.\\n\\n'
            'More information can be found at: https://a.co/74kJMmI`);'
        )
        result = self.assertEquivalent(source)
        self.assertIn('at: https://a.co/74kJMmI', result)
        self.assertNotIn('at : https : //', result)

    def test_regex_starting_with_equals_is_not_an_assignment(self):
        result = self.assertQuotedTextIntact('t.replace(/=/g,"-").replace(/\\//g,"_")')
        self.assertIn('/=/g', result)
        self.assertIn('/\\//g', result)
        self.assertFormatted('a/=2;', 'a /= 2;\n')

    def test_division_after_a_value_is_not_scanned_for_a_pattern(self):
        result = self.assertQuotedTextIntact('s=""/2;msg(`at: https://a.co/74kJMmI`);')
        self.assertIn('at: https://a.co/74kJMmI', result)
        self.assertFormatted('a=b/c;d=e/(f+g);', 'a = b / c;\nd = e / (f + g);\n')
        self.assertFormatted('x=a/b/g,h=/re/g;', 'x = a / b / g,\nh = /re/g;\n')

    def test_template_containing_a_real_newline_is_not_mistaken_for_code(self):
        source = 'if(t.trim()===""&&t.includes(`' + "\n" + '`))return"";'
        result = self.assertEquivalent(source)
        self.assertIn('`\n`', result)

    def test_format_bytes_round_trips_invalid_utf8(self):
        formatter = unbuned.build_formatter()
        payload = b"var a=\xff\xfe;var b=2;"
        formatted = formatter(payload)
        self.assertEqual("".join(payload.decode("utf-8", "surrogateescape").split()),
                         "".join(formatted.decode("utf-8", "surrogateescape").split()))
        self.assertIn(b"\xff\xfe", formatted)

    def test_format_flag_writes_readable_output(self):
        section_data = b"// @bun\nfunction f(a){return a*2}\n" + bytes(range(1, 90))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))
            output_dir = tmp_path / "out"

            with redirect_stdout(io.StringIO()):
                result = unbuned.extract_bun_js(fixture_path, output_dir=output_dir, format_js=True)

            self.assertTrue(result)
            self.assertEqual(
                (output_dir / "sample.js").read_text(encoding="utf-8").splitlines()[1],
                "function f(a) {",
            )

    def test_format_flag_formats_modules_too(self):
        section_data = (
            b"// @bun\nvar a=1;\n\x00// @bun @bytecode\nfunction g(b){return b+1}\n"
        ) + bytes(range(1, 90))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))
            output_dir = tmp_path / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(
                    fixture_path, output_dir=output_dir, split_modules=True, format_js=True
                )

            bodies = [path.read_text(encoding="utf-8") for path in sorted((output_dir / "modules").glob("*.js"))]
            self.assertTrue(
                any("function g(b) {\n  return b + 1\n}" in body for body in bodies),
                bodies,
            )

    def test_unformatted_output_is_byte_identical(self):
        section_data = b"// @bun\nfunction f(a){return a*2}\n" + bytes(range(1, 90))

        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            fixture_path = tmp_path / "sample.exe"
            fixture_path.write_bytes(build_pe_fixture(section_data))
            output_dir = tmp_path / "out"

            with redirect_stdout(io.StringIO()):
                unbuned.extract_bun_js(fixture_path, output_dir=output_dir)

            raw = (output_dir / "sample.js").read_bytes()
            self.assertIn(b"function f(a){return a*2}", raw)


if __name__ == "__main__":
    unittest.main()
