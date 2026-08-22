const HEADER_SCAN_LIMIT = 65_536;
const PLY_MAGIC = [0x70, 0x6c, 0x79];
const OBJ_INFO = [0x6f, 0x62, 0x6a, 0x5f, 0x69, 0x6e, 0x66, 0x6f];
const COMMENT_WITH_SPACE = [0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74, 0x20];
const END_HEADER = [0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72];

function matches(bytes: Uint8Array, offset: number, expected: number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

export function normalizePlyHeaderInPlace(bytes: Uint8Array, fileName: string): number {
  if (!fileName.toLowerCase().endsWith('.ply') || !matches(bytes, 0, PLY_MAGIC)) return 0;

  const limit = Math.min(bytes.length, HEADER_SCAN_LIMIT);
  let lineStart = 0;
  let normalizedLines = 0;

  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] !== 0x0a) continue;

    if (matches(bytes, lineStart, OBJ_INFO)) {
      const delimiter = bytes[lineStart + OBJ_INFO.length];
      if (delimiter === 0x20 || delimiter === 0x09) {
        // Spark rejects the standard obj_info record. "comment " is the same byte length.
        bytes.set(COMMENT_WITH_SPACE, lineStart);
        normalizedLines += 1;
      }
    }

    if (matches(bytes, lineStart, END_HEADER)) return normalizedLines;
    lineStart = index + 1;
  }

  return normalizedLines;
}
