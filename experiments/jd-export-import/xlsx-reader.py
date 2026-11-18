"""Bounded, text-only XLSX adapter. Reads stdin bytes; never extracts or fetches.

No inference of numeric IDs, styles, date serials or formula caches. This is an
offline format contract, not an assertion about the real JD export schema.
"""
import io
import json
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
DOCREL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
MAX_BYTES = 2 * 1024 * 1024
MAX_XML = 8 * 1024 * 1024


def block():
    raise ValueError('XLSX_REQUIRES_REVIEW')


def text_value(element):
    if element is None:
        block()
    result = ''
    for child in element:
        if child.tag == f'{{{MAIN}}}t' and not list(child):
            result += child.text or ''
        elif child.tag == f'{{{MAIN}}}r':
            if any(c.tag not in (f'{{{MAIN}}}t', f'{{{MAIN}}}rPr') for c in child):
                block()
            ts = child.findall(f'{{{MAIN}}}t')
            if len(ts) != 1 or list(ts[0]):
                block()
            result += ts[0].text or ''
        else:
            block()
    return result


def read_workbook(data, sheet_name):
    if not sheet_name or len(data) > MAX_BYTES:
        block()
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if len(infos) > 128 or len(set(names)) != len(names):
            block()
        if sum(i.file_size for i in infos) > MAX_XML:
            block()
        documents = {}
        for info in infos:
            name = info.filename
            if (name.startswith('/') or '\\' in name or ':' in name or
                    '..' in name.split('/') or info.flag_bits & 1 or
                    info.compress_type not in (0, 8) or info.file_size > MAX_XML or
                    info.file_size > max(1, info.compress_size) * 200 or
                    (info.external_attr >> 16) & 0o170000 == 0o120000):
                block()
            if name.endswith('/'):
                continue
            if not re.fullmatch(r'(\[Content_Types\]\.xml|_rels/\.rels|docProps/(core|app)\.xml|xl/(workbook\.xml|_rels/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|theme/theme[0-9]+\.xml|worksheets/sheet[0-9]+\.xml))', name):
                block()
            raw = z.read(info)  # CRC checked by ZipFile, bounded above.
            decoded = raw.decode('utf-8-sig', errors='strict')
            if '<!DOCTYPE' in decoded.upper() or '<!ENTITY' in decoded.upper():
                block()
            documents[name] = ET.fromstring(decoded)
        types = documents.get('[Content_Types].xml')
        if types is None:
            block()
        for element in types:
            typ = element.get('ContentType', '').lower()
            if any(x in typ for x in ('macro', 'vba', 'external', 'oleobject')):
                block()
        for name, doc in documents.items():
            if name.endswith('.rels'):
                for r in doc:
                    target = r.get('Target', '')
                    if r.get('TargetMode', 'Internal') != 'Internal' or ':' in target or target.startswith('/') or '..' in target.split('/'):
                        block()
        workbook = documents.get('xl/workbook.xml')
        rels = documents.get('xl/_rels/workbook.xml.rels')
        if workbook is None or rels is None or workbook.find(f'{{{MAIN}}}definedNames') is not None:
            block()
        sheets = workbook.findall(f'{{{MAIN}}}sheets/{{{MAIN}}}sheet')
        if not sheets or any(s.get('state', 'visible') != 'visible' for s in sheets):
            block()
        selected = [s for s in sheets if s.get('name') == sheet_name]
        if len(selected) != 1:
            block()
        matching = [r for r in rels if r.get('Id') == selected[0].get(f'{{{DOCREL}}}id') and r.get('Type') == DOCREL + '/worksheet']
        if len(matching) != 1:
            block()
        target = posixpath.normpath('xl/' + matching[0].get('Target', ''))
        strings = []
        shared = documents.get('xl/sharedStrings.xml')
        if shared is not None:
            for si in shared.findall(f'{{{MAIN}}}si'):
                strings.append(text_value(si))
                if len(strings[-1]) > 1024 or len(strings) > 640064:
                    block()
        grids = {}
        for name, doc in documents.items():
            if not name.startswith('xl/worksheets/'):
                continue
            if doc.tag != f'{{{MAIN}}}worksheet' or doc.find(f'{{{MAIN}}}mergeCells') is not None:
                block()
            if any(x.tag in (f'{{{MAIN}}}f', f'{{{MAIN}}}hyperlink', f'{{{MAIN}}}oleObject') for x in doc.iter()):
                block()
            if any(c.get('hidden', '0') not in ('0', 'false') for c in doc.findall(f'{{{MAIN}}}cols/{{{MAIN}}}col')):
                block()
            values = {}
            seen_rows = set()
            for row in doc.findall(f'{{{MAIN}}}sheetData/{{{MAIN}}}row'):
                if row.get('hidden', '0') not in ('0', 'false'):
                    block()
                if row.get('r') in seen_rows:
                    block()
                seen_rows.add(row.get('r'))
                for cell in row.findall(f'{{{MAIN}}}c'):
                    match = re.fullmatch(r'([A-Z]{1,2})([1-9][0-9]{0,4})', cell.get('r', ''))
                    if not match:
                        block()
                    col = 0
                    for letter in match[1]:
                        col = col * 26 + ord(letter) - 64
                    rn = int(match[2])
                    if col > 64 or rn > 10001 or row.get('r') != str(rn) or (rn, col) in values:
                        block()
                    typ = cell.get('t')
                    val = cell.find(f'{{{MAIN}}}v')
                    raw = '' if val is None else (val.text or '')
                    if typ == 's':
                        if not re.fullmatch(r'0|[1-9][0-9]*', raw) or int(raw) >= len(strings):
                            block()
                        text = strings[int(raw)]
                    elif typ == 'inlineStr':
                        text = text_value(cell.find(f'{{{MAIN}}}is'))
                    elif typ == 'str':
                        text = raw
                    elif not raw:
                        text = ''
                    else:
                        block()  # All nonempty cells must be explicit text.
                    if len(text) > 1024:
                        block()
                    values[(rn, col)] = text
            if not values:
                block()
            width = max(c for _, c in values)
            height = max(r for r, _ in values)
            grids[name] = [[values.get((r, c), '') for c in range(1, width + 1)] for r in range(1, height + 1)]
        if target not in grids:
            block()
        return grids[target]


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            block()
        result = read_workbook(sys.stdin.buffer.read(MAX_BYTES + 1), sys.argv[1])
        sys.stdout.write(json.dumps(result, ensure_ascii=True))
    except Exception:
        sys.stderr.write('XLSX_REQUIRES_REVIEW\n')
        sys.exit(1)
