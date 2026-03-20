---
title: "Summary: Git proactiveAuth"
---

> **Full notes:** [[notes/Git/git-proactiveauth|Git proactiveAuth - default 401s →]]

## Key Concepts

**The problem:** `go get` / `go mod download` triggers Git's HTTP challenge-response (unauthenticated request --> 401 --> retry with creds). At scale, the flood of 401s trips GitHub's anti-abuse system and blocks CI runner IPs.

**The fix:** `git config http.proactiveAuth auto` sends credentials on the first request, skipping the 401 entirely.

**Why a credential helper is needed:** `actions/checkout` uses `.extraheader` (injected `AUTHORIZATION` header), not a credential helper. But `proactiveAuth` only works through the credential helper path. So you must set up a credential helper separately using the same token.

**Why disable proactiveAuth during checkout:** If both `.extraheader` AND the credential helper send auth simultaneously, they conflict and break checkout. The wrapper disables proactiveAuth before checkout, re-enables after.

## Quick Reference

| Scenario | proactiveAuth | Credential Helper | Result |
|----------|--------------|-------------------|--------|
| Normal `go get` without fix | off | none | 401 --> retry --> works but triggers abuse detection |
| With proactiveAuth + helper | on | configured | Credentials sent immediately, no 401 |
| During `actions/checkout` | off (temporarily) | configured | Avoids conflict with `.extraheader` |
| `persist-credentials: false` | skipped | skipped | User opted out, respect that intent |

**Git version bug:** Setting `ENV GIT_VERSION=v2.53.0` in Dockerfile breaks Go's version parser because the `v` prefix isn't stripped. Fix: `GIT_VERSION=${GIT_VERSION#v}`.

## Key Takeaways

- proactiveAuth eliminates the 401 challenge-response cycle that triggers GitHub rate limiting at scale
- It only works with credential helpers, not with `.extraheader` -- both must be configured separately
- Must be disabled during `actions/checkout` to avoid conflicting auth mechanisms
- `persist-credentials: false` means skip all credential setup -- respect the user's intent
- Watch for the `v` prefix bug in Git version strings when building custom runner images
