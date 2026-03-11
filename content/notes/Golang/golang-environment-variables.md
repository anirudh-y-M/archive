---
title: Go (Golang) Environment Variables
---

## General

| Variable | Description |
|---|---|
| `GOROOT` | Root directory of the Go installation (where the Go toolchain lives). Usually auto-detected. |
| `GOPATH` | Workspace directory for Go code. Default: `~/go`. Contains `src/`, `pkg/`, and `bin/` subdirectories. Used for storing downloaded modules and installed binaries. |
| `GOBIN` | Directory where `go install` places compiled binaries. Default: `$GOPATH/bin`. |
| `GOENV` | Path to the Go environment config file. Default: `~/.config/go/env`. |
| `GOTOOLDIR` | Directory where Go build tools (asm, compile, link, etc.) are installed. |

---

## Modules

| Variable | Description |
|---|---|
| `GO111MODULE` | Controls module mode. `on` = always use modules, `off` = never (use GOPATH mode), `auto` = use modules if `go.mod` exists (default since Go 1.16: `on`). |
| `GOMODCACHE` | Directory where downloaded modules are cached. Default: `$GOPATH/pkg/mod`. |
| `GOPROXY` | Comma-separated list of module proxy URLs. Default: `https://proxy.golang.org,direct`. `direct` means fall back to fetching directly from VCS. `off` disallows all downloads. |
| `GONOPROXY` | Comma-separated glob patterns of modules that should NOT go through the proxy (fetched directly from VCS). |
| `GONOSUMDB` | Comma-separated glob patterns of modules that should NOT be verified against the checksum database. |
| `GONOSUMCHECK` | Comma-separated glob patterns of modules that should NOT have their checksums validated (skips even local `go.sum` verification). |
| `GOPRIVATE` | Shorthand that sets both `GONOPROXY` and `GONOSUMDB`. Used for private/internal modules. Example: `GOPRIVATE=github.com/mycompany/*`. |
| `GOSUMDB` | Name and URL of the checksum database. Default: `sum.golang.org`. Set to `off` to disable checksum verification. |
| `GOFLAGS` | Default flags applied to every `go` command. Example: `GOFLAGS=-mod=vendor`. |
| `GOWORK` | Path to a `go.work` file for multi-module workspaces. Set to `off` to disable workspace mode. |

---

## Build & Compilation

| Variable | Description |
|---|---|
| `GOOS` | Target operating system for compilation. Examples: `linux`, `darwin`, `windows`, `freebsd`. |
| `GOARCH` | Target architecture. Examples: `amd64`, `arm64`, `386`, `arm`, `wasm`. |
| `CGO_ENABLED` | `1` = enable cgo (allows calling C code), `0` = disable cgo. Default: `1` when compiling natively, `0` when cross-compiling. |
| `CC` | C compiler to use for cgo. Default: `cc` or `gcc`. |
| `CXX` | C++ compiler to use for cgo. Default: `c++` or `g++`. |
| `CGO_CFLAGS` | Flags passed to the C compiler during cgo compilation. |
| `CGO_CPPFLAGS` | Flags passed to the C preprocessor during cgo compilation. |
| `CGO_CXXFLAGS` | Flags passed to the C++ compiler during cgo compilation. |
| `CGO_LDFLAGS` | Flags passed to the linker during cgo compilation. |
| `CGO_FFLAGS` | Flags passed to the Fortran compiler during cgo compilation. |
| `AR` | Archiver tool used for building C archives. Default: `ar`. |
| `GOAMD64` | Microarchitecture level for `GOARCH=amd64`. Values: `v1` (default, baseline), `v2`, `v3`, `v4` (AVX-512). |
| `GOARM` | ARM floating-point architecture for `GOARCH=arm`. Values: `5`, `6`, `7` (default). |
| `GOARM64` | ARM64 architecture features for `GOARCH=arm64`. Example: `v8.0` (default). |
| `GOMIPS` | Floating-point mode for MIPS. Values: `hardfloat` (default), `softfloat`. |
| `GOPPC64` | Power PC architecture level. Values: `power8` (default), `power9`, `power10`. |
| `GOWASM` | Comma-separated list of WebAssembly features for `GOARCH=wasm`. |
| `GOTOOLCHAIN` | Controls which Go toolchain version to use. Values: `local`, `auto`, or a specific version like `go1.21.0`. |

---

## Linking

| Variable | Description |
|---|---|
| `GOLDFLAGS` | Flags passed to the Go linker. |
| `GOEXPERIMENT` | Comma-separated list of experimental Go features to enable/disable. |

---

## Testing & Debugging

| Variable | Description |
|---|---|
| `GORACE` | Options for the race detector. Example: `GORACE="log_path=/tmp/race halt_on_error=1"`. |
| `GOMAXPROCS` | Maximum number of OS threads that can execute Go code simultaneously. Default: number of CPU cores. |
| `GOTRACEBACK` | Controls the detail level of stack traces on panic. Values: `none`, `single` (default), `all`, `system`, `crash`. |
| `GODEBUG` | Comma-separated list of debug settings. Examples: `gctrace=1`, `schedtrace=1000`, `http2debug=1`. |

---

## Caching & Temp

| Variable | Description |
|---|---|
| `GOCACHE` | Directory for build cache. Default: `~/.cache/go-build` (Linux/Mac). Set to `off` to disable. |
| `GOTMPDIR` | Directory for temporary files created during compilation. Default: system temp dir. |

---

## Version Control & Fetching

| Variable | Description |
|---|---|
| `GOVCS` | Controls which VCS tools are allowed for fetching modules. Example: `GOVCS=github.com:git,*:off` (only allow git for GitHub, block all others). Default: `public:git|hg,private:all`. |
| `GOINSECURE` | Comma-separated glob patterns of modules that can be fetched over insecure (HTTP) connections. |
| `GOAUTH` | Authentication credentials for fetching modules from private repos. |

---

## Quick Reference — Most Commonly Used

| Variable | Typical Use Case |
|---|---|
| `GOOS` / `GOARCH` | Cross-compilation (`GOOS=linux GOARCH=amd64 go build`) |
| `GOPRIVATE` | Private repos (`GOPRIVATE=github.com/mycompany/*`) |
| `GOPROXY` | Corporate proxy or air-gapped environments |
| `CGO_ENABLED` | Disable C dependencies for static binaries (`CGO_ENABLED=0`) |
| `GOMAXPROCS` | Tune concurrency at runtime |
| `GODEBUG` | Runtime diagnostics (`GODEBUG=gctrace=1`) |
| `GOFLAGS` | Set persistent build flags (`GOFLAGS=-mod=vendor`) |
| `GOTOOLCHAIN` | Pin or auto-upgrade Go version per project |

---

> You can always check your current values with `go env` and set them persistently with `go env -w VARIABLE=value`.
