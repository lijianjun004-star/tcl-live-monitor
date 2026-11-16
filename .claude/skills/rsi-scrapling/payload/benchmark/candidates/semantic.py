"""Prefer semantic item properties, with reference selector fallbacks."""
from scrapling.parser import Selector

def value(node, selector):
    hits = node.css(selector)
    return ''.join(hits[0].xpath('.//text()').getall()).strip() if hits else ''

def extract(html):
    page = Selector(html)
    return [dict(text=value(q, '[itemprop="text"], .text'),
                 author=value(q, '[itemprop="author"], .author'),
                 tags=[''.join(t.xpath('.//text()').getall()).strip()
                       for t in q.css('[itemprop="keywords"], .tag')])
            for q in page.css('.quote, [itemtype="https://schema.org/Quotation"]')]
