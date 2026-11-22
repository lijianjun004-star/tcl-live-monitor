"""Compare sanitized observations of the registered JD shop. No network I/O."""
import argparse
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

SHOP_ID = '721631'
SHOP_NAME = 'TCL官方旗舰店'
SHOP_URLS = {f'https://mall.jd.com/index-{SHOP_ID}.html', f'https://shop.m.jd.com/?shopId={SHOP_ID}'}
ROOM_LINK = re.compile(r'https://lives\.jd\.com/#/([1-9][0-9]{4,17})')
OWN_LIVE_HEADINGS = {'店铺直播', '本店直播'}
PUBLISHER_HEADINGS = {'直播店铺', '主播店铺'}
MAX_WINDOW = timedelta(minutes=5)
MAX_BYTES = 128 * 1024


def instant(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)', value, re.ASCII):
        return None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        return None


def room_id(link):
    match = ROOM_LINK.fullmatch(link) if isinstance(link, str) else None
    return match.group(1) if match else None


def scoped_links(page, headings):
    # Accept only the entire nearest-to-outer semantic heading path. A nested
    # recommendation section (even under a store heading) cannot qualify.
    links = page.get('visible_links')
    if not isinstance(links, list) or len(links) > 128 or not all(isinstance(link, dict) for link in links):
        return None
    candidates = set()
    for link in links:
        trail = link.get('heading_path')
        if not isinstance(trail, list) or not all(isinstance(x, str) for x in trail):
            return None
        if len(trail) == 1 and trail[0] in headings:
            href = link.get('href')
            if not isinstance(href, str):
                return None
            candidates.add(href)
    return candidates


def accepted_sample(sample):
    if not isinstance(sample, dict):
        return False
    pair = (sample.get('method'), sample.get('function_id_source'))
    return (pair in (('GET', 'query'), ('POST', 'post_form'), ('POST', 'both'), ('POST', 'query'))
            and sample.get('safe_path') == '/api' and sample.get('eligible_probe') is True
            and sample.get('mime_category') in ('json', 'javascript')
            and sample.get('rejected_reason') == 'accepted')


def strict_result_from_artifact(blob, expected_sha256):
    if not isinstance(blob, bytes) or len(blob) > MAX_BYTES or not isinstance(expected_sha256, str):
        return None
    if hashlib.sha256(blob).hexdigest() != expected_sha256:
        return None
    try:
        return json.loads(blob.decode('utf-8'), object_pairs_hook=unique_keys)
    except (ValueError, RecursionError):
        return None


