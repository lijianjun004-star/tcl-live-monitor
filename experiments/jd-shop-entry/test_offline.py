"""Run: python3 -B experiments/jd-shop-entry/test_offline.py"""
import json
import hashlib
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from tempfile import TemporaryDirectory

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[1] / 'src'))
from jd_shop_entry import decide

NOW = datetime(2026, 11, 20, tzinfo=timezone.utc)
ROOM = 'https://lives.jd.com/#/10000001'


class ShopEntryTests(unittest.TestCase):
    def setUp(self):
        self.example = json.loads((HERE / 'FICTIONAL-observation.json').read_text())
        self.store = self.example['store_page']
        self.room = self.example['room_page']
        self.detail = self.example['strict_room_result']

    def result(self):
        return decide(self.example, NOW)

    def unknown(self):
        self.assertEqual(self.result()['current_state'], 'UNKNOWN')
        self.assertIsNone(self.result()['corroborated_session_id'])

    def test_three_observations_agree_only_at_recorded_time(self):
        for status in ('live', 'replay', 'offline'):
            self.detail['live_status'] = status
            out = self.result()
            self.assertEqual(out['observed_status'], status.upper())
            self.assertEqual(out['current_state'], 'UNKNOWN')
            self.assertEqual(out['corroborated_session_id'], '10000001')
            self.assertEqual(out['input_kind'], 'synthetic')

    def test_shop_id_binding_needs_exact_final_route(self):
        for url in ('https://mall.jd.com/index-000001.html', 'https://shop.m.jd.com/?shopId=721631&shopId=99999', 'https://shop.m.jd.com.invalid/?shopId=721631'):
            self.store['final_url'] = url
            self.unknown()

    def test_mobile_app_landing_stops(self):
        self.store['final_url'] = 'https://wqs.jd.com/downloadApp/download.html'
        self.assertEqual(self.result()['reason'], 'SHOP_APP_DOWNLOAD_LANDING')
        self.unknown()

    def test_exact_shop_page_without_visible_links(self):
        self.store['visible_links'] = []
        self.assertEqual(self.result()['reason'], 'SHOP_ENTRY_MISSING_OR_AMBIGUOUS')
        self.unknown()

    def test_recommendation_or_missing_context_not_an_entry(self):
        for trail in (['推荐直播'], ['本店直播', '猜你喜欢'], [], None):
            self.store['visible_links'][0]['heading_path'] = trail
            self.unknown()

    def test_ambiguous_and_invalid_sessions(self):
        self.store['visible_links'].append({'heading_path':['本店直播'], 'href':'https://lives.jd.com/#/10000002'})
        self.unknown()
        for bad in ('0123456', '1234', '1'*19, '１２３４５'):
            self.store['visible_links'] = [{'heading_path':['本店直播'], 'href':'https://lives.jd.com/#/'+bad}]
            self.unknown()

    def test_publisher_link_must_be_from_the_room_and_the_same_shop(self):
        self.room['visible_links'][0]['href'] = 'https://shop.m.jd.com/?shopId=721632'
        self.unknown()
        self.room['visible_links'][0]['href'] = 'https://shop.m.jd.com/?shopId=721631'
        self.room['final_url'] = ROOM+'0'
        self.unknown()

    def test_room_recommendation_does_not_prove_owner(self):
        self.room['visible_links'][0]['heading_path'] = ['推荐店铺']
        self.unknown()

    def test_id_or_positive_boolean_alone_is_insufficient(self):
        self.example['strict_room_result'] = {'room_id':'10000001', 'verified':True}
        self.unknown()
        self.example['strict_room_result'] = self.detail
        self.detail['diagnostics']['target_request_samples'] = []
        self.unknown()

    def test_non_synthetic_requires_separate_artifact_and_matching_digest(self):
        self.example['input_kind'] = 'offline_observation'
        self.unknown()
        raw = json.dumps(self.detail).encode()
        checksum = hashlib.sha256(raw).hexdigest()
        for blob, digest in [(raw, '0' * 64), (raw + b' ', checksum), (None, checksum)]:
            self.assertIsNone(decide(self.example, NOW, strict_artifact=blob, expected_sha256=digest)['corroborated_session_id'])
        # A conflicting inline state must never override the separate file.
        self.detail['live_status'] = 'offline'
        self.assertEqual(decide(self.example, NOW, strict_artifact=raw, expected_sha256=checksum)['observed_status'], 'LIVE')

    def test_wrong_function_or_endpoint_cannot_establish_state(self):
        diagnostics = self.detail['diagnostics']
        diagnostics['observed_function_ids'] = ['liveDetailToM']
        self.unknown()
        diagnostics['observed_function_ids'] = ['getImmediatePlayToM']
        self.detail['evidence_endpoints'] = ['https://api.m.jd.com/']
        self.unknown()

    def test_unadmitted_diagnostic_shape_cannot_establish_state(self):
        sample = self.detail['diagnostics']['target_request_samples'][0]
        for key, bad in [('method', 'HEAD'), ('function_id_source', 'post_json'),
                        ('eligible_probe', False), ('mime_category', 'text_plain'), ('safe_path', '/')]:
            old = sample[key]
            sample[key] = bad
            self.unknown()
            sample[key] = old

    def test_conflicting_or_missing_admitted_status_evidence(self):
        self.detail['reasons'] = ['conflicting_detail_states']
        self.unknown()
        self.detail['reasons'] = []
        self.detail['diagnostics']['detail_data_keys'] = ['liveId']
        self.unknown()

    def test_failed_blocked_future_or_unrelated_evidence(self):
        for key, value in [('room_id','10000002'), ('login_or_captcha_blocked',True), ('generated_at','2099-01-03T00:00:00Z'), ('generated_at','2026-11-11T04:00:00Z')]:
            with self.subTest(key=key):
                prior = self.detail[key]
                self.detail[key] = value
                self.unknown()
                self.detail[key] = prior
        self.store['http_status'] = 403
        self.unknown()

    def test_invalid_cli_input_is_redacted(self):
        with TemporaryDirectory() as tmp:
            file = Path(tmp) / 'input.json'
            file.write_text('{"private_marker":0,"private_marker":1}')
            r = subprocess.run([sys.executable,'-B',str(HERE.parents[1]/'src'/'jd_shop_entry.py'),str(file)],capture_output=True,text=True)
            self.assertEqual(r.returncode, 2)
            self.assertNotIn('private_marker', r.stdout+r.stderr)


if __name__ == '__main__':
    unittest.main()
