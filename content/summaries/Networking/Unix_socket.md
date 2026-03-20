---
title: "Summary: The Unix Socket Technical Guide (Go Focus)"
---

> **Full notes:** [[notes/Networking/Unix_socket|Unix Domain Sockets -->]]

## Key Concepts

- **Unix Domain Socket (UDS)**: An IPC mechanism for processes on the same host. Data passes through kernel memory, bypassing the entire TCP/IP stack. Appears as a `.sock` file on the filesystem.

- **Connection lifecycle**: Server creates socket file and listens --> client dials the file path --> server accepts --> bidirectional data transfer via kernel buffers --> close sends FIN/EOF --> server must manually delete `.sock` file.

- **Why `cat`/`echo` don't work**: Regular file I/O uses `open()` syscall; sockets require `socket()` + `connect()`. The kernel recognizes the socket file type and rejects plain file operations.

- **Go support**: The `net` package treats UDS as first-class -- use `net.Listen("unix", path)` and `net.Dial("unix", path)`.

## Quick Reference

| Feature | Regular File | Unix Socket | TCP Socket |
|---|---|---|---|
| Speed | Slow (disk) | Fastest (memory) | Medium (network stack) |
| Scope | Persistent on disk | Local IPC only | Network / Local |
| Security | `chmod`/`chown` | `chmod`/`chown` | Firewall / iptables |
| I/O method | `cat`/`echo` | `nc -U` / code | `nc` / code |

**Best practices:**
- Clean up old `.sock` files before `Listen` (or use abstract sockets `@name` on Linux)
- Set `os.Chmod` on the socket for access control
- Always set `conn.SetDeadline()` to prevent zombie connections

## Key Takeaways

- UDS is the fastest IPC option -- no TCP/IP overhead, no checksums, no routing.
- Security is filesystem-based (`chmod`/`chown`) rather than network-based.
- The server must delete the `.sock` file on cleanup, or the next listen fails.
- Abstract sockets (`@name`, Linux only) live in memory and solve the cleanup problem.
- In Go, always reuse the same socket path and clean up with `os.Remove` before binding.
