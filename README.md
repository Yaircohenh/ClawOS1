# ClawOS (Product Layer for OpenClaw)

ClawOS is a fork of OpenClaw that adds a product layer on top of the upstream open-source core.

**Philosophy**
- Stay merge-friendly with upstream OpenClaw.
- Keep `main` aligned with upstream.
- Build ClawOS features as additive layers (scripts, templates, docs, packaging) first.
- Keep runtime/user data out of the repo.

## Repo layout

- Upstream OpenClaw code: (root repo)
- ClawOS layer: `./clawos`
- Runtime/user data (gitignored): `./data`

## Quick start (ClawOS recommended)

### 1) Install dependencies
This repo uses `pnpm` workspaces.

```bash
corepack enable
pnpm -v
pnpm install