def decide(observation, now, *, strict_artifact=None, expected_sha256=None):
    """Interpret one offline bundle; 'corroborated' means agreement in this input."""
    result = {'shop_id': SHOP_ID, 'input_kind': None, 'candidate_session_id': None,
              'corroborated_session_id': None, 'observed_status': 'UNKNOWN',
              'observed_at': None, 'current_state': 'UNKNOWN'}

    def finish(reason):
        return {**result, 'reason': reason}

    if not isinstance(observation, dict) or observation.get('input_kind') not in ('synthetic', 'offline_observation'):
        return finish('INVALID_INPUT')
    result['input_kind'] = observation['input_kind']
    store, room, detail = (observation.get(key) for key in ('store_page', 'room_page', 'strict_room_result'))
    if isinstance(store, dict) and (store.get('gate') == 'app_download' or store.get('final_url') == 'https://wqs.jd.com/downloadApp/download.html'):
        return finish('SHOP_APP_DOWNLOAD_LANDING')
    if not isinstance(store, dict) or store.get('http_status') != 200 or store.get('gate') != 'clear':
        return finish('SHOP_PAGE_UNAVAILABLE')
    if store.get('final_url') not in tuple(SHOP_URLS) or store.get('title') not in (SHOP_NAME, SHOP_NAME+' - 京东'):
        return finish('SHOP_IDENTITY_MISMATCH')
    links = scoped_links(store, OWN_LIVE_HEADINGS)
    if not links or len(links) != 1:
        return finish('SHOP_ENTRY_MISSING_OR_AMBIGUOUS')
    candidate = room_id(next(iter(links)))
    if candidate is None:
        return finish('SHOP_ENTRY_INVALID')
    result['candidate_session_id'] = candidate
    if not isinstance(room, dict) or room.get('http_status') != 200 or room.get('gate') != 'clear' or room_id(room.get('final_url')) != candidate:
        return finish('ROOM_PAGE_UNVERIFIED')
    publisher_links = scoped_links(room, PUBLISHER_HEADINGS)
    if not publisher_links or not publisher_links.issubset(SHOP_URLS):
        return finish('PUBLISHER_SHOP_UNVERIFIED')
    if result['input_kind'] == 'offline_observation':
        detail = strict_result_from_artifact(strict_artifact, expected_sha256)
        if detail is None:
            return finish('INDEPENDENT_ROOM_RESULT_REQUIRED')
    if not isinstance(detail, dict) or detail.get('room_id') != candidate or detail.get('final_host') != 'lives.jd.com':
        return finish('ROOM_RESULT_MISMATCH')
    diagnostics = detail.get('diagnostics')
    if not isinstance(diagnostics, dict):
        return finish('STRICT_DETAIL_UNVERIFIED')
    matched = diagnostics.get('target_matched_count')
    samples = diagnostics.get('target_request_samples')
    functions = diagnostics.get('observed_function_ids')
    endpoints = detail.get('evidence_endpoints')
    seen = diagnostics.get('target_request_seen')
    keys = diagnostics.get('detail_data_keys')
    if (not isinstance(functions, list) or 'getImmediatePlayToM' not in functions
            or not isinstance(endpoints, list) or 'https://api.m.jd.com/api' not in endpoints
            or detail.get('reasons') != [] or diagnostics.get('truncated') is not False
            or not isinstance(keys, list) or 'liveId' not in keys or 'status' not in keys
            or type(seen) is not int or type(matched) is not int or not 1 <= matched <= seen
            or detail.get('page_loaded') is not True or detail.get('page_gate_reason') != 'ok'
            or detail.get('fragment_matched') is not True or detail.get('room_id_matched') is not True
            or detail.get('login_or_captcha_blocked') is not False
            or not isinstance(samples, list) or not any(accepted_sample(s) for s in samples)):
        return finish('STRICT_DETAIL_UNVERIFIED')
    times = [instant(store.get('observed_at')), instant(room.get('observed_at')), instant(detail.get('generated_at'))]
    if any(t is None for t in times) or max(times) > now or max(times)-min(times) > MAX_WINDOW:
        return finish('OBSERVATION_WINDOW_INVALID')
    status = detail.get('live_status')
    if status not in ('live', 'offline', 'replay'):
        return finish('STATUS_UNVERIFIED')
    result.update(corroborated_session_id=candidate, observed_status=status.upper(), observed_at=detail['generated_at'])
    return finish('EVIDENCE_AGREES_IN_INPUT')


def unique_keys(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError('duplicate key')
        obj[key] = value
    return obj


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('observation', type=Path)
    parser.add_argument('--strict-result', type=Path, help='Unmodified local result.json from the independent room observation')
    parser.add_argument('--strict-result-sha256', help='Expected artifact digest from the run handoff')
    args = parser.parse_args()
    try:
        with args.observation.open('rb') as stream:
            blob = stream.read(MAX_BYTES + 1)
        if len(blob) > MAX_BYTES:
            raise ValueError('oversize')
        observation = json.loads(blob.decode('utf-8'), object_pairs_hook=unique_keys)
        artifact = None
        if args.strict_result:
            with args.strict_result.open('rb') as stream:
                artifact = stream.read(MAX_BYTES + 1)
        print(json.dumps(decide(observation, datetime.now(timezone.utc), strict_artifact=artifact,
                                expected_sha256=args.strict_result_sha256)))
    except (ValueError, OSError, RecursionError):
        print(json.dumps({'reason': 'INVALID_INPUT', 'current_state': 'UNKNOWN'}))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
