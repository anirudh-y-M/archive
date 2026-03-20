---
title: "Summary: Go Environment Variables"
---

> **Full notes:** [[notes/Golang/golang-environment-variables|Go Environment Variables →]]

## Key Concepts

**Go env vars** control everything from where binaries install (`GOBIN`) to cross-compilation targets (`GOOS`/`GOARCH`), module fetching (`GOPROXY`, `GOPRIVATE`), cgo behavior (`CGO_ENABLED`), and runtime diagnostics (`GODEBUG`, `GOMAXPROCS`).

**Module variables** are the most operationally important -- `GOPROXY` controls where modules come from, `GOPRIVATE` keeps private repos off public infrastructure, and `GONOSUMDB`/`GONOSUMCHECK` control checksum verification.

**Build variables** enable cross-compilation (`GOOS=linux GOARCH=amd64 go build`) and static binaries (`CGO_ENABLED=0`).

## Quick Reference

| Variable | What It Does | Common Value |
|---|---|---|
| `GOOS` / `GOARCH` | Cross-compile target | `linux` / `amd64` |
| `CGO_ENABLED` | Enable/disable C interop | `0` for static binaries |
| `GOPRIVATE` | Skip proxy+sumdb for private repos | `github.com/myco/*` |
| `GOPROXY` | Module proxy URL(s) | `https://proxy.golang.org,direct` |
| `GOMODCACHE` | Module cache location | `$GOPATH/pkg/mod` |
| `GOMAXPROCS` | Max parallel OS threads for Go | CPU count (default) |
| `GODEBUG` | Runtime debug flags | `gctrace=1`, `http2debug=1` |
| `GOFLAGS` | Persistent flags for all `go` cmds | `-mod=vendor` |
| `GOTOOLCHAIN` | Pin Go version | `auto`, `go1.21.0` |

**Check current values:** `go env`
**Set persistently:** `go env -w VARIABLE=value`

## Key Takeaways

- `GOPRIVATE` is a shorthand that sets both `GONOPROXY` and `GONOSUMDB` -- use it for all private/internal modules
- `CGO_ENABLED=0` is essential for building fully static binaries (e.g., for scratch/distroless Docker images)
- `GODEBUG` is a powerful runtime knob -- `gctrace=1` for GC analysis, `schedtrace=1000` for scheduler visibility
- `GOTOOLCHAIN=auto` lets projects auto-upgrade the Go version based on `go.mod` -- useful for teams
- `GOFLAGS=-mod=vendor` makes vendored builds the default without passing flags every time
