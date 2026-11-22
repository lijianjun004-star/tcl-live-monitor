"""Scheduled recovery from synthetic Actions metadata and locally produced state artifacts."""

import hashlib
import io
import json
from functools import partial
from datetime import datetime, timezone
from urllib.parse import parse_qs, urlsplit
import zipfile

import pytest

from scripts import restore_v2_state
from scripts.restore_v2_state import install_state, select_state
from test_runner_e2e import read, run
import v2_run


REPO = 'owner/monitor'
WORKFLOW = '.github/workflows/v2-monitor.yml'


@pytest.fixture(autouse=True)
def fixed_time(monkeypatch):
    monkeypatch.setattr(restore_v2_state, 'utcnow', lambda: datetime(2026, 11, 22, tzinfo=timezone.utc))


def timestamp(minute):
    return f'2026-11-20T08:{minute:02d}:00Z'


def workflow_run(run_id, minute, **changes):
    return dict({'id': run_id, 'run_attempt': 1, 'path': WORKFLOW, 'head_branch': 'main',
                 'head_repository': {'full_name': REPO}, 'event': 'schedule', 'status': 'completed',
                 'conclusion': 'success', 'created_at': timestamp(0), 'updated_at': timestamp(minute)}, **changes)


def live_job(attempt=1, conclusion='success'):
    return {'name': 'live', 'status': 'completed', 'conclusion': conclusion, 'run_attempt': attempt,
            'started_at': timestamp(5), 'completed_at': timestamp(20),
            'steps': [{'name': 'Upload state for the next run', 'status': 'completed', 'conclusion': conclusion,
                       'started_at': timestamp(18), 'completed_at': timestamp(20)}]}


