"""Decode only the two expected r327 files. No disk extraction or network."""
import io
import json
import stat
import sys
import zipfile

MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
MAX_MEMBER_BYTES = 2 * 1024 * 1024
MEMBERS = {"state.json", "report.json"}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def read_archive(data):
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("archive size")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) != len(MEMBERS) or {item.filename for item in entries} != MEMBERS:
            raise ValueError("unexpected archive members")
        result = {}
        for item in entries:
            kind = stat.S_IFMT(item.external_attr >> 16)
            if (
                kind not in (0, stat.S_IFREG)
                or item.is_dir()
                or item.flag_bits & 1
                or item.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)
                or item.file_size > MAX_MEMBER_BYTES
            ):
                raise ValueError("invalid archive member")
            with archive.open(item) as member:
                body = member.read(MAX_MEMBER_BYTES + 1)
            if len(body) != item.file_size or len(body) > MAX_MEMBER_BYTES:
                raise ValueError("member size")
            result[item.filename] = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object)
        return result


if __name__ == "__main__":
    try:
        decoded = read_archive(sys.stdin.buffer.read(MAX_ARCHIVE_BYTES + 1))
        json.dump(decoded, sys.stdout, allow_nan=False, separators=(",", ":"))
    except (ValueError, RuntimeError, OSError, RecursionError, zipfile.BadZipFile):
        sys.stderr.write("R327_LEGACY_ZIP_INVALID\n")
        sys.exit(1)
