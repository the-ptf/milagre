//! Spike evidence tool (macOS): write the app's own window to a PNG.
//!
//! `screencapture -l <id>` needs the Screen Recording permission for whatever launched it. A process
//! may capture its own windows without that permission, so the app captures itself instead. Run with
//! `MILAGRE_GPUI_SNAPSHOT=/tmp/shell.png`; `main.rs` saves the window once it has drawn and quits.
//!
//! `CGWindowListCreateImage` is obsoleted in the macOS 15+ SDK but still exported at runtime, so it is
//! looked up with `dlsym` instead of linked. Everything else is plain CoreFoundation and ImageIO.

use std::ffi::{c_char, c_void};
use std::os::unix::ffi::OsStrExt;
use std::path::Path;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};

type CFTypeRef = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

/// `CGRectNull`: with `kCGWindowListOptionIncludingWindow`, capture the window's own bounds.
const CG_RECT_NULL: CGRect = CGRect { origin: CGPoint { x: f64::INFINITY, y: f64::INFINITY }, size: CGSize { width: 0.0, height: 0.0 } };
const K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW: u32 = 1 << 3;
const K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING: u32 = 1 << 0;
const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
/// `RTLD_DEFAULT` on macOS.
const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;

type CreateImageFn = unsafe extern "C" fn(CGRect, u32, u32, u32) -> CFTypeRef;

#[link(name = "objc")]
unsafe extern "C" {
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn objc_msgSend();
}

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithCString(alloc: CFTypeRef, c_str: *const c_char, encoding: u32) -> CFTypeRef;
    fn CFURLCreateFromFileSystemRepresentation(alloc: CFTypeRef, buffer: *const u8, len: isize, is_directory: u8) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
}

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGImageGetWidth(image: CFTypeRef) -> usize;
    fn CGImageGetHeight(image: CFTypeRef) -> usize;
}

#[link(name = "ImageIO", kind = "framework")]
unsafe extern "C" {
    fn CGImageDestinationCreateWithURL(url: CFTypeRef, kind: CFTypeRef, count: usize, options: CFTypeRef) -> CFTypeRef;
    fn CGImageDestinationAddImage(dest: CFTypeRef, image: CFTypeRef, properties: CFTypeRef);
    fn CGImageDestinationFinalize(dest: CFTypeRef) -> bool;
}

/// Saves `window` as a PNG at `path` and returns the image size in device pixels.
pub fn save_window_png(window: &gpui::Window, path: &Path) -> Result<(usize, usize), String> {
    let handle = HasWindowHandle::window_handle(window).map_err(|e| format!("no native window handle: {e}"))?;
    let RawWindowHandle::AppKit(appkit) = handle.as_raw() else {
        return Err("not an AppKit window".into());
    };
    // SAFETY: `ns_view` is the live NSView GPUI renders into; `window` and `windowNumber` are plain
    // Objective-C getters called on the main thread. Every CF object created here is released once.
    unsafe {
        let send_id: unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void = std::mem::transmute(objc_msgSend as *const ());
        let send_int: unsafe extern "C" fn(*mut c_void, *const c_void) -> isize = std::mem::transmute(objc_msgSend as *const ());
        let ns_window = send_id(appkit.ns_view.as_ptr(), sel_registerName(c"window".as_ptr()));
        if ns_window.is_null() {
            return Err("the view has no NSWindow".into());
        }
        let window_number = send_int(ns_window, sel_registerName(c"windowNumber".as_ptr()));

        let symbol = dlsym(RTLD_DEFAULT, c"CGWindowListCreateImage".as_ptr());
        if symbol.is_null() {
            return Err("CGWindowListCreateImage is not available on this macOS".into());
        }
        let create_image: CreateImageFn = std::mem::transmute(symbol);
        let image = create_image(
            CG_RECT_NULL,
            K_CG_WINDOW_LIST_OPTION_INCLUDING_WINDOW,
            window_number as u32,
            K_CG_WINDOW_IMAGE_BOUNDS_IGNORE_FRAMING,
        );
        if image.is_null() {
            return Err("CGWindowListCreateImage returned no image".into());
        }
        let size = (CGImageGetWidth(image), CGImageGetHeight(image));

        let bytes = path.as_os_str().as_bytes();
        let url = CFURLCreateFromFileSystemRepresentation(std::ptr::null(), bytes.as_ptr(), bytes.len() as isize, 0);
        let kind = CFStringCreateWithCString(std::ptr::null(), c"public.png".as_ptr(), K_CF_STRING_ENCODING_UTF8);
        let dest = CGImageDestinationCreateWithURL(url, kind, 1, std::ptr::null());
        let saved = !dest.is_null() && {
            CGImageDestinationAddImage(dest, image, std::ptr::null());
            CGImageDestinationFinalize(dest)
        };
        if !dest.is_null() {
            CFRelease(dest);
        }
        CFRelease(kind);
        CFRelease(url);
        CFRelease(image);
        if saved { Ok(size) } else { Err(format!("could not write {}", path.display())) }
    }
}
