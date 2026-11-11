use super::*;
use std::{
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
use uuid::Uuid;

struct Slot {
    id: Option<u64>,
    retained: Option<Retained>,
}
static SLOT: Mutex<Slot> = Mutex::new(Slot {
    id: None,
    retained: None,
});
static NEXT: AtomicU64 = AtomicU64::new(0);
pub(super) enum Retained {
    Copy(Box<Data>),
    Writer(Box<writer::State>),
}
impl Retained {
    fn id(&self) -> u64 {
        match self {
            Self::Copy(d) => d.id,
            Self::Writer(w) => w.copy.0.id,
        }
    }
}
pub(super) fn park(value: Retained) {
    let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    if slot.id == Some(value.id()) && slot.retained.is_none() {
        slot.retained = Some(value);
    } else {
        // An internal invariant failure must retain descriptors, never drop authority.
        // No further reservation is possible while the existing slot remains occupied.
        if slot.id.is_none() {
            slot.id = Some(value.id());
        }
        std::mem::forget(value);
    }
}
#[cfg(test)]
pub(super) fn retained_blocks_writers() -> (bool, Option<bool>) {
    let slot = SLOT.lock().unwrap();
    let Retained::Copy(data) = slot.retained.as_ref().unwrap() else {
        panic!("expected retained copy");
    };
    let directory = io::open_at(
        &data.parent,
        &data.name,
        libc::O_RDONLY | libc::O_DIRECTORY,
        0,
    )
    .unwrap();
    let directory_busy = matches!(io::lock(&directory), Err(Error::Busy));
    let file_busy = data.lock.as_ref().map(|_| {
        let file = io::open_at(data.dir().unwrap(), LOCK, libc::O_RDWR, 0).unwrap();
        matches!(io::lock(&file), Err(Error::Busy))
    });
    (directory_busy, file_busy)
}
fn release(id: u64) {
    let mut slot = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    if slot.id == Some(id) && slot.retained.is_none() {
        slot.id = None;
    }
}
struct Reservation(u64);
impl Reservation {
    fn acquire() -> Result<Self> {
        let mut slot = SLOT.lock().map_err(|_| Error::Uncertain)?;
        if slot.id.is_some() {
            return Err(Error::Busy);
        }
        let id = NEXT
            .try_update(Ordering::Relaxed, Ordering::Relaxed, |n| n.checked_add(1))
            .map_err(|_| Error::Busy)?
            + 1;
        slot.id = Some(id);
        Ok(Self(id))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        if self.0 != 0 {
            release(self.0);
        }
    }
}

#[derive(Clone)]
pub struct Copy(pub(super) Arc<Root>);
pub(super) struct Root {
    pub id: u64,
    pub data: Mutex<Option<Box<Data>>>,
}
impl Drop for Root {
    fn drop(&mut self) {
        if let Some(data) = self
            .data
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            park(Retained::Copy(data));
        }
    }
}
pub(super) struct Pin {
    pub file: File,
    pub bytes: Arc<[u8]>,
}
pub(super) struct Data {
    pub id: u64,
    pub parent: File,
    pub name: String,
    pub root: Option<File>,
    created: bool,
    admitted: bool,
    pub marker: Option<File>,
    pub lock: Option<File>,
    pub canonical: Option<Pin>,
    pub token: Vec<u8>,
    // Fixed entry names are known before creation. A missing FD is clean only when
    // that entry is absent; cleanup never adopts or deletes an unpinned entry.
    teardown: Option<CleanupLocks>,
}
pub(super) struct Locks {
    pub directory: File,
    pub file: File,
}
struct CleanupLocks {
    directory: File,
    file: Option<File>,
}

