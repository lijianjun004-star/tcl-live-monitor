"""Reference extractor: fixed selectors, direct text nodes."""
from scrapling.parser import Selector

def extract(html):
    page = Selector(html)
    return [
        {"text": q.css('.text::text').get(''),
         "author": q.css('.author::text').get(''),
         "tags": q.css('.tag::text').getall()}
        for q in page.css('.quote')
    ]
