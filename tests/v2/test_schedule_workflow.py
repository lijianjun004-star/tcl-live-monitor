"""Read the Actions workflow as data so comments cannot accidentally satisfy the contract."""

import yaml

from conftest import ROOT


WORKFLOWS = ROOT / '.github' / 'workflows'


def load_workflow(path):
    # Actions treats `on` as a string. BaseLoader also keeps manual input defaults explicit.
    return yaml.load(path.read_text(encoding='utf-8'), Loader=yaml.BaseLoader)


def test_only_requested_utc_schedule_and_manual_entry_are_enabled():
    workflow = load_workflow(WORKFLOWS / 'v2-monitor.yml')
    events = workflow['on']
    assert set(events) == {'schedule', 'workflow_dispatch'}
    assert sorted(entry['cron'] for entry in events['schedule']) == ['0 16 * * *', '0,30 0-15 * * *']
    inputs = events['workflow_dispatch']['inputs']
    assert set(inputs) == {'engine', 'fail_on_canary', 'restore_state_run_id', 'continue_main_state'}
    assert inputs['continue_main_state']['type'] == 'boolean' and inputs['continue_main_state']['default'] == 'false'
    assert inputs['engine']['options'] == ['fake', 'live'] and inputs['engine']['default'] == 'fake'
    assert inputs['fail_on_canary']['type'] == 'boolean' and inputs['fail_on_canary']['default'] == 'true'
    assert inputs['restore_state_run_id']['required'] == 'false' and not inputs['restore_state_run_id'].get('default')


def test_schedule_requires_state_before_live_and_preserves_manual_restore():
    workflow = load_workflow(WORKFLOWS / 'v2-monitor.yml')
    live = workflow['jobs']['live']
    assert live['needs'] == 'offline'
    assert live['if'] == (
        "(github.event_name == 'schedule' && github.ref == 'refs/heads/main') || "
        "(github.event_name == 'workflow_dispatch' && inputs.engine == 'live')"
    )
    steps = live['steps']
    auto = next(step for step in steps if 'scripts/restore_v2_state.py' in step.get('run', ''))
    manual = next(step for step in steps if 'gh run download' in step.get('run', ''))
    collect = next(step for step in steps if '--engine live' in step.get('run', ''))
    assert auto['if'] == (
        "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' "
        "&& inputs.continue_main_state && inputs.restore_state_run_id == '' && github.ref == 'refs/heads/main')"
    )
    assert auto.get('continue-on-error', 'false') == 'false'
    assert manual['if'] == "github.event_name == 'workflow_dispatch' && inputs.restore_state_run_id != ''"
    assert steps.index(auto) < steps.index(collect) and steps.index(manual) < steps.index(collect)
    assert collect.get('if', 'success()') == 'success()'
    upload = next(step for step in steps if step.get('with', {}).get('name') == 'v2-state')
    assert upload['if'] == (
        "${{ success() || (!cancelled() && github.run_attempt == '1' && steps.collect.outcome == 'failure') }}"
    )
    assert collect['env']['FAIL_ON_CANARY'] == "${{ github.event_name == 'workflow_dispatch' && inputs.fail_on_canary }}"


def test_scheduled_and_manual_main_share_a_dedicated_lock():
    target = WORKFLOWS / 'v2-monitor.yml'
    lock = load_workflow(target)['concurrency']
    assert lock == {'group': 'tcl-v2-monitor-${{ github.ref }}', 'cancel-in-progress': 'false'}
    for other in WORKFLOWS.glob('*.y*ml'):
        if other != target:
            workflow = load_workflow(other)
            for entry in [workflow, *workflow.get('jobs', {}).values()]:
                group = entry.get('concurrency', '')
                if isinstance(group, dict):
                    group = group.get('group', '')
                assert 'tcl-v2-monitor-' not in group.lower(), other.name