impl Copy {
    pub fn create(seed: Option<String>, now: i64) -> Result<Self> {
        Self::create_fault(seed, now, Fault::None)
    }
    pub(super) fn create_fault(seed: Option<String>, now: i64, fault: Fault) -> Result<Self> {
        // Domain validation has no disk side effects; keep supplied bytes unchanged.
        Model::open(seed.clone(), now)?;
        let mut reservation = Reservation::acquire()?;
        let base = std::fs::canonicalize("/tmp").map_err(|_| Error::Io)?;
        if base != Path::new("/tmp") && base != Path::new("/private/tmp") {
            return Err(Error::Ownership);
        }
        let path = std::ffi::CString::new(base.as_os_str().as_encoded_bytes())
            .map_err(|_| Error::Ownership)?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(Error::Io);
        }
        let mut data = Box::new(Data {
            id: reservation.0,
            parent: unsafe { File::from_raw_fd(fd) },
            name: format!("milagre-routine-copy-{}", Uuid::new_v4()),
            root: None,
            created: false,
            admitted: false,
            marker: None,
            lock: None,
            canonical: None,
            token: Uuid::new_v4().to_string().into_bytes(),
            teardown: None,
        });
        // Data owns the child name, fixed entry slots and reservation before mkdirat.
        reservation.0 = 0;
        let result = caught(|| data.populate(seed.as_deref(), fault));
        if let Err(error) = result {
            if caught(|| data.cleanup_fault(fault)).is_ok() {
                release(data.id);
            } else {
                park(Retained::Copy(data));
                return Err(Error::Uncertain);
            }
            return Err(error);
        }
        Ok(Self(Arc::new(Root {
            id: data.id,
            data: Mutex::new(Some(data)),
        })))
    }
    pub fn open(&self, now: i64) -> Result<Writer> {
        writer::State::open(self.clone(), now).map(Writer::new)
    }
    pub fn destroy(self) -> Result<()> {
        let root = Arc::try_unwrap(self.0).map_err(|_| Error::Busy)?;
        let mut root = root;
        let mut data = root
            .data
            .get_mut()
            .map_err(|_| Error::Uncertain)?
            .take()
            .ok_or(Error::Closed)?;
        match caught(|| data.cleanup()) {
            Ok(()) => {
                release(data.id);
                Ok(())
            }
            Err(_) => {
                park(Retained::Copy(data));
                Err(Error::Uncertain)
            }
        }
    }
    // Exact retained ownership only. No path/name/"cleanup succeeded" input is accepted.
    pub fn cleanup_retained() -> Result<()> {
        let retained = {
            let mut slot = SLOT.lock().map_err(|_| Error::Uncertain)?;
            slot.retained.take().ok_or(Error::Busy)?
        };
        match retained {
            Retained::Copy(mut data) => {
                if caught(|| data.cleanup()).is_ok() {
                    release(data.id);
                    Ok(())
                } else {
                    park(Retained::Copy(data));
                    Err(Error::Uncertain)
                }
            }
            Retained::Writer(mut state) => {
                if caught(|| state.close(Fault::None)).is_err() {
                    park(Retained::Writer(state));
                    return Err(Error::Uncertain);
                }
                let copy = state.copy.clone();
                drop(state);
                copy.destroy()
            }
        }
    }
}
impl Data {
    pub fn dir(&self) -> Result<&File> {
        self.root.as_ref().ok_or(Error::Ownership)
    }
    fn populate(&mut self, seed: Option<&str>, fault: Fault) -> Result<()> {
        let name = io::name(&self.name)?;
        if unsafe { libc::mkdirat(self.parent.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
            return Err(Error::Io);
        }
        self.created = true;
        self.root = Some(io::open_at(
            &self.parent,
            &self.name,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?);
        io::safe(self.dir()?, true)?;
        fault.hit(Point::Child)?;
        self.marker = Some(io::open_at(
            self.dir()?,
            MARKER,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?);
        let marker = self.marker.as_mut().unwrap();
        marker.write_all(&self.token).map_err(|_| Error::Io)?;
        io::sync(marker)?;
        fault.hit(Point::Marker)?;
        self.lock = Some(io::open_at(
            self.dir()?,
            LOCK,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?);
        let lock = self.lock.as_mut().unwrap();
        lock.write_all(&self.token).map_err(|_| Error::Io)?;
        io::sync(lock)?;
        fault.hit(Point::Lock)?;
        if let Some(seed) = seed {
            let bytes = Arc::from(seed.as_bytes());
            let file = io::open_at(
                self.dir()?,
                FILE,
                libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
                0o600,
            )?;
            self.canonical = Some(Pin { file, bytes });
            let pin = self.canonical.as_mut().unwrap();
            pin.file.write_all(&pin.bytes).map_err(|_| Error::Io)?;
            io::sync(&pin.file)?;
        }
        fault.hit(Point::Seed)?;
        io::sync(self.dir()?)?;
        io::sync(&self.parent)?;
        self.verify()?;
        self.admitted = true;
        Ok(())
    }
    pub fn base(&self) -> Result<()> {
        let base = std::fs::canonicalize("/tmp").map_err(|_| Error::Ownership)?;
        if base != Path::new("/tmp") && base != Path::new("/private/tmp") {
            return Err(Error::Ownership);
        }
        let path = std::ffi::CString::new(base.as_os_str().as_encoded_bytes())
            .map_err(|_| Error::Ownership)?;
        let fd = unsafe {
            libc::open(
                path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(Error::Ownership);
        }
        let parent = unsafe { File::from_raw_fd(fd) };
        if !io::same(&parent, &self.parent)? {
            return Err(Error::Ownership);
        }
        io::pin_at(&self.parent, &self.name, self.dir()?, true)
    }
    pub fn verify(&self) -> Result<()> {
        self.base()?;
        let dir = self.dir()?;
        for (name, file) in [(MARKER, self.marker.as_ref()), (LOCK, self.lock.as_ref())] {
            let file = file.ok_or(Error::Ownership)?;
            io::pin_at(dir, name, file, false)?;
            if io::bytes(file, 128)? != self.token {
                return Err(Error::Ownership);
            }
        }
        self.verify_canonical()?;
        self.stage_count()?;
        Ok(())
    }
    pub fn verify_canonical(&self) -> Result<()> {
        match &self.canonical {
            Some(pin) => {
                io::pin_at(self.dir()?, FILE, &pin.file, false)?;
                if io::bytes(&pin.file, LIMIT)?.as_slice() != pin.bytes.as_ref() {
                    return Err(Error::Ownership);
                }
            }
            None if !io::absent(self.dir()?, FILE)? => return Err(Error::Ownership),
            None => {}
        }
        Ok(())
    }
    pub fn stage_count(&self) -> Result<usize> {
        let mut count = 0;
        for name in io::entries(self.dir()?)? {
            if [MARKER, LOCK, FILE].contains(&name.as_str()) {
                continue;
            }
            let token = name
                .strip_prefix(".routines-")
                .and_then(|s| s.strip_suffix(".tmp"))
                .ok_or(Error::Ownership)?;
            let parsed = Uuid::parse_str(token).map_err(|_| Error::Ownership)?;
            if parsed.hyphenated().to_string() != token {
                return Err(Error::Ownership);
            }
            let file = io::open_at(self.dir()?, &name, libc::O_RDONLY, 0)?;
            io::safe(&file, false)?;
            if file.metadata().map_err(|_| Error::Io)?.len() > LIMIT as u64 {
                return Err(Error::Ownership);
            }
            count += 1;
            if count > 8 {
                return Err(Error::Ownership);
            }
        }
        Ok(count)
    }
    pub fn acquire(&self) -> Result<Locks> {
        self.verify()?;
        let directory = io::open_at(
            &self.parent,
            &self.name,
            libc::O_RDONLY | libc::O_DIRECTORY,
            0,
        )?;
        io::lock(&directory)?;
        if !io::same(&directory, self.dir()?)? {
            return Err(Error::Ownership);
        }
        let file = io::open_at(self.dir()?, LOCK, libc::O_RDWR, 0)?;
        io::lock(&file)?;
        if !io::same(&file, self.lock.as_ref().ok_or(Error::Ownership)?)? {
            return Err(Error::Ownership);
        }
        self.verify()?;
        Ok(Locks { directory, file })
    }
    fn cleanup(&mut self) -> Result<()> {
        self.cleanup_fault(Fault::None)
    }
    fn cleanup_fault(&mut self, fault: Fault) -> Result<()> {
        if !self.created {
            return if self.root.is_some() {
                io::sync(&self.parent)
            } else {
                Ok(())
            };
        }
        self.base()?;
        if self.admitted {
            self.verify_canonical()?;
            for file in [&self.marker, &self.lock].into_iter().flatten() {
                if io::bytes(file, 128)? != self.token {
                    return Err(Error::Ownership);
                }
            }
        }
        // Teardown also excludes independent writers; keep both acquired FDs to the end.
        if self.teardown.is_none() {
            let directory = io::open_at(
                &self.parent,
                &self.name,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
            )?;
            self.teardown = Some(CleanupLocks {
                directory,
                file: None,
            });
        }
        io::lock(&self.teardown.as_ref().unwrap().directory)?;
        if let Some(held) = &self.lock {
            io::pin_at(self.dir()?, LOCK, held, false)?;
            if self.teardown.as_ref().unwrap().file.is_none() {
                let file = io::open_at(self.dir()?, LOCK, libc::O_RDWR, 0)?;
                self.teardown.as_mut().unwrap().file = Some(file);
            }
            io::lock(self.teardown.as_ref().unwrap().file.as_ref().unwrap())?;
        }
        fault.hit(Point::Cleanup)?;
        for (name, file) in [
            (MARKER, self.marker.as_ref()),
            (LOCK, self.lock.as_ref()),
            (FILE, self.canonical.as_ref().map(|p| &p.file)),
        ] {
            if let Some(file) = file {
                io::pin_at(self.dir()?, name, file, false)?;
            } else if !io::absent(self.dir()?, name)? {
                return Err(Error::Ownership);
            }
        }
        // Unknown/crash staging entries are never swept. Preserve the whole copy on failure.
        if io::entries(self.dir()?)?
            .iter()
            .any(|n| ![MARKER, LOCK, FILE].contains(&n.as_str()))
        {
            return Err(Error::Ownership);
        }
        if let Some(pin) = &self.canonical {
            io::unlink_owned(self.dir()?, FILE, &pin.file)?;
            self.canonical = None;
        }
        if let Some(file) = &self.marker {
            io::unlink_owned(self.dir()?, MARKER, file)?;
            self.marker = None;
        }
        if let Some(file) = &self.lock {
            io::unlink_owned(self.dir()?, LOCK, file)?;
            self.lock = None;
        }
        io::sync(self.dir()?)?;
        self.base()?;
        let name = io::name(&self.name)?;
        if unsafe { libc::unlinkat(self.parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) }
            != 0
        {
            return Err(Error::Io);
        }
        self.created = false;
        io::sync(&self.parent)?;
        Ok(())
    }
}
