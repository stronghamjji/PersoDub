"""The CAM++ ONNX input tensor name is not portable across exports.

The server's bundled campplus.onnx names its input "input", but the public
exports do not (welcomyou -> "feats", Luigi -> "x"). Hardcoding "input" made the
worker fail on any downloaded model, which is why diarization degraded on the
Mac. Read the name off the session instead.

_embed() takes np/torch/kaldi as arguments, so this exercises it with stand-ins
-- none of those live in the app venv that runs the suite.
"""
import importlib.util
import os

SCRIPT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "app", "scripts", "campplus_diarize.py",
)
_spec = importlib.util.spec_from_file_location("campplus_diarize", SCRIPT)
cd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cd)


class FakeArray:
    def __init__(self, values):
        self.values = values

    def flatten(self):
        return self

    def __truediv__(self, d):
        return [v / d for v in self.values]


class FakeTensor:
    """Supports exactly the chain _embed() performs on the fbank output."""

    def __init__(self, payload=None):
        self.payload = payload

    def unsqueeze(self, _dim):
        return self

    def mean(self, dim=None, keepdim=False):
        return self

    def __sub__(self, _other):
        return self

    def numpy(self):
        return self.payload


class FakeTorch:
    @staticmethod
    def tensor(_arr):
        return FakeTensor()


class FakeKaldi:
    @staticmethod
    def fbank(_x, **_kw):
        return FakeTensor("fbank80")


class _FakeLinalg:
    @staticmethod
    def norm(_e):
        return 1.0


class FakeNp:
    linalg = _FakeLinalg

    @staticmethod
    def pad(arr, _width):
        return arr


class FakeInput:
    def __init__(self, name):
        self.name = name


class FakeSession:
    """Records which feed key the worker used."""

    def __init__(self, input_name):
        self._input_name = input_name
        self.seen_keys = None

    def get_inputs(self):
        return [FakeInput(self._input_name)]

    def run(self, _outputs, feed):
        self.seen_keys = list(feed.keys())
        return [FakeArray([1.0] * 192)]


def _embed_once(input_name):
    sess = FakeSession(input_name)
    seg = [0.0] * cd.SR  # 1s, longer than the 0.2s pad threshold
    cd._embed(seg, sess, FakeNp, FakeTorch, FakeKaldi)
    return sess.seen_keys


def test_uses_feats_input_name():
    assert _embed_once("feats") == ["feats"]


def test_uses_x_input_name():
    assert _embed_once("x") == ["x"]


def test_still_works_with_the_servers_input_name():
    assert _embed_once("input") == ["input"]


# --- Same bug, second site: the best-of-N take scorer ----------------------
# qwen_score_takes.py had its own hardcoded {"input": ...} feed. With a public
# campplus export (input name "feats") the scorer died and best-of-N silently
# degraded to "take 0 for every line" -- High quality mode spent 4x the time
# for Fast-mode results.
SCORER = os.path.join(os.path.dirname(SCRIPT), "qwen_score_takes.py")
_sspec = importlib.util.spec_from_file_location("qwen_score_takes", SCORER)
qs = importlib.util.module_from_spec(_sspec)
_sspec.loader.exec_module(qs)


def _scorer_embed_once(input_name):
    sess = FakeSession(input_name)
    x = [0.0] * qs.SR  # 1s, over the 0.4s minimum
    qs.embed(sess, x, FakeTorch, FakeKaldi)
    return sess.seen_keys


def test_scorer_uses_feats_input_name():
    assert _scorer_embed_once("feats") == ["feats"]


def test_scorer_still_works_with_the_servers_input_name():
    assert _scorer_embed_once("input") == ["input"]
