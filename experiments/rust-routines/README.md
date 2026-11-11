# Pure routine cron checkpoint

Standalone, `publish = false`, and unregistered with any production service. The public library
ports only the pure helpers in `packages/core/src/routines/cron.cjs`: `parseCron`, `everyToCron`
and `nextRun`. A separate private schedule/heartbeat state fixture is described in
[STORE-CHECKPOINT.md](STORE-CHECKPOINT.md); it is compiled only for tests and explicit fixture
targets, with no public store or commit API. The private Unix `copied_store_fixture` adds
fresh-copy file ownership and publication as described in
[COPIED-WRITER-CHECKPOINT.md](COPIED-WRITER-CHECKPOINT.md). The public library remains pure.
There is no timer, scheduler, host access, provider launch, network operation or Node fallback.
Test scripts invoke the real Node source as an oracle.
This is a bounded IANA-timezone checkpoint, not complete cron parity or a full routines port.

## API and preserved behavior

```rust
use milagre_routines::{parse_cron, every_to_cron, next_run};

let cron = parse_cron("0,30 9-17/4 */10 1-3 1,7").unwrap();
assert_eq!(cron.hour(), &[9, 13, 17]);
assert_eq!(cron.day_of_week(), &[1, 0]);
assert_eq!(every_to_cron("120m").unwrap(), "0 */2 * * *");
assert_eq!(next_run("* * * * *", "UTC", -1).unwrap(), 0);
```

`Cron` exposes immutable field slices in JS Set insertion order. Lists, ranges, steps,
deduplication, Sunday 7 removal/0 insertion and exact error precedence follow the source.
Whitespace uses the ECMAScript set, including BOM and excluding U+0085. Very large positive
strides, including decimal overflow to JS Number Infinity, contribute their first value;
they are never narrowed before the range check. Decimal error rendering uses `ryu-js`.

Day-of-month/day-of-week use OR only when both expanded sets are restricted. Restriction is
set cardinality, not whether the input literally contains `*`. The next result is a whole
minute strictly after the supplied instant, with floor division for negative epochs. The
calendar search skips excluded months, runs through the inclusive eight-year boundary and
normalizes a cap-year February 29 the same way as JS Date.UTC. It finds 2104's leap day after
March 2096 even though 2100 is not a leap year.

Timezone conversion reproduces Node's wall-minute truncation and six-hour offset sampling
algorithm. Spring gaps are skipped. A repeated minute fires only at its first occurrence;
asking after that first instant never schedules the repeated copy. Half-hour, two-hour and
skipped-calendar-day changes are covered. The implementation deliberately preserves the
source algorithm rather than replacing it with a library's default gap/fold resolution.

## Explicit input domain and remaining gap

| Input                        | Accepted domain or deliberate refusal                                                                                                                                                                                                                 |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expression/cadence           | UTF-8 strings, at most 4096 bytes. Malformed expressions preserve Node errors within this bound. Non-string JS coercion is outside the typed Rust API.                                                                                                |
| Epoch                        | Signed integer milliseconds from `1900-01-02T00:00:00.000Z` (`-2208902400000`) through `9990-12-30T23:59:59.999Z` (`253118217599999`). This leaves room for the complete search and timezone probes. Earlier/later epochs return `Error::Timestamp`.  |
| Fractional/non-finite epoch  | Cannot enter the `i64` API. The JSON test driver rejects fractional number values; JSON itself rejects NaN/Infinity literals. No silent rounding, saturation or JS Date coercion. This differs from accepted large strides inside an expression.      |
| Timezone                     | At most 128 bytes. Pinned IANA names, their observed ICU canonical aliases, ASCII case variants and Intl numeric offsets `+HH`, `+HHMM`, `+HH:MM` (or minus), with hour 0..23/minute 0..59. Unknown names never fall back to UTC.                     |
| ICU-only SystemV identifiers | **Remaining parity gap:** Node accepts names such as `SystemV/EST5`, `SystemV/EST5EDT` and `SystemV/PST8PDT`. They are absent from the pinned IANA bundle and explicitly return unknown-timezone errors here. No substitute transitions are invented. |

