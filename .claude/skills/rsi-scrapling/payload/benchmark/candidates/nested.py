"""Preserve nested text while keeping the reference layout contract."""
from scrapling.parser import Selector

def text(node, selector):
    matches = node.css(selector)
    return ''.join(matches[0].xpath('.//text()').getall()).strip() if matches else ''

def extract(html):
    page = Selector(html)
    return [dict(text=text(q, '.text'), author=text(q, '.author'),
                 tags=[''.join(t.xpath('.//text()').getall()).strip()
                       for t in q.css('.tag')]) for q in page.css('.quote')]
