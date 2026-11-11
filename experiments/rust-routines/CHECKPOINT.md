# Cron checkpoint evidence

Status: root validation passed. Independent source review found no P1/P2
within the documented bounded typed IANA domain.
All changes are contained in `experiments/rust-routines`.

- Actual production source: `packages/core/src/routines/cron.cjs` and its existing tests, pinned
  by `oracle-manifest.json`. Source hashes are checked before the differential oracle executes.
- Reproducible timezone dependency: current Jiff 0.2.42 parser, direct jiff-tzdb 0.1.4 / IANA
  2025b bytes, registry checksum in Cargo.lock. No ambient/system timezone database or clock.
- API: three pure helpers, immutable ordered field sets, typed integer epochs and explicit input
  bounds. The SystemV ICU-only gap and rejected out-of-domain values are documented in README.
- No timers, stores, process launch, network, credentials, providers, host/writer binding or
  production registration. Node execution exists only in explicit parity/check scripts.

Final agent evidence (all checks subsequently rerun by root):

| Check                                     | Result                                                                            | Local log                               |
| ----------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------- |
| Offline locked Rust tests                 | 15 tests and 1 compile-fail doctest pass                                          | `/tmp/milagre-cron-final-tests.log`     |
| Strict Clippy and formatter               | Pass, all targets, warnings denied                                                | `/tmp/milagre-cron-final-clippy.log`    |
| Existing production Node cron tests       | 19 pass                                                                           | `/tmp/milagre-cron-node-tests.log`      |
| Actual Node differential/source/data gate | 4168 parity vectors pass; 6 deliberate out-of-domain refusals reported separately | `/tmp/milagre-cron-final-parity.log`    |
| Compiled semantic mutation check          | All 6 mutants rejected by actual Node results                                     | `/tmp/milagre-cron-final-mutations.log` |

The final corpus includes the minimum and 9990 upper input bounds with extreme numeric offsets,
2096 to 2104, all bundled IANA names over historical/current/future samples, actual repeated and
skipped minutes, insertion order and exact error messages. The mutation gate catches strict-after,
DOM/DOW, repeat, gap, eight-year and large-stride changes; it does not treat a compilation error as
a killed semantic mutant.

Pinned official registry checksums in Cargo.lock:

- Jiff 0.2.42: `fefca06093eeaed707a905795e68206da0edca4edef23d2a3997a3ddbee462aa`.
- jiff-tzdb 0.1.4 (2025b): `c1283705eb0a21404d2bfd6eef2a7593d240bc42a0bdb39db0ad6fa2ec026524`.

The source reviewer's P3 checker observation is fixed: the six refusal observations require exact
output counts and exact expected causes, independently of the parity vectors. The reviewer did
not rerun tests.

These results do not claim complete cron parity or a full routines implementation. ICU-only
SystemV names remain a visible compatibility gap; scalar/input bounds are intentional refusals.
The implementation agent did not stage or commit. Root validated and integrates this isolated checkpoint.

Root logs: `/tmp/milagre-routines-root-tests.log` (15 Rust tests and one compile-fail doctest),
`/tmp/milagre-routines-root-clippy.log`, `/tmp/milagre-routines-root-node.log` (19),
`/tmp/milagre-routines-root-parity.log` (4168 exact comparisons and six explicit refusals), and
`/tmp/milagre-routines-root-mutations.log` (six compiled semantic mutants rejected).
Formatting also passes. No production routine is registered or executed by these checks.
