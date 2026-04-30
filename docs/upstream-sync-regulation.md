# Upstream Sync Regulation

This document defines the operational procedure for syncing this repository with upstream sources.

## Scope

- `upstream-desktop`: `https://github.com/jgraph/drawio-desktop.git`
- `upstream-drawio`: `https://github.com/jgraph/drawio.git`
- Local custom runtime repository (`seaf-plugin-runtime`) is excluded from this repository and is not part of sync flows here.

## Prerequisites

1. Working tree is clean before sync:
   - `git status`
2. Remotes are configured:
   - `origin`
   - `upstream-desktop`
   - `upstream-drawio`
3. Create a safety branch before each sync session:
   - `git checkout master`
   - `git checkout -b sync/<source>-<yyyymmdd>`

## Flow A: Sync from upstream-desktop (merge-based)

1. Fetch upstream desktop changes:
   - `git fetch upstream-desktop`
2. Merge upstream desktop into sync branch:
   - `git merge upstream-desktop/master`
3. Resolve conflicts and run validation:
   - `git status`
   - project-specific tests/checks
4. Commit conflict resolution if needed:
   - `git add .`
   - `git commit`
5. Fast-forward or merge sync branch into `master` after verification.

## Flow B: Sync from upstream-drawio (subtree-based)

This repository consumes `drawio` via subtree into `drawio-standalone`.

1. Fetch upstream drawio:
   - `git fetch upstream-drawio`
2. Pull subtree into target prefix:
   - `git subtree pull --prefix drawio-standalone upstream-drawio master --squash`
3. Resolve conflicts if present, then validate and commit.

## Conflict handling and recovery

### Merge conflict during Flow A

1. Inspect conflicted files:
   - `git status`
2. Resolve files, then:
   - `git add <resolved-files>`
   - `git commit`
3. If merge must be cancelled:
   - `git merge --abort`

### Subtree conflict during Flow B

1. Resolve conflicted files as usual and commit.
2. If subtree pull must be cancelled before commit:
   - `git reset --merge`
3. If needed, restore branch to pre-sync point:
   - `git reset --hard <pre_sync_commit>`
   - use only when branch is disposable and not pushed.

## Post-sync integrity checklist

1. `seaf-plugin-runtime` is not tracked:
   - `git ls-files | rg "^seaf-plugin-runtime/"`
2. Repository structure is intact:
   - `drawio-desktop/**` present
   - `drawio-standalone/**` present
3. No accidental local artifact tracking:
   - `.cursor/`, `.tmp/`, `.tmp_appdata/`, `.cache/` not in index
4. Build/test smoke checks pass per release process.

## Publication note

This regulation file must be committed before first push so sync procedures remain available even if initial publish fails.
