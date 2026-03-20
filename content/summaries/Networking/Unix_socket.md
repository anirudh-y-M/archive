---
title: "Summary: The Unix Socket Technical Guide (Go Focus)"
---

> **Full notes:** [[notes/Networking/Unix_socket|Unix Domain Sockets -->]]

## Key Concepts

### What is a Unix Domain Socket?

A Unix Domain Socket (UDS) is an **inter-process communication (IPC)** endpoint for data exchange between processes on the same host. It uses the kernel's memory to pass data, bypassing the entire TCP/IP network stack -- no headers, no routing, no checksums. It appears as a special file (e.g., `.sock`) in the filesystem, and standard file permissions (`chmod`/`chown`) control access.

### Connection Lifecycle (The Flow)

The connection follows a strict kernel-managed state machine with three phases:

**Establishment:** Server creates a socket file and calls `Listen` (kernel marks it "listening"). Client calls `Dial`/`Connect` specifying the file path (kernel checks permissions). Server calls `Accept` (kernel creates a dedicated communication channel for this pair).

**Data Transfer:** Data is written to a kernel buffer. The kernel immediately notifies the receiver. Communication is **full-duplex** -- both processes can read and write simultaneously.

**Teardown:** One side sends a `FIN` signal via the kernel. The other side receives `EOF` (End of File). Both close their file descriptors. **Crucially**, the server must manually delete the `.sock` file from disk, or the next `Listen` attempt fails with "address already in use."

### Go Implementation

Go's `net` package treats Unix sockets as first-class. Server: `net.Listen("unix", socketPath)` + `Accept()` in a loop, handling each connection in a goroutine. Client: `net.Dial("unix", socketPath)` + read/write. Always clean up old socket files before `Listen` with `os.Remove(socketPath)`.

### Why `cat`/`echo` Don't Work

Regular file I/O uses the `open()` syscall meant for storage files. Sockets require the `socket()` + `connect()` syscalls. The kernel recognizes the "S" attribute (Socket) on the file and rejects plain file operations with an error (e.g., `Device not configured`). Use `nc -U /tmp/demo.sock` or code for socket I/O.

### Comparison Table

| Feature | Regular File | Unix Socket | TCP Socket |
|---|---|---|---|
| Speed | Slow (Disk I/O) | **Fastest** (Memory) | Medium (Network Stack) |
| Scope | Persistent on disk | Local IPC only | Network / Local |
| Lifecycle | Exists until deleted | File exists; connection is transient | No file; port-based |
| I/O Method | `cat` / `echo` | `nc -U` / code | `nc` / code |
| Security | `chmod` / `chown` | `chmod` / `chown` | Firewall / iptables |

### Best Practices for Go Developers

- **Abstract Sockets (Linux Only):** Use `@name` as the path -- the socket lives in memory only with no physical file, solving the cleanup problem entirely.
- **Permissions:** After `net.Listen`, use `os.Chmod(socketPath, 0600)` to restrict access to your user only.
- **Deadlines:** Always set `conn.SetDeadline()` to prevent zombie connections from hanging goroutines if a client crashes.

## Quick Reference

```
Server                          Client
  |                               |
  | net.Listen("unix", path)      |
  |   kernel creates .sock file   |
  |                               |
  |     <--- net.Dial("unix") --- |
  |   kernel checks permissions   |
  |                               |
  | Accept()                      |
  |   kernel creates channel      |
  |                               |
  | <-- Read/Write (full-duplex) -->
  |                               |
  | Close() --> FIN               |
  |              EOF --> Close()  |
  |                               |
  | os.Remove(path)  <-- CRUCIAL  |
```

## Key Takeaways

- UDS is the fastest IPC option -- zero TCP/IP overhead, data passes through kernel memory only.
- Security is filesystem-based (`chmod`/`chown`), not network-based (firewall/iptables).
- The server must manually delete the `.sock` file on cleanup, or the next listen fails -- this is a common gotcha.
- Abstract sockets (`@name`, Linux only) live in memory and eliminate the cleanup problem entirely.
- `cat`/`echo` fail on sockets because they use `open()` instead of `socket()`+`connect()` syscalls.
- In Go, always reuse the same socket path, clean up with `os.Remove` before binding, and set `conn.SetDeadline()` to prevent zombie connections.
