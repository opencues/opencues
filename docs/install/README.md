---
last_updated: 2026-07-04
---

# Install deep-dives

Supplementary detail for [`docs/install.md`](../install.md) — read that first; these are the "I need to know exactly what touches the system" documents, not a starting point.

| Doc | What it covers |
|---|---|
| [`dependencies.md`](dependencies.md) | The complete dependency surface — every tool an install touches, who owns installing it (contained / vendored / system-with-consent / daemon-client), and who owns uninstalling it. |
| [`walkthrough.md`](walkthrough.md) | A click-by-click, touch-counted walkthrough of all five integrations from "never heard of OpenCues" to working — what the installer does internally vs. what the user has to do by hand. |
| [`tmux-prebuilt.md`](tmux-prebuilt.md) | How the shell integration's `oc-install-tmux` prebuilt tmux tarballs are built and published, so a fresh `opencues install shell` can skip the C-toolchain build path. |
