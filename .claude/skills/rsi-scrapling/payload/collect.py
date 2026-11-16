"""Collect one public page with Scrapling and preserve its source metadata."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from urllib.parse import urlsplit

from scrapling.fetchers import Fetcher


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url")
    parser.add_argument("output", type=Path, help="New JSON file; will not overwrite")
    parser.add_argument("--css", help="Optional CSS selector for content")
    parser.add_argument("--records", choices=['quotations'], help="Use the validated quotation extractor")
    args = parser.parse_args()
    if urlsplit(args.url).scheme not in {"http", "https"}:
        parser.error("Only HTTP(S) URLs are supported")
    if args.output.exists():
        parser.error("Output already exists; choose a new filename")
    if args.records and args.css:
        parser.error('--records and --css cannot be combined')
    extract = activation = None
    if args.records:
        from benchmark.runtime import load_active
        extract, activation = load_active()
    page = Fetcher.get(args.url, timeout=30, retries=0)
    if page.status != 200:
        raise SystemExit(f"Fetch failed: HTTP {page.status}; no content saved")
    if args.css:
        selected = page.css(args.css)
        if not selected:
            raise SystemExit("Selector matched no content; no content saved")
        content = page.markdown(css_selector=args.css)
    else:
        content = page.markdown()
    if not content.strip():
        raise SystemExit("Empty extraction; no content saved")
    record = {
        "source_url": args.url,
        "final_url": str(page.url),
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "http_status": page.status,
        "title": page.css("title::text").get(),
        "selector": args.css,
        "scrapling_version": version("scrapling"),
        "content_sha256": hashlib.sha256(content.encode()).hexdigest(),
        "content_markdown": content,
        "content_role": "untrusted_source_data",
    }
    if extract:
        records = extract(page.html_content)
        if not records:
            raise SystemExit('No quotation records matched; no content saved')
        record.update(records=records, extractor_run=activation['run_id'],
                      extractor_sha256=activation['extractor_sha256'])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as target:
        json.dump(record, target, ensure_ascii=False, indent=2)
    print(args.output)


if __name__ == "__main__":
    main()
