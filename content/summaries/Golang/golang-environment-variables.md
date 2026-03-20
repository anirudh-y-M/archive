---
title: "Summary: Go Environment Variables"
---

> **Full notes:** [[notes/Golang/golang-environment-variables|Go Environment Variables →]]

## Key Concepts

### General Variables

The foundational variables control where Go lives and stores things. `GOROOT` is the Go installation directory (auto-detected). `GOPATH` is the workspace directory (default `~/go`) containing `src/`, `pkg/`, and `bin/` subdirectories for downloaded modules and installed binaries. `GOBIN` overrides where `go install` places binaries (default `$GOPATH/bin`). `GOENV` points to the environment config file (`~/.config/go/env`). `GOTOOLDIR` is where build tools (asm, compile, link) live.

### Module Variables

These control how Go fetches and verifies dependencies. `GO111MODULE` controls module mode (`on`/`off`/`auto`, default `on` since Go 1.16). `GOMODCACHE` is where downloaded modules live (default `$GOPATH/pkg/mod`). `GOPROXY` is a comma-separated list of proxy URLs (default `https://proxy.golang.org,direct`). `GOPRIVATE` is a shorthand that sets both `GONOPROXY` and `GONOSUMDB` for private modules. `GOSUMDB` names the checksum database (default `sum.golang.org`). `GONOSUMCHECK` skips even local `go.sum` verification for matching patterns. `GOFLAGS` sets default flags for every `go` command. `GOWORK` enables multi-module workspaces via `go.work` files.

### Build and Compilation Variables

`GOOS` and `GOARCH` set the target OS and architecture for cross-compilation. `CGO_ENABLED` controls C interop (`1` natively, `0` when cross-compiling). `CC`/`CXX` set the C/C++ compilers for cgo. `CGO_CFLAGS`/`CGO_CPPFLAGS`/`CGO_CXXFLAGS`/`CGO_LDFLAGS`/`CGO_FFLAGS` pass flags to respective compilers. `AR` sets the archiver tool. Architecture-specific tuning: `GOAMD64` (v1-v4 microarch levels), `GOARM` (5/6/7 float modes), `GOARM64`, `GOMIPS` (hardfloat/softfloat), `GOPPC64`, `GOWASM`. `GOTOOLCHAIN` controls which Go version to use (`local`, `auto`, or specific like `go1.21.0`).

### Linking Variables

`GOLDFLAGS` passes flags to the Go linker. `GOEXPERIMENT` enables/disables experimental Go features as a comma-separated list.

### Testing and Debugging Variables

`GORACE` configures the race detector (e.g., `log_path=/tmp/race halt_on_error=1`). `GOMAXPROCS` sets maximum OS threads executing Go code (default: CPU count). `GOTRACEBACK` controls stack trace detail on panic (`none`/`single`/`all`/`system`/`crash`). `GODEBUG` is a comma-separated list of runtime debug settings like `gctrace=1`, `schedtrace=1000`, `http2debug=1`.

### Caching and Temp Variables

`GOCACHE` is the build cache directory (default `~/.cache/go-build`, can be `off` to disable). `GOTMPDIR` overrides the system temp directory for compilation temporary files.

### Version Control and Fetching Variables

`GOVCS` controls which VCS tools are allowed per module path (default: `public:git|hg,private:all`). `GOINSECURE` allows fetching modules over plain HTTP. `GOAUTH` provides authentication credentials for private module fetching.

## Quick Reference

| Category | Variable | What It Does | Common Value |
|---|---|---|---|
| General | `GOPATH` | Workspace directory | `~/go` |
| General | `GOBIN` | Binary install location | `$GOPATH/bin` |
| Modules | `GOPROXY` | Module proxy URL(s) | `https://proxy.golang.org,direct` |
| Modules | `GOPRIVATE` | Skip proxy+sumdb for private repos | `github.com/myco/*` |
| Modules | `GOMODCACHE` | Module cache location | `$GOPATH/pkg/mod` |
| Modules | `GOFLAGS` | Persistent flags for all `go` cmds | `-mod=vendor` |
| Modules | `GOWORK` | Multi-module workspace file | `go.work` path or `off` |
| Build | `GOOS` / `GOARCH` | Cross-compile target | `linux` / `amd64` |
| Build | `CGO_ENABLED` | Enable/disable C interop | `0` for static binaries |
| Build | `GOTOOLCHAIN` | Pin Go version | `auto`, `go1.21.0` |
| Build | `GOAMD64` | x86-64 microarch level | `v1` (default) to `v4` (AVX-512) |
| Runtime | `GOMAXPROCS` | Max parallel OS threads for Go | CPU count (default) |
| Runtime | `GODEBUG` | Runtime debug flags | `gctrace=1`, `http2debug=1` |
| Runtime | `GOTRACEBACK` | Panic stack trace detail | `single` (default) |
| Cache | `GOCACHE` | Build cache directory | `~/.cache/go-build` |
| VCS | `GOVCS` | Allowed VCS tools | `public:git\|hg,private:all` |

**Check current values:** `go env`
**Set persistently:** `go env -w VARIABLE=value`

## Key Takeaways

- `GOPRIVATE` is a shorthand that sets both `GONOPROXY` and `GONOSUMDB` -- use it for all private/internal modules
- `CGO_ENABLED=0` is essential for building fully static binaries (e.g., for scratch/distroless Docker images)
- `GOOS`/`GOARCH` enable cross-compilation in a single command: `GOOS=linux GOARCH=amd64 go build`
- `GODEBUG` is a powerful runtime knob -- `gctrace=1` for GC analysis, `schedtrace=1000` for scheduler visibility
- `GOTOOLCHAIN=auto` lets projects auto-upgrade the Go version based on `go.mod` -- useful for teams
- `GOFLAGS=-mod=vendor` makes vendored builds the default without passing flags every time
- `GOAMD64` levels (v1-v4) let you target specific CPU feature sets for performance-critical binaries
- `GOVCS` restricts which version control tools can be used per module path -- important for security policy enforcement
- `GO111MODULE` defaults to `on` since Go 1.16; the GOPATH mode is effectively deprecated
