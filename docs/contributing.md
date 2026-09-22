# Contributing

Issues and pull requests are welcome. Please open an issue describing the problem or
proposal before starting substantial work, so effort is not duplicated.

You do not have to write a bug report by hand. When an install or a dub fails, the app
reports it by itself: the machine, the step it stopped at, the error and the logs, with
your home folder, your API keys and your links taken out first. The same failure from
many machines becomes one issue with a count on it, not many. Exactly what is sent, and
how to turn it off, is in [Data and privacy](privacy.md). With it turned off, the bug
report form on the Issues page asks for the same facts and you choose what to paste.

Setup, architecture, and how to run the test suite are in [Development](development.md).
The backend targets Python 3.11 and is not yet compatible with 3.13 or later.

## Security

Please do not report security issues in public issues. Use GitHub's
[private vulnerability reporting](https://github.com/stronghamjji/PersoDub/security/advisories/new)
so the problem can be addressed before disclosure.

PersoDub stores your API keys in a file on your machine. Treat that file, and any log or
screenshot you share, the way you would treat the keys themselves.