def archive(entries):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for name, content in entries.items():
            bundle.writestr(name, content)
    data = buffer.getvalue()
    metadata = {'id': 355, 'name': 'v2-state', 'expired': False, 'created_at': timestamp(19),
                'size_in_bytes': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
    return data, metadata


def listing(runs, jobs, artifacts):
    def pages(endpoint, key):
        route = urlsplit(endpoint)
        prefix = f'repos/{REPO}/actions/'
        assert route.path.startswith(prefix)
        path = route.path[len(prefix):]
        if key == 'workflow_runs':
            assert path == 'workflows/v2-monitor.yml/runs'
            assert not parse_qs(route.query).get('event')
            return iter(runs)
        resource, run_id, rest = path.split('/', 2)
        assert resource == 'runs'
        if key == 'jobs':
            assert rest == f'attempts/{jobs[int(run_id)][0]["run_attempt"]}/jobs'
            return iter(jobs[int(run_id)])
        assert key == 'artifacts' and rest == 'artifacts' and parse_qs(route.query)['name'] == ['v2-state']
        return iter(artifacts[int(run_id)])
    return pages


def test_github_pages_reads_past_a_full_page(monkeypatch):
    calls = []

    def gh(command):
        assert command[:2] == ['gh', 'api']
        query = parse_qs(urlsplit(command[2]).query)
        assert query['per_page'] == ['100'] and query['name'] == ['v2-state']
        page = int(query['page'][0])
        calls.append(page)
        rows = list(range(100)) if page == 1 else [100]
        return json.dumps({'artifacts': rows}).encode()

    monkeypatch.setattr(restore_v2_state.subprocess, 'check_output', gh)
    assert list(restore_v2_state.github_pages('repos/owner/monitor/actions/runs/50/artifacts?name=v2-state',
                                              'artifacts')) == list(range(101))
    assert calls == [1, 2]


def test_latest_successful_live_attempt_ignores_unrelated_or_fake_runs():
    _, state = archive({})
    runs = [workflow_run(106, 40), workflow_run(105, 39, head_branch='test'),
            workflow_run(104, 38, event='pull_request'), workflow_run(103, 37, path='other.yml'),
            workflow_run(102, 36, head_repository={'full_name': 'another/fork'}),
            workflow_run(101, 35, conclusion='failure'), workflow_run(100, 34, status='in_progress'),
            workflow_run(99, 33, event='workflow_dispatch'), workflow_run(98, 21),
            workflow_run(96, 32, run_attempt=2, event='workflow_dispatch')]
    # Lower-numbered run 96 was rerun after 98. Run 99 was a successful manual fake run.
    pages = listing(runs, {99: [live_job(conclusion='skipped')], 96: [live_job(2)]}, {96: [state]})
    assert select_state(REPO, 106, pages) == (96, 2, state)


@pytest.mark.parametrize(('other_completed', 'expected'), [(19, (60, 1)), (27, (59, 1))])
def test_rerun_can_restore_its_prior_success_or_a_newer_main_success(other_completed, expected):
    _, state = archive({})
    runs = [workflow_run(60, 28, run_attempt=2, status='in_progress', conclusion=None),
            workflow_run(59, other_completed)]

    def previous_attempt(endpoint):
        assert endpoint == f'repos/{REPO}/actions/runs/60/attempts/1'
        return workflow_run(60, 22)

    selected_id, _ = expected
    pages = listing(runs, {selected_id: [live_job()]}, {selected_id: [state]})
    assert select_state(REPO, 60, pages, current_attempt=2, get=previous_attempt) == (*expected, state)


@pytest.mark.parametrize('problem', ['missing', 'expired', 'other_attempt', 'duplicate'])
def test_latest_live_without_an_unambiguous_usable_artifact_stops(problem):
    _, state = archive({})
    artifacts = {'missing': [], 'expired': [dict(state, expired=True)],
                 'other_attempt': [dict(state, created_at=timestamp(1))],
                 'duplicate': [state, dict(state, id=356)]}[problem]
    runs = [workflow_run(21, 31, run_attempt=2), workflow_run(20, 30)]
    # Asking for run 20 here would silently roll the notification baseline backwards.
    pages = listing(runs, {21: [live_job(2)]}, {21: artifacts})
    with pytest.raises(ValueError):
        select_state(REPO, 25, pages)


def test_no_prior_live_run_stops_before_collection():
    pages = listing([workflow_run(50, 28)], {50: [live_job(conclusion='skipped')]}, {})
    with pytest.raises(ValueError):
        select_state(REPO, 51, pages)


def pending_files():
    return {'resolved_cache.json': '{"schema_version":"2.0","entries":{}}', 'notify_ledger.json': '{"sent":{}}'}


@pytest.mark.parametrize('problem', ['digest', 'traversal', 'invalid_snapshot', 'missing_ledger', 'lost_snapshot'])
def test_invalid_state_is_not_installed(tmp_path, problem):
    files = pending_files()
    if problem == 'traversal':
        files['../outside'] = 'unsafe'
    elif problem == 'invalid_snapshot':
        files['monitor_snapshot.json'] = '{}'
    elif problem == 'missing_ledger':
        del files['notify_ledger.json']
    elif problem == 'lost_snapshot':
        files['notify_ledger.json'] = json.dumps({'sent': {'a' * 32: timestamp(2)}})
    data, metadata = archive(files)
    if problem == 'digest':
        metadata['digest'] = 'sha256:' + '0' * 64
    with pytest.raises(ValueError):
        install_state(data, metadata, tmp_path / 'state')
    assert not (tmp_path / 'state').exists() and not (tmp_path / 'outside').exists()


def test_bad_member_crc_is_rejected_even_when_archive_digest_matches(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_STORED) as bundle:
        for name, content in pending_files().items():
            bundle.writestr(name, content)
    # Change stored file contents without updating its member CRC.
    data = buffer.getvalue().replace(b'"sent"', b'"went"', 1)
    metadata = {'size_in_bytes': len(data), 'digest': 'sha256:' + hashlib.sha256(data).hexdigest()}
    with pytest.raises(zipfile.BadZipFile):
        install_state(data, metadata, tmp_path / 'state')
    assert not (tmp_path / 'state').exists()


def test_valid_pending_first_run_is_restored(tmp_path):
    data, metadata = archive(pending_files())
    destination = tmp_path / 'state'
    install_state(data, metadata, destination)
    assert {p.name for p in destination.iterdir()} == set(pending_files())
    assert json.loads((destination / 'notify_ledger.json').read_bytes()) == {'sent': {}}


def test_scheduled_state_transfer_preserves_bark_retries_across_fresh_runners(tmp_path, monkeypatch):
    deliveries = []

    responses = iter([200, 503, 200])
    bark = {'WEBHOOK_KIND': 'bark', 'WEBHOOK_URL': 'https://example.invalid/device'}

    def transport(_url, data, _headers):
        status = next(responses)
        if status == 200:
            deliveries.append(json.loads(data)['body'])
        return status, json.dumps({'code': status}).encode()

    def resume(source, dest):
        files = {p.name: p.read_bytes() for p in (source / 'state').iterdir()}
        data, metadata = archive(files)
        dest.mkdir()
        install_state(data, metadata, dest / 'state')

    monkeypatch.setattr(v2_run.notifiers, 'send', partial(v2_run.notifiers.send, transport=transport))
    first, failed, retry, unchanged = (tmp_path / name for name in ('first', 'failed', 'retry', 'unchanged'))
    assert run(first, env=bark) == 0
    resume(first, failed)
    changed = {'jd-canary': {'monitor': {'code': 'OFFLINE'}}}
    assert run(failed, scenario=changed, env=bark) == 0
    failed_report = read(failed, 'run_summary.json')
    assert failed_report['notification']['status'] == 'rejected' and failed_report['state_snapshot_advanced'] is False
    resume(failed, retry)
    assert run(retry, scenario=changed, env=bark) == 0
    report = read(retry, 'run_summary.json')['notification']
    assert report['status'] == 'sent' and report['event_types'] == ['CANARY_FAILED']
    resume(retry, unchanged)
    assert run(unchanged, scenario=changed, env=bark) == 0
    assert read(unchanged, 'run_summary.json')['notification']['status'] == 'no_changes'
    assert len(deliveries) == 2 and '【对照失败】' in deliveries[-1]
