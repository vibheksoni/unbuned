#!/usr/bin/env python3

import struct
import sys
from pathlib import Path

BUN_MAGIC = b'\xe5\x02\x80\x01'
FAT_MAGIC = 0xCAFEBABE
FAT_MAGIC_64 = 0xCAFEBABF
LC_SEGMENT = 0x1
LC_SEGMENT_64 = 0x19
MH_MAGIC = 0xFEEDFACE
MH_MAGIC_64 = 0xFEEDFACF


def find_bun_section(data, pe_offset):
    """
    Locate .bun section in PE executable.
    
    Args:
        data (bytes): Raw executable data
        pe_offset (int): PE header offset location
    
    Returns:
        tuple: (start_offset, size) or (None, None) if not found
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
        
        if section_name == '.bun':
            virtual_size = struct.unpack('<I', data[section_offset+8:section_offset+12])[0]
            raw_size = struct.unpack('<I', data[section_offset+16:section_offset+20])[0]
            raw_offset = struct.unpack('<I', data[section_offset+20:section_offset+24])[0]
            section_size = min(virtual_size, raw_size)
            section_end = raw_offset + section_size
            if section_size == 0 or section_end > len(data):
                return None, None

            return raw_offset, section_size
    
    return None, None


def find_macho_bun_section(data):
    """
    Locate __BUN,__bun section in a thin Mach-O executable.

    Args:
        data (bytes): Raw executable data

    Returns:
        tuple: (start_offset, size, error_message)
    """
    if len(data) < 4:
        return None, None, "Error: Unsupported executable format"

    fat_magic = struct.unpack('>I', data[:4])[0]
    if fat_magic in (FAT_MAGIC, FAT_MAGIC_64):
        return None, None, "Error: FAT/universal Mach-O binaries are not supported yet"

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

            if sectname == '__bun' and segname == '__BUN':
                section_end = file_offset + size
                if size == 0 or section_end > len(data):
                    return None, None, "Error: Invalid __BUN,__bun section"

                return file_offset, size, None

        command_offset += cmdsize

    return None, None, "Error: Could not find __BUN,__bun section in Mach-O executable"


def find_js_boundary(bundle, chunk_size=1000, threshold=0.3):
    """
    Detect where JavaScript ends and binary data begins.
    
    Args:
        bundle (bytes): JavaScript bundle data
        chunk_size (int): Size of chunks to analyze
        threshold (float): Non-printable ratio threshold
    
    Returns:
        int: Offset where binary data starts
    """
    for i in range(0, min(len(bundle), 50_000_000), chunk_size):
        chunk = bundle[i:i+chunk_size]
        if not chunk:
            break
        
        non_printable = sum(1 for b in chunk if b > 127 or (b < 32 and b not in [9, 10, 13]))
        ratio = non_printable / len(chunk)
        
        if ratio > threshold:
            return i
    
    return len(bundle)


def is_binary_byte(byte):
    return byte > 127 or (byte < 32 and byte not in [9, 10, 13])


def find_first_binary_byte(bundle):
    """
    Find the first byte that does not look like plain-text JavaScript.

    Args:
        bundle (bytes): JavaScript bundle data

    Returns:
        int|None: Offset of the first binary-looking byte, or None if not found
    """
    for index, byte in enumerate(bundle):
        if is_binary_byte(byte):
            return index

    return None


def refine_boundary(bundle, initial_end):
    """
    Refine JavaScript boundary by detecting end markers.
    
    Args:
        bundle (bytes): JavaScript bundle data
        initial_end (int): Initial boundary offset
    
    Returns:
        int: Refined boundary offset
    """
    next_data = bundle[initial_end:initial_end+2000]
    ascii_count = sum(1 for b in next_data[:500] if 32 <= b < 127)
    
    if ascii_count <= 50:
        return initial_end
    
    markers = [b'//# debugId=', b'//# sourceMappingURL=', b'})();']
    
    for marker in markers:
        marker_pos = next_data.find(marker)
        if marker_pos >= 0:
            line_end = next_data.find(b'\n', marker_pos)
            if line_end >= 0:
                check_after = next_data[line_end+1:line_end+101]
                if len(check_after) > 0:
                    binary_ratio = sum(1 for b in check_after if is_binary_byte(b)) / len(check_after)
                    if binary_ratio > 0.4:
                        return initial_end + line_end + 1
    
    for i in range(min(1000, len(next_data))):
        byte = next_data[i]
        if byte in [ord(';'), ord('}'), ord(')')]:
            end = i + 1
            while end < len(next_data) and next_data[end] in b'; \t\r\n':
                end += 1

            check_ahead = next_data[end:end+101]
            if len(check_ahead) > 0:
                binary_ratio = sum(1 for b in check_ahead if is_binary_byte(b)) / len(check_ahead)
                if binary_ratio > 0.5:
                    return initial_end + end

    return initial_end


def extract_js_data(bundle, stop_at_nul=False):
    """
    Extract clean JavaScript from a bundle payload.

    Args:
        bundle (bytes): Candidate bundle data
        stop_at_nul (bool): Whether to stop at the first NUL terminator

    Returns:
        tuple: (js_data, error_message)
    """
    js_marker_pos = bundle.find(b'// @bun')

    if js_marker_pos == -1:
        return None, "Error: Could not find JavaScript marker"

    bundle = bundle[js_marker_pos:]

    if stop_at_nul:
        nul_pos = bundle.find(b'\x00')
        if nul_pos != -1:
            return bundle[:nul_pos], None

    initial_end = find_js_boundary(bundle)
    final_end = refine_boundary(bundle, initial_end)

    if final_end == 0:
        first_binary = find_first_binary_byte(bundle)
        if first_binary not in (None, 0):
            return bundle[:first_binary], None

    return bundle[:final_end], None


def extract_bun_js(exe_path):
    """
    Extract JavaScript from Bun compiled executable.
    
    Args:
        exe_path (str|Path): Path to Bun executable
    
    Returns:
        bool: True if extraction succeeded, False otherwise
    """
    exe_path = Path(exe_path)
    if not exe_path.exists():
        print(f"Error: File not found: {exe_path}")
        return False
    
    data = exe_path.read_bytes()

    bundle = None
    error_message = None
    stop_at_nul = False

    if len(data) >= 0x40 and data[0:2] == b'MZ':
        pe_offset = struct.unpack('<I', data[0x3c:0x40])[0]
        if pe_offset + 4 <= len(data) and data[pe_offset:pe_offset+4] == b'PE\x00\x00':
            js_start, js_size = find_bun_section(data, pe_offset)
            if js_start is not None:
                bundle = data[js_start:js_start+js_size]

    if bundle is None:
        js_start, js_size, error_message = find_macho_bun_section(data)
        if js_start is not None:
            bundle = data[js_start:js_start+js_size]
            stop_at_nul = True
        elif error_message is not None:
            print(error_message)
            return False

    if bundle is None:
        pos = data.find(BUN_MAGIC)
        if pos != -1:
            bundle = data[pos:]

    if bundle is None:
        print("Error: Could not locate JavaScript bundle")
        return False

    js_data, error_message = extract_js_data(bundle, stop_at_nul=stop_at_nul)

    if error_message is not None:
        print(error_message)
        return False

    try:
        js_code = js_data.decode('utf-8', errors='replace')
    except Exception as e:
        print(f"Error: Decoding failed: {e}")
        return False
    
    exe_name = exe_path.stem
    output_dir = Path("output") / exe_name
    output_dir.mkdir(parents=True, exist_ok=True)
    output_file = output_dir / f"{exe_name}.js"
    
    with open(output_file, 'w', encoding='utf-8') as f:
        f.write(js_code)
    
    print(f"Extracted: {output_file}")
    print(f"Size: {len(js_code):,} bytes")
    
    return True


def main():
    """
    Main entry point for Bun JavaScript extractor.
    """
    if len(sys.argv) < 2:
        print("Usage: python unbuned.py <path-to-bun-executable>")
        sys.exit(1)
    
    if not extract_bun_js(sys.argv[1]):
        sys.exit(1)


if __name__ == "__main__":
    main()
