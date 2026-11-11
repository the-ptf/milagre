use super::*;
use owner::{Data, Locks, Pin, Retained};

pub struct Writer {
    state: Option<Box<State>>,
}
pub(super) struct State {
    pub copy: Copy,
    model: Model,
    locks: Option<Locks>,
    pending: Option<Pending>,
    uncertain: bool,
    closed: bool,
}
struct Pending {
    stamp: Stamp,
    bytes: Arc<[u8]>,
    stage: Option<Stage>,
    renamed: bool,
}
struct Stage {
    name: String,
    file: Option<File>,
}
impl Writer {
    #[cfg(test)]
    pub(super) fn diagnostic(&self) -> Value {
        self.state.as_ref().unwrap().model.observe(Ok(Value::Null))
    }
    pub(super) fn new(state: State) -> Self {
        Self {
            state: Some(Box::new(state)),
        }
    }
    pub fn execute(
        &mut self,
        op: &str,
        args: &[Value],
        now: i64,
        fault: super::super::Fault,
    ) -> Result<Value> {
        let injection = match fault {
            super::super::Fault::None => Fault::None,
            super::super::Fault::Write => Fault::Io(Point::PartialWrite),
            super::super::Fault::Rename => Fault::Io(Point::Rename),
        };
        let result = self.execute_fault(op, args, now, injection);
        match result {
            Err(Error::Io) => match fault {
                super::super::Fault::Write => Err(Error::Model(super::super::Error::Node(
                    "EIO: injected writeFileSync failure".into(),
                ))),
                super::super::Fault::Rename => Err(Error::Model(super::super::Error::Node(
                    "EIO: injected renameSync failure".into(),
                ))),
                _ => Err(Error::Io),
            },
            result => result,
        }
    }
    pub(super) fn execute_fault(
        &mut self,
        op: &str,
        args: &[Value],
        now: i64,
        fault: Fault,
    ) -> Result<Value> {
        self.state
            .as_mut()
            .ok_or(Error::Closed)?
            .execute(op, args, now, fault)
    }
    pub fn observe(&mut self, result: Result<Value>) -> Result<Value> {
        let state = self.state.as_mut().ok_or(Error::Closed)?;
        if state.uncertain || state.closed {
            return Err(Error::Uncertain);
        }
        let observed = caught(|| {
            let root = state.copy.0.data.lock().map_err(|_| Error::Uncertain)?;
            let data = root.as_ref().ok_or(Error::Closed)?;
            data.verify()?;
            let mut observation = state.model.observe(result.map_err(Error::into_model));
            // Observe actual descriptor-read bytes, never substitute the model's cached image.
            observation["file"] = match &data.canonical {
                Some(pin) => Value::String(super::super::jsjson::js_string(
                    std::str::from_utf8(&io::bytes(&pin.file, LIMIT)?)
                        .map_err(|_| Error::Ownership)?,
                )),
                None => Value::Null,
            };
            Ok(observation)
        });
        if observed.is_err() {
            state.uncertain = true;
        }
        observed
    }
    pub fn clear_effects(&mut self) -> Result<()> {
        let state = self.state.as_mut().ok_or(Error::Closed)?;
        if state.closed || state.uncertain {
            return Err(Error::Uncertain);
        }
        state.model.effects.clear();
        Ok(())
    }
    pub fn close(&mut self) -> Result<()> {
        let state = self.state.as_mut().ok_or(Error::Closed)?;
        if caught(|| state.close(Fault::None)).is_err() {
            state.uncertain = true;
            return Err(Error::Uncertain);
        }
        Ok(())
    }
}
impl Drop for Writer {
    fn drop(&mut self) {
        if let Some(mut state) = self.state.take() {
            if !state.closed && (state.uncertain || caught(|| state.close(Fault::None)).is_err()) {
                owner::park(Retained::Writer(state));
            }
        }
    }
}
impl State {
    pub fn open(copy: Copy, now: i64) -> Result<Self> {
        let (locks, model) = {
            let root = copy.0.data.lock().map_err(|_| Error::Uncertain)?;
            let data = root.as_ref().ok_or(Error::Closed)?;
            let locks = data.acquire()?;
            let body = data
                .canonical
                .as_ref()
                .map(|p| String::from_utf8(p.bytes.to_vec()).map_err(|_| Error::Ownership))
                .transpose()?;
            let model = Model::open(body, now)?;
            (locks, model)
        };
        Ok(Self {
            copy,
            model,
            locks: Some(locks),
            pending: None,
            uncertain: false,
            closed: false,
        })
    }
    fn verify_locks(&self, data: &Data) -> Result<()> {
        let locks = self.locks.as_ref().ok_or(Error::Closed)?;
        if !io::same(&locks.directory, data.dir()?)?
            || !io::same(&locks.file, data.lock.as_ref().ok_or(Error::Ownership)?)?
        {
            return Err(Error::Ownership);
        }
        Ok(())
    }
    fn execute(&mut self, op: &str, args: &[Value], now: i64, fault: Fault) -> Result<Value> {
        if self.closed {
            return Err(Error::Closed);
        }
        if self.uncertain {
            return Err(Error::Uncertain);
        }
        let copy = self.copy.clone();
        let mut root = copy.0.data.lock().map_err(|_| Error::Uncertain)?;
        let data = root.as_mut().ok_or(Error::Closed)?;
        if data.verify().and_then(|_| self.verify_locks(data)).is_err() {
            self.uncertain = true;
            return Err(Error::Uncertain);
        }
        if op == "reload" {
            return self
                .model
                .execute(op, args, now, super::super::Fault::None)
                .map_err(Error::from);
        }
        let stamp = self.model.prepare(op, args, now)?;
        let Some(image) = self.model.pending_image(stamp)? else {
            return self.model.install(stamp).map_err(Error::from);
        };
        self.pending = Some(Pending {
            stamp,
            bytes: Arc::from(image.as_bytes()),
            stage: None,
            renamed: false,
        });
        let result = caught(|| {
            self.persist(data, fault)?;
            #[cfg(test)]
            crash::pause(fault, "before-install", None, &self.model)?;
            Ok(())
        });
        if let Err(error) = result {
            if self.pending.as_ref().is_some_and(|p| p.renamed) || matches!(error, Error::Ownership)
            {
                self.uncertain = true;
                return Err(Error::Uncertain);
            }
            if caught(|| self.cleanup_stage(data, fault))
                .and_then(|_| data.verify())
                .is_err()
            {
                self.uncertain = true;
                return Err(Error::Uncertain);
            }
            self.model.discard(stamp)?;
            self.pending = None;
            return Err(error);
        }
        let result = self.model.install(stamp);
        if result.is_err() {
            self.uncertain = true;
            return Err(Error::Uncertain);
        }
        self.pending = None;
        result.map_err(Error::from)
    }
    fn persist(&mut self, data: &mut Data, fault: Fault) -> Result<()> {
        if data.stage_count().map_err(|_| Error::Ownership)? >= 8 {
            return Err(Error::Capacity);
        }
        let pending = self.pending.as_mut().ok_or(Error::Uncertain)?;
        pending.stage = Some(Stage {
            name: format!(".routines-{}.tmp", uuid::Uuid::new_v4()),
            file: None,
        });
        let stage = pending.stage.as_mut().unwrap();
        stage.file = Some(io::open_at(
            data.dir()?,
            &stage.name,
            libc::O_RDWR | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )?);
        let file = stage.file.as_mut().unwrap();
        io::safe(file, false)?;
        fault.hit(Point::Stage)?;
        let split = pending.bytes.len().min(7);
        file.write_all(&pending.bytes[..split])
            .map_err(|_| Error::Io)?;
        fault.hit(Point::PartialWrite)?;
        file.write_all(&pending.bytes[split..])
            .map_err(|_| Error::Io)?;
        #[cfg(test)]
        crash::pause(fault, "written", Some(&stage.name), &self.model)?;
        fault.hit(Point::FileSync)?;
        io::sync(file)?;
        #[cfg(test)]
        crash::pause(fault, "file-synced", None, &self.model)?;
        #[cfg(test)]
        if matches!(fault, Fault::ChangeStageBytes) {
            std::os::unix::fs::FileExt::write_all_at(file, b"!", 0).map_err(|_| Error::Io)?;
        }
        data.verify().map_err(|_| Error::Ownership)?;
        io::pin_at(data.dir()?, &stage.name, file, false).map_err(|_| Error::Ownership)?;
        if io::bytes(file, LIMIT)
            .map_err(|_| Error::Ownership)?
            .as_slice()
            != pending.bytes.as_ref()
        {
            return Err(Error::Ownership);
        }
        fault.hit(Point::BeforeRename)?;
        let from = io::name(&stage.name)?;
        fault.hit(Point::Rename)?;
        #[cfg(test)]
        crash::pause(fault, "before-rename", None, &self.model)?;
        if unsafe {
            libc::renameat(
                data.dir()?.as_raw_fd(),
                from.as_ptr(),
                data.dir()?.as_raw_fd(),
                c"routines.json".as_ptr(),
            )
        } != 0
        {
            return Err(Error::Io);
        }
        pending.renamed = true; // First operation after successful rename. No fallible gap.
        #[cfg(test)]
        crash::pause(fault, "renamed", None, &self.model)?;
        fault.hit(Point::DirectorySync)?;
        io::sync(data.dir()?)?;
        #[cfg(test)]
        crash::pause(fault, "directory-synced", None, &self.model)?;
        fault.hit(Point::FinalVerify)?;
        self.finish_renamed(data)
    }
    fn finish_renamed(&mut self, data: &mut Data) -> Result<()> {
        data.base()?;
        self.verify_locks(data)?;
        let pending = self.pending.as_mut().ok_or(Error::Uncertain)?;
        if !pending.renamed {
            return Err(Error::Uncertain);
        }
        if let Some(stage) = &pending.stage {
            let file = stage.file.as_ref().ok_or(Error::Uncertain)?;
            io::pin_at(data.dir()?, FILE, file, false)?;
            if io::bytes(file, LIMIT)?.as_slice() != pending.bytes.as_ref() {
                return Err(Error::Ownership);
            }
        } else {
            data.verify_canonical()?;
            if data.canonical.as_ref().ok_or(Error::Uncertain)?.bytes != pending.bytes {
                return Err(Error::Ownership);
            }
        }
        // Recheck immutable marker/lock too, without expecting the old canonical inode.
        for (name, pin) in [(MARKER, &data.marker), (LOCK, &data.lock)] {
            let file = pin.as_ref().ok_or(Error::Ownership)?;
            io::pin_at(data.dir()?, name, file, false)?;
            if io::bytes(file, 128)? != data.token {
                return Err(Error::Ownership);
            }
        }
        data.stage_count()?;
        if let Some(mut stage) = pending.stage.take() {
            data.canonical = Some(Pin {
                file: stage.file.take().ok_or(Error::Uncertain)?,
                bytes: pending.bytes.clone(),
            });
        }
        Ok(())
    }
    fn cleanup_stage(&mut self, data: &Data, fault: Fault) -> Result<()> {
        data.base()?;
        self.verify_locks(data)?;
        if let Some(pending) = &mut self.pending {
            if pending.renamed {
                return Err(Error::Uncertain);
            }
            if let Some(stage) = &pending.stage {
                fault.hit(Point::Cleanup)?;
                if let Some(file) = &stage.file {
                    io::unlink_owned(data.dir()?, &stage.name, file)?;
                } else if !io::absent(data.dir()?, &stage.name)? {
                    return Err(Error::Ownership);
                }
                pending.stage = None;
            }
        }
        io::sync(data.dir()?)
    }
    pub fn close(&mut self, fault: Fault) -> Result<()> {
        if self.closed {
            return Ok(());
        }
        let copy = self.copy.clone();
        let mut root = copy.0.data.lock().map_err(|_| Error::Uncertain)?;
        let data = root.as_mut().ok_or(Error::Closed)?;
        if self.pending.as_ref().is_some_and(|p| p.renamed) {
            io::sync(data.dir()?)?;
            self.finish_renamed(data)?;
            // Never install/discard a renamed candidate. Drop it only with the closed State.
        } else {
            self.cleanup_stage(data, fault)?;
            if let Some(pending) = &self.pending {
                self.model.discard(pending.stamp)?;
            }
            self.pending = None;
        }
        data.verify()?;
        self.verify_locks(data)?;
        self.closed = true;
        self.locks = None;
        Ok(())
    }
}
