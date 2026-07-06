import io
import os
import struct
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import unbuned


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

    def test_reports_unsupported_fat_macho(self):
        result, output, _ = self.run_extraction(build_fat_fixture(), "fat-binary")

        self.assertFalse(result)
        self.assertIn("FAT/universal Mach-O binaries are not supported yet", output)

    def test_reports_missing_bundle_for_short_input(self):
        result, output, _ = self.run_extraction(b"MZ", "too-short.exe")

        self.assertFalse(result)
        self.assertIn("Unsupported executable format", output)


if __name__ == "__main__":
    unittest.main()
