# zig-setup

Installs Zig and caches the Zig cache directory between runs. Runs on Node 24 with no dependencies.

```yaml
- uses: grant-wade/zig-setup@v1.0.0
  with:
    version: 0.16.0
```

Inputs match `mlugg/setup-zig@v2`, so it can be swapped in directly. Unlike setup-zig, only the default branch saves to the cache by default.

## How it works

1. Resolves `version`. When empty, it reads `mach_zig_version` or `minimum_zig_version` from `build.zig.zon`, then falls back to `latest`.
2. Restores the Zig archive from the Actions cache, or downloads it from a random [community mirror](https://ziglang.org/download/community-mirrors.txt), falling back to ziglang.org if every mirror fails.
3. Verifies the archive's minisign signature and signed file name, both after downloading and after restoring from cache.
4. Adds Zig to `PATH`, points `ZIG_GLOBAL_CACHE_DIR` and `ZIG_LOCAL_CACHE_DIR` at `.zig-cache` in the workspace, and restores it from the Actions cache.
5. After the job, saves `.zig-cache` without `tmp/`, unless nothing changed since the restore. A cache over `cache-size-limit` is cleared before saving.

Cache entries are keyed by job, Zig version, OS, architecture and `cache-key`. Restores use the newest matching entry.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `version` | from `build.zig.zon` | `0.16.0`, `0.17.0-dev.351+64ef45eb0`, `master`, `latest`, or a Mach version such as `2024.11.0-mach`. |
| `mirror` | | Download only from this mirror. ziglang.org is not allowed. |
| `use-cache` | `true` | Restore and save the Zig cache. |
| `save-cache` | `auto` | `auto` saves only from the default branch, `true` always, `false` never. |
| `cache-key` | | Extra cache key component, e.g. matrix variables. |
| `cache-size-limit` | `2048` | Maximum cache size in MiB. `0` means no limit. |
| `use-tool-cache` | `true` on self-hosted runners | Extract Zig into `RUNNER_TOOL_CACHE` for reuse across jobs. |

## Outputs

| Output | Description |
| --- | --- |
| `zig-version` | Output of `zig version`. |
| `zig-path` | Directory containing `zig`. |
| `cache-hit` | Whether a Zig cache entry was restored. |

## Requirements

Uses the system `tar` (`System32\tar.exe` on Windows); Linux also needs `xz`. Caching needs the Actions cache service v2, so it is skipped on GitHub Enterprise Server.

## Development

```sh
node --test
```

## Credits

Based on [mlugg/setup-zig](https://codeberg.org/mlugg/setup-zig).
