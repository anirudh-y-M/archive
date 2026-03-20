---
title: "Summary: Git proactiveAuth"
---

> **Full notes:** [[notes/Git/git-proactiveauth|Git proactiveAuth - default 401s →]]

## Key Concepts

### The Problem

`go get` / `go mod download` triggers Git's HTTP challenge-response flow: an unauthenticated request goes out, the server responds with a 401, then Git retries with credentials. At scale (many Go module fetches in CI), the flood of 401s trips GitHub's anti-abuse system and blocks the CI runner's NAT IPs entirely.

### The Fix: proactiveAuth

`git config http.https://github.com/your-org/.proactiveAuth auto` tells Git to send credentials on the **first** request, bypassing the 401 challenge-response cycle entirely. This eliminates the 401 flood that triggers GitHub's rate limiting.

### Why a Credential Helper is Needed

`actions/checkout` authenticates via `.extraheader` -- an `AUTHORIZATION` header injected into git config -- not via Git's credential helper system. However, `proactiveAuth` only triggers through the **credential helper** path. Without a credential helper configured, post-checkout `git fetch` commands fail with `could not read Username`. The wrapper solves this by setting up a global credential helper using the same token:

```
git config --global credential.https://github.com.helper \
  '!f() { echo "username=x-access-token"; echo "password=${TOKEN}"; }; f'
```

### Why proactiveAuth Must Be Disabled During Checkout

If both `.extraheader` (from `actions/checkout`) AND the credential helper (from proactiveAuth) send auth simultaneously, they conflict and break checkout. The wrapper disables proactiveAuth before checkout runs, then re-enables it afterward.

### persist-credentials Interaction

When `persist-credentials: true` (the default), credentials stay in local git config after checkout. The wrapper sets up the credential helper and enables proactiveAuth. When `persist-credentials: false`, the user explicitly opted out of persisted credentials, so the wrapper skips both credential helper setup and proactiveAuth to respect that intent.

### Git Version String Bug

The runner Dockerfile sets `ENV GIT_VERSION=v2.53.0`. Git's `GIT-VERSION-GEN` script checks if `$GIT_VERSION` is already set -- since it is, it skips version detection (including `v` prefix stripping) and uses `v2.53.0` as-is. This produces `git version v2.53.0` instead of `git version 2.53.0`. Go's version parser regex (`git version\s+(\d+\.\d+(?:\.\d+)?)`) expects digits after `git version` and fails on the `v`. Fix: pass `GIT_VERSION=${GIT_VERSION#v}` to `make`.

## Quick Reference

| Scenario | proactiveAuth | Credential Helper | Result |
|----------|--------------|-------------------|--------|
| Normal `go get` without fix | off | none | 401 --> retry --> works but triggers abuse detection |
| With proactiveAuth + helper | on | configured | Credentials sent immediately, no 401 |
| During `actions/checkout` | off (temporarily) | configured | Avoids conflict with `.extraheader` |
| `persist-credentials: false` | skipped | skipped | User opted out, respect that intent |

**The auth conflict:**

```
actions/checkout uses:    .extraheader (AUTHORIZATION header in git config)
proactiveAuth uses:       credential helper path

Both active simultaneously --> conflict --> checkout breaks
Solution: disable proactiveAuth during checkout, re-enable after
```

## Key Takeaways

- proactiveAuth eliminates the 401 challenge-response cycle that triggers GitHub rate limiting at scale
- It only works with credential helpers, not with `.extraheader` -- both auth mechanisms must be configured separately
- Must be disabled during `actions/checkout` to avoid conflicting auth mechanisms
- `persist-credentials: false` means skip all credential setup -- respect the user's intent
- Watch for the `v` prefix bug in Git version strings when building custom runner images -- Go's version parser chokes on it
