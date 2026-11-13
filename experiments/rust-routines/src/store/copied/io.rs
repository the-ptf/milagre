use super::*;
use std::{
    ffi::{CStr, CString},
    os::unix::fs::FileExt,
};

pub(super) fn name(name: &str) -> Result<CString> {
    if name.contains('/') || name == "." || name == ".." {
        return Err(Error::Ownership);
    }
    CString::new(name).map_err(|_| Error::Ownership)
}
pub(super) fn open_at(dir: &File, part: &str, flags: i32, mode: u32) -> Result<File> {
    let name = name(part)?;
    // SAFETY: fixed/generated basename and a held directory; transfer the returned FD once.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(Error::Io);
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
pub(super) fn absent(dir: &File, part: &str) -> Result<bool> {
    let part = name(part)?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: stat is an output buffer, basename is live and no symlink is followed.
    let result = unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            part.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    };
    if result == 0 {
        return Ok(false);
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
        Ok(true)
    } else {
        Err(Error::Io)
    }
}
pub(super) fn same(a: &File, b: &File) -> Result<bool> {
    let a = a.metadata().map_err(|_| Error::Io)?;
    let b = b.metadata().map_err(|_| Error::Io)?;
    Ok(a.dev() == b.dev() && a.ino() == b.ino())
}
pub(super) fn safe(file: &File, directory: bool) -> Result<()> {
    let m = file.metadata().map_err(|_| Error::Io)?;
    if m.uid() != unsafe { libc::geteuid() }
        || m.mode() & 0o7777 != if directory { 0o700 } else { 0o600 }
        || if directory {
            !m.is_dir()
        } else {
            !m.is_file() || m.nlink() != 1
        }
    {
        return Err(Error::Ownership);
    }
    Ok(())
}
pub(super) fn pin_at(dir: &File, part: &str, held: &File, directory: bool) -> Result<()> {
    let current = open_at(
        dir,
        part,
        libc::O_RDONLY | if directory { libc::O_DIRECTORY } else { 0 },
        0,
    )?;
    safe(&current, directory)?;
    safe(held, directory)?;
    if !same(&current, held)? {
        return Err(Error::Ownership);
    }
    Ok(())
}
pub(super) fn bytes(file: &File, limit: usize) -> Result<Vec<u8>> {
    safe(file, false)?;
    let before = file.metadata().map_err(|_| Error::Io)?;
    if before.len() > limit as u64 {
        return Err(Error::Ownership);
    }
    let mut out = Vec::with_capacity((before.len() as usize).min(limit));
    let mut block = [0; 8192];
    loop {
        let n = file
            .read_at(&mut block, out.len() as u64)
            .map_err(|_| Error::Io)?;
        if n == 0 {
            break;
        }
        if out.len() + n > limit {
            return Err(Error::Ownership);
        }
        out.extend_from_slice(&block[..n]);
    }
    let after = file.metadata().map_err(|_| Error::Io)?;
    safe(file, false)?;
    if before.len() != after.len()
        || before.mtime() != after.mtime()
        || before.mtime_nsec() != after.mtime_nsec()
    {
        return Err(Error::Ownership);
    }
    Ok(out)
}
pub(super) fn unlink_owned(dir: &File, part: &str, file: &File) -> Result<()> {
    pin_at(dir, part, file, false)?;
    let part = name(part)?;
    if unsafe { libc::unlinkat(dir.as_raw_fd(), part.as_ptr(), 0) } != 0 {
        return Err(Error::Io);
    }
    Ok(())
}
pub(super) fn sync(dir: &File) -> Result<()> {
    dir.sync_all().map_err(|_| Error::Io)
}
pub(super) fn lock(file: &File) -> Result<()> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(Error::Busy);
    }
    Ok(())
}
pub(super) fn entries(dir: &File) -> Result<Vec<String>> {
    // A fresh file description avoids sharing directory offsets with another scan/lock.
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            c".".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 {
        return Err(Error::Io);
    }
    let pointer = unsafe { libc::fdopendir(fd) };
    if pointer.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(Error::Io);
    }
    struct Directory(*mut libc::DIR);
    impl Drop for Directory {
        fn drop(&mut self) {
            unsafe {
                libc::closedir(self.0);
            }
        }
    }
    let owned = Directory(pointer);
    let mut names = Vec::new();
    loop {
        #[cfg(target_vendor = "apple")]
        unsafe {
            *libc::__error() = 0;
        }
        #[cfg(not(target_vendor = "apple"))]
        unsafe {
            *libc::__errno_location() = 0;
        }
        // SAFETY: DIR is owned/live; readdir's name is copied before the next call.
        let entry = unsafe { libc::readdir(owned.0) };
        if entry.is_null() {
            if std::io::Error::last_os_error().raw_os_error() != Some(0) {
                return Err(Error::Io);
            }
            break;
        }
        let text = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }
            .to_str()
            .map_err(|_| Error::Ownership)?;
        if text == "." || text == ".." {
            continue;
        }
        if names.len() >= 11 {
            return Err(Error::Ownership);
        }
        names.push(text.to_owned());
    }
    Ok(names)
}
