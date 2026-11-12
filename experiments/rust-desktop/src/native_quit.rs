//! Route AppKit/Dock/native termination through the dedicated Chat owner's Quit.
//! Tao 0.37.2 forwards applicationWillTerminate directly to Exit, without an
//! ExitRequested event. Cancel that native route and request our normal async
//! cleanup first; its AppHandle::exit later drives Tao's normal event-loop exit.
use objc2::{
    class, msg_send,
    runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
    sel, MainThreadMarker,
};
use std::{cell::RefCell, ffi::CStr, rc::Rc};

thread_local! {
    static REQUEST: RefCell<Option<Rc<dyn Fn()>>> = const { RefCell::new(None) };
}

// NSApplicationTerminateReply is an NSUInteger. Always cancel the immediate
// AppKit termination, including missing/panicking callbacks: neither proves
// owner shutdown. request_quit itself deduplicates in-flight requests.
extern "C-unwind" fn should_terminate(
    _delegate: *const AnyObject,
    _selector: Sel,
    _application: *const AnyObject,
) -> usize {
    let callback = REQUEST.with(|slot| slot.try_borrow().ok().and_then(|value| value.clone()));
    if let Some(callback) = callback {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| callback()));
    }
    0 // NSTerminateCancel
}

fn subclass(base: &'static AnyClass, name: &CStr) -> Result<&'static AnyClass, String> {
    if let Some(existing) = AnyClass::get(name) {
        if existing.superclass() == Some(base) && existing.instance_size() == base.instance_size() {
            return Ok(existing);
        }
        return Err("The native Quit delegate name is already used by another class".into());
    }
    let mut builder =
        ClassBuilder::new(name, base).ok_or("Could not register the native Quit delegate")?;
    // SAFETY: exact AppKit signature: receiver, selector, NSApplication object,
    // NSUInteger return. No ivars or other overrides are introduced.
    unsafe {
        builder.add_method(
            sel!(applicationShouldTerminate:),
            should_terminate
                as extern "C-unwind" fn(*const AnyObject, Sel, *const AnyObject) -> usize,
        );
    }
    let class = builder.register();
    if class.instance_size() != base.instance_size() {
        return Err("Native Quit delegate unexpectedly changed the instance layout".into());
    }
    Ok(class)
}

unsafe fn install_on(
    delegate: &AnyObject,
    name: &CStr,
    callback: Rc<dyn Fn()>,
) -> Result<(), String> {
    if REQUEST.with(|slot| slot.borrow().is_some()) {
        return Err("The native Quit delegate is already installed".into());
    }
    let base = delegate.class();
    let class = subclass(base, name)?;
    REQUEST.with(|slot| *slot.borrow_mut() = Some(callback));
    // SAFETY: caller serializes this delegate on its owning thread. The new
    // class is a direct subclass with equal layout and only the exact-signature
    // termination override. All Tao delegate state and methods stay inherited.
    let previous = unsafe { AnyObject::set_class(delegate, class) };
    if previous != base {
        uninstall();
        return Err("The native application delegate changed during installation".into());
    }
    Ok(())
}

pub(crate) fn install(callback: impl Fn() + 'static) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Install the native Quit delegate on the main thread".into());
    }
    // SAFETY: AppKit is already initialized by Tauri setup on the main thread.
    // Its existing Tao delegate is retained by the event loop for its lifetime.
    unsafe {
        let application: &AnyObject = msg_send![class!(NSApplication), sharedApplication];
        let delegate: Option<&AnyObject> = msg_send![application, delegate];
        let delegate = delegate.ok_or("The native application has no delegate")?;
        let delegate = objc2::rc::Retained::retain(delegate as *const AnyObject as *mut AnyObject)
            .ok_or("The native application delegate could not be retained")?;
        if delegate.class().name() != c"TaoAppDelegateParent" {
            return Err("Unsupported native application delegate for owned Quit".into());
        }
        install_on(&delegate, c"MilagreRustChatQuitDelegate", Rc::new(callback))?;
        // Refresh AppKit's optional-delegate method observation after changing
        // this same retained object's class. Tao's delegate ownership and state
        // are preserved; these setters execute together on the main thread.
        let _: () = msg_send![application, setDelegate: None::<&AnyObject>];
        let _: () = msg_send![application, setDelegate: Some(&*delegate)];
        Ok(())
    }
}

/// Drop the retained callback at Exit. The registered ivar-free class remains
/// until process exit; changing it back to a superclass would violate set_class.
pub(crate) fn uninstall() {
    REQUEST.with(|slot| {
        slot.borrow_mut().take();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use objc2::{rc::Retained, runtime::NSObject, ClassType};
    use std::cell::Cell;

    extern "C-unwind" fn inherited(_object: *const AnyObject, _selector: Sel) -> usize {
        37
    }

    #[test]
    fn native_selector_cancels_and_routes_quit_while_preserving_the_delegate() {
        let mut builder =
            ClassBuilder::new(c"MilagreRustQuitTestParent", NSObject::class()).unwrap();
        unsafe {
            builder.add_method(
                sel!(inheritedQuitTestValue),
                inherited as extern "C-unwind" fn(*const AnyObject, Sel) -> usize,
            );
        }
        let parent = builder.register();
        let delegate: Retained<AnyObject> = unsafe { msg_send![parent, new] };
        let calls = Rc::new(Cell::new(0));
        let counted = calls.clone();
        unsafe {
            install_on(
                &delegate,
                c"MilagreRustQuitTestChild",
                Rc::new(move || counted.set(counted.get() + 1)),
            )
            .unwrap();
            let reply: usize = msg_send![&delegate, applicationShouldTerminate: None::<&AnyObject>];
            assert_eq!(reply, 0, "native termination never certifies owner cleanup");
            assert_eq!(calls.get(), 1);
            let inherited_value: usize = msg_send![&delegate, inheritedQuitTestValue];
            assert_eq!(inherited_value, 37);
            assert_eq!(delegate.class().superclass(), Some(parent));
            assert_eq!(delegate.class().instance_size(), parent.instance_size());
            let again: usize = msg_send![&delegate, applicationShouldTerminate: None::<&AnyObject>];
            assert_eq!(again, 0);
            assert_eq!(calls.get(), 2);
            assert!(install_on(&delegate, c"UnusedQuitTestClass", Rc::new(|| {})).is_err());
        }
        uninstall();
        assert_eq!(
            Rc::strong_count(&calls),
            1,
            "Exit releases the captured application handle"
        );
        let without_callback: usize =
            unsafe { msg_send![&delegate, applicationShouldTerminate: None::<&AnyObject>] };
        assert_eq!(
            without_callback, 0,
            "missing callback is not permission to exit"
        );
    }

    #[test]
    fn a_panicking_request_never_approves_native_termination() {
        REQUEST.with(|slot| *slot.borrow_mut() = Some(Rc::new(|| panic!("injected Quit failure"))));
        let object = NSObject::new();
        assert_eq!(
            should_terminate(
                &*object as *const NSObject as *const AnyObject,
                sel!(applicationShouldTerminate:),
                std::ptr::null()
            ),
            0
        );
        uninstall();
    }
}
