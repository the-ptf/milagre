//! Frame-aware WebKit policy. Wry 0.57 exposes URL-only navigation callbacks for all
//! frames, which cannot distinguish an Artifact iframe from a privileged main page.
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObject, ProtocolObject, Sel},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_foundation::NSObjectProtocol;
use objc2_web_kit::{
    WKNavigationAction, WKNavigationActionPolicy, WKNavigationDelegate, WKWebView,
};
use std::cell::RefCell;

struct Ivars {
    original: Retained<ProtocolObject<dyn WKNavigationDelegate>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct FrameNavigationDelegate;

    unsafe impl NSObjectProtocol for FrameNavigationDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds_to(&self, selector: Sel) -> bool {
            unsafe {
                let own: bool = msg_send![super(self), respondsToSelector: selector];
                own || self.ivars().original.respondsToSelector(selector)
            }
        }
    }

    impl FrameNavigationDelegate {
        // Preserve Wry's page-load, download and process-termination callbacks.
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, _selector: Sel) -> *mut AnyObject {
            Retained::as_ptr(&self.ivars().original).cast_mut().cast()
        }
    }

    unsafe impl WKNavigationDelegate for FrameNavigationDelegate {
        #[unsafe(method(webView:decidePolicyForNavigationAction:decisionHandler:))]
        fn navigation_policy(
            &self,
            webview: &WKWebView,
            action: &WKNavigationAction,
            handler: &block2::DynBlock<dyn Fn(WKNavigationActionPolicy)>,
        ) {
            unsafe {
                let Some(frame) = action.targetFrame() else {
                    // No target means a new window. Never give generated content another webview.
                    handler.call((WKNavigationActionPolicy::Cancel,)); return;
                };
                let Some(url) = action.request().URL().and_then(|url| url.absoluteString()) else {
                    handler.call((WKNavigationActionPolicy::Cancel,)); return;
                };
                let main = frame.isMainFrame();
                if !allowed(main, &url.to_string()) {
                    handler.call((WKNavigationActionPolicy::Cancel,)); return;
                }
                if main {
                    // Wry owns pending initial scripts and normal main-frame navigation handling.
                    self.ivars().original.webView_decidePolicyForNavigationAction_decisionHandler(webview, action, handler);
                } else {
                    // The original URL-only callback rejects these by design. They are safe only
                    // in the renderer's opaque sandboxed frames, without the main-frame invoke key.
                    handler.call((WKNavigationActionPolicy::Allow,));
                }
            }
        }
    }
);

fn allowed(main: bool, address: &str) -> bool {
    let Ok(url) = tauri::Url::parse(address) else {
        return false;
    };
    if url.scheme() == "tauri" && url.host_str() == Some("localhost") {
        return true;
    }
    if main {
        return false;
    }
    match url.scheme() {
        "about" => matches!(url.path(), "blank" | "srcdoc"),
        "milagre-artifact" => url.host_str() == Some("preview"),
        "blob" => address.starts_with("blob:tauri://localhost/"),
        _ => false,
    }
}

thread_local! {
    // WKWebView.navigationDelegate is weak. Keep the proxy on the UI thread for the app lifetime.
    static DELEGATES: RefCell<Vec<Retained<FrameNavigationDelegate>>> = const { RefCell::new(Vec::new()) };
}

/// Keep the existing tauri-only `.on_navigation` callback. This wrapper bypasses it
/// solely for allowed child frames and forwards all main-frame decisions to Wry.
pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    window
        .with_webview(|view| unsafe {
            let Some(mtm) = MainThreadMarker::new() else {
                return;
            };
            let webview: &WKWebView = &*view.inner().cast();
            let Some(original) = webview.navigationDelegate() else {
                return;
            };
            let allocated = mtm
                .alloc::<FrameNavigationDelegate>()
                .set_ivars(Ivars { original });
            let delegate: Retained<FrameNavigationDelegate> = msg_send![super(allocated), init];
            webview.setNavigationDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            DELEGATES.with(|values| values.borrow_mut().push(delegate));
        })
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::allowed;
    #[test]
    fn main_frame_is_always_the_bundled_application() {
        assert!(allowed(true, "tauri://localhost/index.html"));
        for address in [
            "milagre-artifact://preview/123",
            "about:srcdoc",
            "https://example.com",
            "file:///tmp/a.html",
            "javascript:alert(1)",
            "tauri://evil/index.html",
        ] {
            assert!(!allowed(true, address), "{address}");
        }
    }
    #[test]
    fn only_required_child_document_sources_are_allowed() {
        assert!(allowed(false, "about:srcdoc"));
        assert!(allowed(false, "about:blank"));
        assert!(allowed(false, "milagre-artifact://preview/abc"));
        assert!(allowed(false, "blob:tauri://localhost/abc"));
        for address in [
            "https://example.com",
            "file:///tmp/a.html",
            "milagre-artifact://evil/abc",
            "blob:https://example.com/abc",
            "about:config",
        ] {
            assert!(!allowed(false, address), "{address}");
        }
    }
}