The old Node aliases `US/Pacific-New` and `Canada/East-Saskatchewan` are included through the
observed canonical-name table. No claim covers every identifier accepted by ICU outside the
IANA inventory. `check-parity.py` separately demonstrates the documented SystemV/epoch refusals
against successful Node results, so those differences are visible rather than counted as parity.

The library retains at most 134 distinct parsed field values. One expression is bounded before
splitting or error construction. Calendar work is bounded by at most `8 * 366 + 1` candidate days
and 1440 candidate wall minutes per matching day; each candidate uses at most five timezone
reads. Month jumps and the first valid result usually make the work much smaller. These are
algorithmic bounds, not a timer or a hard wall-clock deadline.

## Reproducible timezone data and source drift

The parser is pinned to `jiff = 0.2.42`, with default features disabled and only `std` enabled.
It reads the embedded TZif bytes from the separately pinned `jiff-tzdb = 0.1.4`, whose declared
IANA release is **2025b**. This matches the actual oracle, Node **v24.13.0**, ICU **77.1**,
TZDB **2025b**. Jiff's newer 2026e bundle and this Mac's 2026f system database are not used.
`Cargo.lock` contains registry checksums; the library refuses a data-version mismatch.
No `TZ` environment lookup, system zoneinfo discovery or external timezone file is enabled.

The matching data release was identified from the maintainer's
[0.2.5 manifest](https://github.com/BurntSushi/jiff/blob/0.2.5/crates/jiff-tzdb/Cargo.toml) and
[2025b update](https://github.com/BurntSushi/jiff/blob/0.2.5/CHANGELOG.md#025-2025-03-22), then
fetched through Cargo's official registry and verified locally. The current Jiff parser stays
in use; timezone data compatibility does not require downgrading the parser.

`oracle-manifest.json` pins SHA-256 for the actual production cron module and its original test
file. The Node oracle fails on either source hash or Node/ICU/TZDB version drift. Rust's offline
source test verifies both source hashes and the embedded data version too. The alias table is
generated from the actual Node formatter over the pinned IANA names and checked for reproducible
regeneration. Changing a pin requires reviewing the source/data changes and rerunning the gates.

## Checks and evidence

```sh
cargo test --offline --locked --manifest-path experiments/rust-routines/Cargo.toml
cargo clippy --offline --locked --manifest-path experiments/rust-routines/Cargo.toml --all-targets -- -D warnings
cargo fmt --manifest-path experiments/rust-routines/Cargo.toml -- --check
node --test packages/core/src/routines/cron.test.cjs
python3 experiments/rust-routines/scripts/check-parity.py
python3 experiments/rust-routines/scripts/check-mutations.py
```

The parity checker runs Node `--check`, verifies source/runtime/data/alias drift, and compares
real production results with the Rust fixture. It covers all bundled zone names at historical,
current and future dates, DST repeat/gap boundaries, Lord Howe/Troll/Apia, fixed offsets,
negative epochs, 9990's upper bound, 2096 to 2104, exact errors and large strides. No expected
schedule output is fabricated by a second JS implementation.

The mutation checker compiles isolated copies of Rust source and requires the real Node oracle
to reject six semantic changes: inclusive scheduling, DOM/DOW AND, choosing the repeated minute's
second occurrence, accepting a spring gap, a one-year cap, and losing the first large-stride
value. Production sources remain untouched. Temporary mutant source trees are removed; their
build outputs stay under this crate's ignored `target` directory.

Cron validation and independent review status are recorded in `CHECKPOINT.md`; the private
state fixture has its own evidence document. No production routine scheduling, persistence,
claim authority, restart recovery, dispatch or UI integration is implemented by these checkpoints.
