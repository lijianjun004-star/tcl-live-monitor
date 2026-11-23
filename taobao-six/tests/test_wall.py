"""Offline checks, with no visit to a website."""
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from wall import VideoWall, tile_bounds


class FakeChrome:
    def __init__(self):
        self.targets = {"search": 2}
        self.calls = []
        self.counter = 0

    def send(self, method, params=None):
        self.calls.append((method, params))
        if method == "Target.getTargets":
            return {"targetInfos": [{"targetId": k} for k in self.targets]}
        if method == "Target.createTarget":
            assert params["newWindow"] is True
            self.counter += 1
            target = str(self.counter)
            self.targets[target] = self.counter + 2
            return {"targetId": target}
        if method == "Target.closeTarget":
            del self.targets[params["targetId"]]
            return {"success": True}
        if method == "Browser.getWindowForTarget":
            return {"windowId": self.targets[params["targetId"]], "bounds": {}}
        assert method == "Browser.setWindowBounds"

    def detach(self):
        pass


def shop(name, room_id):
    return {"name": name, "isLive": bool(room_id),
            "liveUrl": f"https://tbzb.taobao.com/live?liveId={room_id}" if room_id else None}


class WallTests(unittest.TestCase):
    def test_grid(self):
        tiles = tile_bounds(6, 1921, 1081, -1921, -300)
        self.assertEqual((tiles[0]["left"], tiles[0]["top"]), (-1921, -300))
        self.assertEqual(sum(t["width"] * t["height"] for t in tiles), 1921 * 1081)
        self.assertEqual(len({t["left"] for t in tiles}), 3)
        self.assertEqual(len({t["top"] for t in tiles}), 2)
        self.assertEqual(len(tile_bounds(9, 1920, 1080, 0, 0)), 9)

    def test_reconcile(self):
        chrome = FakeChrome()
        browser = Mock()
        browser.new_browser_cdp_session.return_value = chrome
        wall = VideoWall(SimpleNamespace(browser=browser), 1920, 1080, 0, 0)
        wall.sync([shop("a", 1), shop("b", 2)])
        self.assertEqual(set(chrome.targets), {"search", "1", "2"})
        wall.sync([shop("b", 2), shop("a", 1)])
        self.assertEqual(chrome.counter, 2)
        del chrome.targets["2"]  # User manually closed the stream window.
        wall.sync([shop("a", None), shop("b", 2)])
        self.assertEqual(set(chrome.targets), {"search", "3"})
        wall.sync([shop("a", None), shop("b", 4)])  # New session for the same shop.
        self.assertEqual(set(chrome.targets), {"search", "4"})
        wall.close()
        self.assertEqual(set(chrome.targets), {"search"})


if __name__ == "__main__":
    unittest.main()
