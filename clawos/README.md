# ClawOS (Product Layer on OpenClaw)

ClawOS is a merge-friendly product layer built on top of upstream **OpenClaw** (open source).
We keep upstream core intact and add ClawOS capabilities as additive modules: docs, scripts, templates, and optional plugins.

## Design rules

- **Never develop on `main`** (keep it fast-forwarded to upstream).
- Develop on `clawos-layer`.
- Prefer additive changes under `./clawos/`.
- Keep runtime/user data **out of git** (use `./data/`, gitignored).

## Local development (repo)

Requirements:

- Node **>= 22**
- pnpm (via corepack)

Install:

```bash
corepack enable
pnpm install
```
