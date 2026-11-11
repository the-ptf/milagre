use super::*;
use milagre_content_store::SystemRuntime;
use milagre_owner_store::Policy;
fn caller() -> Caller {
    Caller {
        chat_id: "/fixture#1".into(),
        project_id: "/fixture".into(),
        roots: vec![],
        read: true,
        write: true,
        html: true,
        designs: true,
        kits: true,
        design_scope: DesignScope::All,
        bundled_skills: PathBuf::from("/fixture/skills"),
        assert_active: Arc::new(|| Ok(())),
    }
}
fn open(isolation: Isolation, active: ActiveCheck) -> Arc<ContentOwner> {
    ContentOwner::open(
        isolation,
        PathBuf::from("artifacts"),
        PathBuf::from("kits"),
        Arc::new(|_| Ok("/fixture".into())),
        active,
        Arc::new(SystemRuntime),
        None,
    )
    .unwrap()
}
fn create() -> (tempfile::TempDir, Isolation, Arc<ContentOwner>) {
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let owner = open(isolation.clone(), Arc::new(|| Ok(())));
    (temp, isolation, owner)
}
#[test]
fn panic_inside_operation_latches_fault_without_resuming_mutations() {
    let (_temp, isolation, owner) = create();
    let caller = caller();
    let retained = owner.session(caller.clone()).unwrap();
    let failure:Result<Value>=owner.with_stores(&caller,|store,_|{
  store.show(&json!({"chatId":caller.chat_id,"title":"Committed before panic","html":"<p>Saved</p>"}),&[])?;
  panic!("fixture-private-panic-payload");
 });
    let failure = failure.unwrap_err();
    assert_eq!(failure.code, "CONTENT_OWNER_PANIC");
    assert!(!failure.message.contains("fixture-private"));
    assert!(!owner.storage_fault().unwrap().contains("fixture-private"));
    assert!(
        !owner.stores.is_poisoned(),
        "the storage guard remains outside catch_unwind"
    );
    assert!(owner
        .with_stores(&caller, |_, _| -> Result<()> {
            panic!("must never execute after fault")
        })
        .is_err());
    assert!(owner.session(caller.clone()).is_err());
    assert!(retained.list().is_err());
    assert!(owner
        .renderer(&caller, "artifact:list", &json!({"chatId":caller.chat_id}))
        .is_err());
    owner.shutdown();
    owner.shutdown();
    assert!(owner.lock_state(&owner.stores).is_none());
    let replacement = open(isolation, Arc::new(|| Ok(())));
    let saved = replacement
        .renderer(&caller, "artifact:list", &json!({"chatId":caller.chat_id}))
        .unwrap();
    assert_eq!(saved[0]["title"], "Committed before panic");
    assert!(retained.list().is_err());
}
#[test]
fn poisoned_lanes_fault_and_shutdown_releases_both_stores_with_retained_sessions() {
    for name in ["stores", "fault", "wakes"] {
        for shutdown_first in [false, true] {
            let (_temp, isolation, owner) = create();
            let retained = owner.session(caller()).unwrap();
            let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match name {
                "stores" => {
                    let _guard = owner.stores.lock().unwrap();
                    panic!("fixture lane poison");
                }
                "fault" => {
                    let _guard = owner.fault.lock().unwrap();
                    panic!("fixture fault poison");
                }
                _ => {
                    let _guard = owner.wakes.lock().unwrap();
                    panic!("fixture wake poison");
                }
            }));
            assert!(poisoned.is_err());
            if !shutdown_first {
                assert!(retained.list().is_err());
                assert!(owner.session(caller()).is_err());
            }
            owner.shutdown();
            owner.shutdown();
            assert!(retained.list().is_err());
            assert!(owner.storage_fault().is_some());
            let replacement = open(isolation, Arc::new(|| Ok(())));
            assert!(replacement.session(caller()).is_ok());
            assert!(owner.session(caller()).is_err());
        }
    }
}
#[test]
fn panicking_authority_callbacks_are_isolated_and_permanently_fault_the_owner() {
    let (_temp, _isolation, owner) = create();
    let mut caller = caller();
    caller.assert_active = Arc::new(|| panic!("fixture grant panic"));
    assert!(owner.session(caller).is_err());
    assert!(owner.storage_fault().is_some());
    owner.shutdown();
    let temp = tempfile::tempdir().unwrap();
    let isolation = Isolation::create(temp.path(), &Policy::default()).unwrap();
    let panic_now = Arc::new(AtomicBool::new(false));
    let owner = open(
        isolation,
        Arc::new({
            let flag = panic_now.clone();
            move || {
                assert!(!flag.load(Ordering::Acquire), "fixture owner panic");
                Ok(())
            }
        }),
    );
    let session = owner.session(super::panic_tests::caller()).unwrap();
    panic_now.store(true, Ordering::Release);
    assert!(session.list().is_err());
    panic_now.store(false, Ordering::Release);
    assert!(session.list().is_err());
    owner.shutdown();
}
