---
name: update-docs-site
description: Update the public VitePress documentation site in website/, including sidebar entries, screenshots, and the GitHub Pages build. Use when behavior, routes, environment variables, or commands change, or when adding or renaming a docs page.
whenToUse: When editing anything under website/, or when a code change alters user-visible behavior, setup steps, env vars, or commands that the public docs describe
---

The public documentation site lives in `website/` (VitePress) and deploys to
GitHub Pages at `https://simonscheff.github.io/amazon-king/` with base path
`/amazon-king/`.

Keep the docs in sync whenever behavior, routes, environment variables, or
commands change. The site is the self-hosting instructions for real users, so
stale setup steps break installs.

## Working in it

`website/` is a pnpm workspace member (`amazon-king-website`) with `dev`,
`build`, and `preview` scripts, run from that directory. It defines no `test` or
`typecheck` script, so the root `pnpm -r --if-present` commands skip it, and
`.prettierignore` excludes `website/` from the root Prettier check. Root
`pnpm check` therefore does **not** validate the docs — build them explicitly.

- Pages are Markdown under `website/`.
- The sidebar is defined in `website/.vitepress/config.mts`. A new page is
  invisible until it is added there.
- Screenshots live in `website/public/screenshots/` and are referenced as
  `/screenshots/<name>.png`. Do not include the base path; VitePress prepends
  it. Hardcoding `/amazon-king/` breaks local preview. To refresh them with
  the current UI and mock data, use the `update-website-screenshots` skill.
- Mermaid diagrams are available via `vitepress-plugin-mermaid`.

## Before pushing

Run `pnpm build` in `website/`. **VitePress fails the build on dead internal
links**, which is the most common way a docs change breaks CI. Renaming or
moving a page means updating every link to it plus the sidebar.

`.github/workflows/docs.yml` builds on every PR touching `website/` and deploys
on merges to `main`.

## Keep the two documentation sets straight

- `website/` is public, user-facing: installing, configuring, and operating a
  self-hosted deployment.
- `docs/` is internal working notes (`operations.md`, `self-hosting.md`, and
  draft design notes) and is excluded from the Prettier check.

A behavior change often needs both: internal notes for intent, and the website
for what an operator must now do differently.
