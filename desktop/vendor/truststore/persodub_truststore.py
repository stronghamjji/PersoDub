"""Trust what this computer trusts.

Company security software that inspects HTTPS swaps every site's certificate
for its own. Windows and macOS are told to trust that certificate, so browsers
work; Python checks only its bundled list (certifi) and refuses with
CERTIFICATE_VERIFY_FAILED. truststore makes Python verify against the
operating system's store instead, so pip, model downloads and the Perso API
calls all pass wherever a browser does.

The desktop installer copies this file and a .pth that imports it into every
venv (desktop/src/installSpec.js), so it runs at the start of each
interpreter there.

pip is the exception: from 24.2 pip carries its own truststore and uses it by
default, and two truststores wrapping each other recurse without end. Older
pips (the 24.0 that comes with Python 3.11) still need ours.
"""
import sys


def is_pip(argv):
    """True for `python -m pip ...`, the pip console script, and the pip that
    pip itself starts to install build dependencies (pip/__pip-runner__.py)."""
    if len(argv) >= 3 and argv[1] == "-m" and argv[2].split(".")[0] == "pip":
        return True
    if len(argv) < 2:
        return False
    path = argv[1].replace("\\", "/")
    name = path.rsplit("/", 1)[-1]
    return name.split(".")[0].startswith("pip") or "/pip/" in path


def pip_trusts_os_store(version):
    """pip 24.2+ verifies against the OS store on its own (Python 3.10+)."""
    try:
        major, minor = (int(x) for x in version.split(".")[:2])
    except ValueError:
        return True  # an unknown pip is taken for a new one: never double-wrap
    return (major, minor) >= (24, 2)


def should_inject(argv, pip_version):
    """pip_version is a callable, asked only when the process is pip."""
    return not (is_pip(argv) and pip_trusts_os_store(pip_version()))


def tolerate_unreadable_store(context_class, platform):
    """On Windows, a damaged certificate in the computer's store makes Python's
    read of the whole store fail ("ASN1 bad tag value met", issue #236), and
    with it every HTTPS download. truststore has Windows itself verify each
    site, so that read is not what decides trust there and can be skipped."""
    if platform != "win32":
        return
    load = context_class.load_default_certs

    def load_default_certs(self, *args, **kwargs):
        try:
            return load(self, *args, **kwargs)
        except OSError:
            pass

    context_class.load_default_certs = load_default_certs


def _pip_version():
    from importlib.metadata import version
    return version("pip")


try:
    if should_inject(getattr(sys, "orig_argv", []), _pip_version):
        import truststore
        tolerate_unreadable_store(truststore.SSLContext, sys.platform)
        truststore.inject_into_ssl()
except Exception:
    pass  # a hook that fails must never stop the interpreter
