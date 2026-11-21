"""Verify one numeric candidate in an isolated anonymous V2 browser process."""

import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

import single_room_probe as legacy
from core.browser import BrowserFactory
from platforms.jd.discovery import HTTP_SAMPLE_FUNCTIONS, PUBLIC_LIVE_ID
from platforms.jd.live_monitor import JdLiveMonitor, map_jd_result
from platforms.jd.policy import API_HOST, PUBLIC_STATIC_DOMAINS, func_id

from .evidence import CHALLENGE_HOSTS, ENTRY_IDS, LOGIN_HOSTS, classify_candidate


ROOT = Path(__file__).resolve().parents[2]
ROOM_HOST = 'lives.jd.com'


class AnonymousRoomBrowser(BrowserFactory):
    def __init__(self):
        super().__init__()
        self.gate = None
        self.names = set()
        self.errors = []

    def _host_gate(self, host):
        if host in LOGIN_HOSTS:
            return 'LOGIN_REQUIRED'
        if host in CHALLENGE_HOSTS:
            return 'CAPTCHA_X5SEC'
        return None

    async def guard(self, route):
        request = route.request
        parts = urlsplit(request.url)
        host = parts.netloc.lower()
        self.gate = self.gate or self._host_gate(host)
        if request.resource_type == 'document' and host != ROOM_HOST:
            self.gate = self.gate or 'ACCESS_RESTRICTED'
        if self.gate or parts.scheme != 'https':
            await route.abort()
            return
        # The public room may load scripts/images, but only its admitted, read-only
        # room detail is allowed to send a POST. Anonymous browser state is fresh.
        static = any(host == d or host.endswith('.' + d) for d in PUBLIC_STATIC_DOMAINS if d != '3.cn')
        document = request.resource_type == 'document'
        allowed = (request.method == 'GET' and host == ROOM_HOST and (not document or parts.path in ('', '/'))) or (
            request.method == 'GET' and static and not document
        ) or (host == API_HOST and legacy.detail_request_rejection(request) is None)
        if allowed:
            await route.continue_()
        else:
            await route.abort()

    def record_response(self, response):
        parts = urlsplit(response.url)
        host = parts.netloc.lower()
        self.gate = self.gate or self._host_gate(host)
        if response.request.resource_type == 'document' and host != ROOM_HOST:
            self.gate = self.gate or 'ACCESS_RESTRICTED'
        if parts.scheme != 'https' or host not in {ROOM_HOST, API_HOST}:
            return
        name = func_id(response.request) if host == API_HOST and parts.path == '/api' else None
        if name and name.lower() in HTTP_SAMPLE_FUNCTIONS:
            self.names.add(name)
        else:
            name = None
        status = response.status
        if 400 <= status <= 599:
            self.errors.append({'function_id': name, 'http_status': status, 'host': host})
            if status in (401, 403, 429):
                self.gate = self.gate or ('LOGIN_REQUIRED' if status == 401 else 'ACCESS_RESTRICTED')

    async def new_context(self, profile):
        context = await super().new_context(profile, service_workers='block', accept_downloads=False)
        await context.route('**/*', self.guard)
        await context.route_web_socket('**/*', lambda route: route.close())
        context.on('response', self.record_response)
        return context


async def _observe(live_id):
    result = legacy.initial_result(live_id)
    async with AnonymousRoomBrowser() as browser:
        timing = await JdLiveMonitor(block_images=True)._collect(
            browser, f'https://{ROOM_HOST}/#/{live_id}', live_id, None, result, 12.0)
    code, _ = map_jd_result(result, timing['gate_kind'])
    gate = browser.gate or {'login': 'LOGIN_REQUIRED', 'restricted': 'ACCESS_RESTRICTED',
                            'access': 'ACCESS_RESTRICTED', 'challenge': 'CAPTCHA_X5SEC'}.get(timing['gate_kind'])
    if result['login_or_captcha_blocked'] and not gate:
        gate = 'ACCESS_RESTRICTED'
    report = classify_candidate(live_id, None)
    report.update(code=gate or code.value, gate=gate, observed_function_ids=sorted(browser.names),
                  http_error_samples=browser.errors, elapsed_ms=timing['elapsed_ms'])
    matched = not gate and result['room_id_matched'] is True and result['room_id'] == live_id
    report['room_id_matched'] = matched
    if matched and code.value in {'OK', 'OFFLINE'} and result['live_status'] in {'live', 'offline', 'replay'}:
        report.update(live_status=result['live_status'], detect_ms=timing['detect_ms'])
    return report


def verify_room(live_id):
    """One anonymous visit. Only stdout from the private worker's fixed schema can leave it."""
    empty = classify_candidate(live_id, None)
    if empty['live_id'] is None:
        return empty
    # Filtering before spawning isolates both Playwright's Node driver and Chromium.
    # No account environment, inherited debug switches or proxy credentials pass through.
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH',
                                            'V2_CHROMIUM_EXECUTABLE', 'LANG') if key in os.environ}
    env['PYTHONPATH'] = str(ROOT / 'src')
    command = [sys.executable, '-m', 'experiments.jd_cookie_live.public_room', live_id]
    try:
        child = subprocess.run(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=50, check=True)
        return json.loads(child.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        empty['code'] = 'OBSERVATION_ERROR'
        return empty


if __name__ == '__main__':
    room = sys.argv[1] if len(sys.argv) == 2 else ''
    if not PUBLIC_LIVE_ID.fullmatch(room) or room in ENTRY_IDS:
        raise SystemExit(1)
    print(json.dumps(asyncio.run(_observe(room))))
