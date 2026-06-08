# git-encrypt

A self-contained Go CLI from **Tanglement.ai** for transparent, key-based file encryption in a git workflow — built **entirely on the Go standard library** (no external dependencies). It derives a shared secret via ECDH over ECDSA (P-256) keys (with RSA key support), and carries versioned encryption metadata so encrypted blobs are self-describing.

Representative of the kind of small, dependency-free systems tooling I write. Part of the [Tanglement.ai showcase](../../).

## Build & run
```bash
go build -o git-encrypt .
./git-encrypt -h
```

*~480 LOC, single file, standard library only.*
