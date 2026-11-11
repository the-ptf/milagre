# Checked wake lifetime amendment

Status: root and independent source-plan review accept this narrow accounting amendment for the checked-wake-only checkpoint. Rotating buckets remain separate. This refines the immutable weak-slot lifetime in [the 2B.3 plan](FIXED-OWNER-DELIVERY-PLAN.md), without unsafe code, a new dependency, a hidden wake lock or a larger resource allowance.

## Fields and reference ownership

```rust
struct WakeAccess {
    link: OnceLock<Weak<WakeHub>>,
    allocation: Reservation,
}
struct WakeHub {
    generation: AtomicU64,
    overflow: AtomicBool,
    actor: OnceLock<Thread>,
    shared: Weak<Shared>,
}
// Shared: Option<WakeAccess>; fixed State and RuntimeFixed: Arc<WakeHub>.
// Internal worker/Packet token: Weak<WakeHub>.
```

Shared owns the only weak hub reference permitted to outlive run drainage. Public clients, approvals, receipts and permits never own `Weak<WakeHub>` directly. Public strong clients already retain Shared; approval Drop gets only a private-mode `Weak<Shared>`. A wake through that path first upgrades Shared, which keeps its allocation charge alive throughout the hub upgrade/use. Ordinary mode keeps its existing Condvar behavior.

`WakeAccess::drop` explicitly takes and drops `link` using its exclusive `&mut self`, before `allocation` is dropped. The fields also appear in that order. No wake path mutates/takes the immutable slot or acquires a lock. The last strong Shared release destroys this payload even if inert existing `Weak<Shared>` clients remain, so those weak clients retain no live hub link or reservation. The hub's own `Weak<Shared>` is a payload field: it is destroyed at the hub's final strong release and cannot create a permanent weak-only cycle.

Only fixed State and Runtime own lasting strong hub references. An upgrade inside a wake is temporary and holds no writer, Runtime, lease or JoinHandle. Internal worker and Packet tokens carry immutable weak hub references, prepared before Begin; the actual join/packet-drain proof destroys those tokens before run strong references are dropped. No returned-credit cell or public handle receives a token. Tests must assert token drainage before releasing the last run strong hub reference, or use explicit instrumentation: `Weak::weak_count` reports zero after all strong references disappear and cannot prove the remaining weak allocation count. Tests must not retain an uncharged standalone hub token across Shared destruction.

## Reservation split

Compute the conservative charge with checked arithmetic:

```
arc_storage = size_of::<WakeHub>()
            + 2 * size_of::<usize>()
            + (align_of::<WakeHub>() - 1)
counter_tail = budget::fixed_backing_counter_allocation_bytes()
wake_charge = arc_storage + counter_tail
gross_backing = size_of::<State>() + size_of::<RuntimeFixed>() + 4096
state_backing = gross_backing - wake_charge
```

The whole hub Arc allocation is covered, including dead payload storage retained by a weak reference, two reference counters and alignment padding. The private budget helper uses the same conservative allocation formula for the connection's `Counter` type: the split Reservation keeps that local counter allocation alive after State's lease drops. Its charge therefore remains with the split too. The pre-existing global pool counter is outside this new allocation.

Require `wake_charge + size_of::<Option<WakeAccess>>() <= 4096` before allocation/writer acquisition; reserve gross backing once, split `wake_charge` into Shared, and leave `state_backing` in fixed State. The inline access/accounting representation remains inside the existing startup slack and is not double-counted in the retained hub/counter split. There is no second charge for the same hub bytes and no increase to the 4096 slack, 2048 status, 4096 peer/registration or 2172416 claim allowances. Measure and pin both test and non-test layouts before admission.

This retained split covers the hub allocation and its surviving local budget counter. It does not claim complete physical accounting of the existing `Arc<Shared>` weak-only tail: old `Weak<Shared>` approvals/attempts can retain that allocation after Shared's payload drops, as they do today. The additional inline WakeAccess storage follows that existing Shared-allocation boundary. Broader Shared-tail accounting would be a separate contract change. Root accepts this explicit narrow boundary. The reservation continues to use the original service global pool across restart; it does not create or substitute a pool.

The actor's `Thread` is a clone of the existing actor thread handle; cloning it creates no new allocation. Its inline handle is inside the charged hub layout. The handle and `Weak<Shared>` are dropped with the hub payload when its final strong reference disappears. They do not survive in the weak-only Arc storage. A temporarily paused public wake can extend that payload/handle lifetime, but its strong Shared guard retains the allocation charge throughout. It never retains actor authority or the actor JoinHandle.

## Startup and drainage order

1. Reserve/split fixed backing, create Shared with charged empty WakeAccess, allocate the hub with `Weak<Shared>`, and install the immutable slot plus fixed State/Runtime strong references. All occur before writer acquisition.
2. After spawn, the actor installs its `Thread` before startup acknowledgment. Generation/failure publication before installation remains visible; startup refuses overflow/Abort.
3. Stop/unwind joins children, destroys packets and their wake tokens, then drops Runtime/State strong hub references. Once any overlapping public wake upgrade finishes, Shared retains only the charged weak allocation while old strong public clients exist. RunDrained does not claim that a concurrently upgraded hub payload has already dropped. Failed startup follows the same destruction ordering; pre-writer failures drop locals and their charge.
4. The last strong Shared release drops its weak slot before the charge. Old clients therefore cannot retain an uncharged hub allocation. Old weak-only clients cannot upgrade Shared or wake a successor run.

This deliberately replaces the earlier requirement to clear the slot during run drainage and refund every wake byte while old strong public clients remain. With std safe Rust, an immutable `OnceLock<Weak<_>>` cannot be cleared through `&Shared`; a separately retained charge makes that bounded lifetime explicit. A Mutex would violate the wake rule. Cached arc-swap 1.9.5 allocates thread-local debt nodes on previously unseen caller threads, so it would need another allocation exception and is not proposed.

## Required evidence

Test the exact retained charge after joined stop with old owner/carrier clients alive, full refund after their release, and weak-only client/approval behavior after Shared destruction. Cover writer acquisition refusal, spawn failure and startup panic. Verify all worker/Packet weak tokens are gone before the run's strong hub references are released; old wake attempts cannot change a fresh run's generation. Overflow publication remains an atomic failure/Abort plus direct-unpark path that never recursively calls a wake-enabled failure method, including when invoked under queue/session locks.

The immutable weak slot is only a wake route. Generation never proves join, peer acceptance, returned credit or cleanup. Registry-owned expiry remains unchanged, including bounded losing duplicate preparations after another attempt claims the same work.
