# @pureooze/pi-todo-session

Keeps the latest useful Pi session resumable from a project's root `TODO.md`.

## Install

```bash
pi install npm:@pureooze/pi-todo-session
```

When a root `TODO.md` exists, the extension writes the Pi session ID and session-file path after useful session activity. It does not make network requests. The session path may reveal local filesystem structure, so install it only in projects where that metadata is appropriate.
