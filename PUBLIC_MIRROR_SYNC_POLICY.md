# EtheRings Public Mirror Sync Policy

1. This repository has independent Git history.
2. The private engineering repository is read-only during public export.
3. Private Git history is never merged, rebased, pulled or mirrored here.
4. Private repositories are never configured as remotes of this repository.
5. Sync is performed only through reviewed file-level export.
6. Every export starts from an explicit allowlist and source commit.
7. Every export undergoes secret, privacy and content review before commit.
8. Source code is published only after a bounded publication audit.
9. Private operational, security, deployment, signer and credential material remains excluded.
10. Public commits describe public-content/source changes only.
11. Public history must not pretend to share ancestry with private history.
12. Public publication does not imply production deployment, Mainnet approval or release.
13. Website source remains outside this repository unless separately approved.
14. If a source file becomes unsafe for publication, remove it from the allowlist rather than weakening the private engineering boundary.

## Release updates

For each public app release, update `CHANGELOG.md` and `docs/RELEASE_HISTORY.md` in plain language, reconcile open and fixed tester reports in `docs/KNOWN_ISSUES.md`, and check that `README.md` and the build guide still describe the shipped source. Record an unpublished device build as such; do not call it a public release. Export changed source from a reviewed private revision after checking secrets, private addresses, player data and third-party licenses. Test the build that the public source can produce before pushing. Keep GitHub release tags tied to the code actually present at their commit; never backdate or rewrite Git history to simulate earlier development.
