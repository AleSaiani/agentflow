# fake-repo — intentional-bug corpus for /flow:audit validation

This is **not real code**. It exists solely to exercise the `/flow:audit`
recipe end-to-end (and any future recipes that operate on source files).

## Layout

```
auth/
  Login.cs          — null deref + sync-over-async deadlock
  TokenIssuer.cs    — inverted lock order + race on dict read
billing/
  InvoiceRepository.cs — SQL injection + wrong decimal cast
  RefundProcessor.cs   — CancellationToken not propagated + connection leak + missing ConfigureAwait
api/
  Router.cs         — CLEAN baseline (no intentional bugs)
  Handlers.cs       — IEnumerable deferred execution + double enumeration
data/
  Repository.cs     — CLEAN baseline
  Migration.cs      — off-by-one in loop + swallowed exception
```

8 files, 4 components, **6 with intentional bugs** + **2 clean baselines**.

## Expected /flow:audit behavior

- Stage 1 (bash): finds 8 `.cs` files under `examples/fake-repo/`.
- Stage 2 (/enumerate code-review): per-file review. Should flag the 6 buggy files
  and pass the 2 clean ones (Router.cs, Repository.cs).
- Stage 3 (/group path-prefix depth=1 starting from the fake-repo root): partitions
  into 4 groups (auth, billing, api, data).
- Stage 4 (/reduce): executive digest with per-component severity rollup, hotspot
  list, and recurring pattern names (concurrency, sql-injection, async issues,
  resource leaks).

The recipe is the validation that the framework's API is good. If composing
enumerate → group → reduce requires hacks, the primitive contract needs fixing.
