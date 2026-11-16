"""Explicit semantic fallbacks, descendant text, optional fields and deduping."""
import re
from scrapling.parser import Selector

def clean(value):
    return re.sub(r'\s+', ' ', value).strip()

def value(node, selectors):
    for selector in selectors:
        hits = node.css(selector)
        if hits:
            return clean(''.join(hits[0].xpath('.//text()[not(ancestor::script) and not(ancestor::style)]').getall()))
    return ''

def extract(html):
    page = Selector(html)
    result, seen = [], set()
    for q in page.css('.quote, [data-quote], [itemtype="https://schema.org/Quotation"]'):
        text = value(q, ['[data-field="text"]', '[itemprop="text"]', '.text', 'blockquote'])
        if not text:
            continue
        author = value(q, ['[data-field="author"]', '[itemprop="author"]', '.author', 'cite'])
        tags = []
        for t in q.css('[data-field="tag"], [itemprop="keywords"], .tag'):
            tag = clean(''.join(t.xpath('.//text()').getall()))
            if tag and tag not in tags:
                tags.append(tag)
        key = (text, author, tuple(sorted(tags)))
        if key not in seen:
            seen.add(key)
            result.append(dict(text=text, author=author, tags=tags))
    return result
