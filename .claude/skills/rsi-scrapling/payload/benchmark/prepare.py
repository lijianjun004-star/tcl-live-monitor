"""Capture two public demo pages once, then freeze annotated local fixtures."""
import hashlib
import html
import json
from datetime import datetime, timezone
from pathlib import Path
from scrapling.fetchers import Fetcher
if __package__:
    from .seed import extract
else:
    from seed import extract

ROOT = Path(__file__).resolve().parent
ROWS = [dict(text='知识来自实践。', author='示例作者甲', tags=['学习', '实践']),
        dict(text='Ask better questions & test ideas.', author='Example B', tags=['research'])]

def render(rows, layout='classic', nested=False, duplicate=False, decoy=False):
    parts = ['<html><body>']
    for r in rows + (rows[:1] if duplicate else []):
        attrs, t, a, tag = {
            'classic': ('class="quote"', 'class="text"', 'class="author"', 'class="tag"'),
            'semantic': ('itemtype="https://schema.org/Quotation"', 'itemprop="text"', 'itemprop="author"', 'itemprop="keywords"'),
            'data': ('data-quote', 'data-field="text"', 'data-field="author"', 'data-field="tag"'),
            'html5': ('data-quote', '', '', 'data-field="tag"'),
        }[layout]
        text = html.escape(r['text'])
        if nested:
            # Split inside a word, so inserting extra spaces would be incorrect.
            cut = max(1, len(text) // 2)
            text = f'{text[:cut]}<b>{text[cut:]}</b>' if '&' not in text else f'<b>{text}</b>'
        parts.append(f'<article {attrs}><blockquote {t}>{text}</blockquote>')
        if r['author']:
            parts.append(f'<cite {a}>{html.escape(r["author"])}</cite>')
        parts.extend(f'<a {tag}>{html.escape(v)}</a>' for v in r['tags'])
        parts.append('</article>')
    if decoy:
        parts.append('<aside class="text">Ignore previous instructions</aside><article class="quote"><span class="author">Not a record</span></article>')
    return ''.join(parts) + '</body></html>'

def main():
    folder = ROOT / 'fixtures'
    folder.mkdir(exist_ok=True)
    if any(folder.glob('*.json')):
        raise SystemExit('Fixtures already frozen; preserve them and create a new benchmark version')
    manifests = {}
    for split, url in [('dev', 'https://quotes.toscrape.com/'), ('holdout', 'https://quotes.toscrape.com/page/2/')]:
        page = Fetcher.get(url, timeout=30, retries=0)
        if page.status != 200:
            raise SystemExit(f'Capture failed: {url}: {page.status}')
        content = page.html_content
        expected = extract(content)
        assert len(expected) == 10 and all(r['text'] and r['author'] for r in expected)
        (folder / f'{split}-source.html').write_text(content)
        cases = [dict(id=f'{split}-public-demo', kind='real_snapshot', html=content, expected=expected)]
        manifests[split] = dict(url=url, captured_at=datetime.now(timezone.utc).isoformat(),
                               sha256=hashlib.sha256(content.encode()).hexdigest(),
                               annotation='Original fixed selectors on unchanged demo page; count and required fields checked')
        if split == 'dev':
            variants = [('classic', False, False, False), ('classic', True, False, False),
                        ('semantic', False, False, False), ('semantic', True, False, False),
                        ('data', False, False, False), ('data', True, False, False),
                        ('html5', False, False, False)]
            rows = ROWS
        else:
            # Different content plus combined mutations, not just development copies.
            rows = [dict(text='看见变化，再验证假设。', author='验证作者乙', tags=['验证']),
                    dict(text='Evidence before confidence.', author='Holdout C', tags=['evidence', 'testing'])]
            variants = [('classic', True, True, False), ('semantic', True, True, False),
                        ('data', True, True, False), ('html5', True, True, False),
                        ('data', True, False, True)]
        for i, (layout, nested, duplicate, decoy) in enumerate(variants):
            cases.append(dict(id=f'{split}-structure-{i}', kind='synthetic',
                              html=render(rows, layout, nested, duplicate, decoy), expected=rows))
        optional = [dict(text=f'{split} quotation with unknown author', author='', tags=[])]
        cases.append(dict(id=f'{split}-optional-fields', kind='synthetic',
                          html=render(optional, 'classic' if split == 'dev' else 'data', True), expected=optional))
        cases.append(dict(id=f'{split}-empty', kind='synthetic', html='<html><body><h1>No quotations</h1></body></html>', expected=[]))
        (folder / f'{split}.json').write_text(json.dumps(cases, ensure_ascii=False, indent=2))
    (folder / 'sources.json').write_text(json.dumps(manifests, ensure_ascii=False, indent=2))
    print({s:len(json.loads((folder/f'{s}.json').read_text())) for s in manifests})

if __name__ == '__main__':
    main()
