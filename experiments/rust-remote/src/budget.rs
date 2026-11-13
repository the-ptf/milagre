//! Shared retained-memory reservations. Build ONE GlobalBudget per service and one
//! ConnectionBudget per connection; clone those handles into every reader/writer.
use crate::{Error, Result};
use std::sync::{Arc, Mutex, OnceLock};
struct Counter {
    limit: usize,
    used: Mutex<usize>,
}
/// The fixed wake split retains its connection counter after the main lease drops.
pub(crate) fn fixed_backing_counter_allocation_bytes() -> Option<usize> {
    std::mem::size_of::<Counter>()
        .checked_add(2usize.checked_mul(std::mem::size_of::<usize>())?)?
        .checked_add(std::mem::align_of::<Counter>().checked_sub(1)?)
}
impl Counter {
    fn reserve(&self, n: usize) -> Result<()> {
        let mut used = self.used.lock().map_err(|_| Error::Budget)?;
        if n > self.limit - *used {
            return Err(Error::Budget);
        }
        *used += n;
        Ok(())
    }
    fn release(&self, n: usize) {
        let mut used = self.used.lock().unwrap_or_else(|e| e.into_inner());
        *used -= n;
    }
    fn used(&self) -> usize {
        *self.used.lock().unwrap_or_else(|e| e.into_inner())
    }
}
#[derive(Clone)]
pub struct GlobalBudget(Arc<Counter>);
#[derive(Clone)]
pub struct ConnectionBudget {
    global: GlobalBudget,
    local: Arc<Counter>,
    device: Option<Arc<Counter>>,
}
#[derive(Clone)]
pub struct DeviceBudget {
    global: GlobalBudget,
    counter: Arc<Counter>,
}
/// A reservation lives as long as its buffer, including after a reader returns it.
/// No Clone: cloning a handle must not duplicate uncharged payload storage.
pub struct Reservation {
    budget: ConnectionBudget,
    bytes: usize,
}
impl GlobalBudget {
    pub fn new(limit: usize) -> Result<Self> {
        if limit == 0 {
            return Err(Error::Budget);
        }
        Ok(Self(Arc::new(Counter {
            limit,
            used: Mutex::new(0),
        })))
    }
    pub fn connection(&self, limit: usize) -> Result<ConnectionBudget> {
        if limit == 0 || limit > self.0.limit {
            return Err(Error::Budget);
        }
        Ok(ConnectionBudget {
            global: self.clone(),
            device: None,
            local: Arc::new(Counter {
                limit,
                used: Mutex::new(0),
            }),
        })
    }
    pub fn device(&self, limit: usize) -> Result<DeviceBudget> {
        if limit == 0 || limit > self.0.limit {
            return Err(Error::Budget);
        }
        Ok(DeviceBudget {
            global: self.clone(),
            counter: Arc::new(Counter {
                limit,
                used: Mutex::new(0),
            }),
        })
    }
    pub fn used(&self) -> usize {
        self.0.used()
    }
}
impl DeviceBudget {
    pub fn connection(&self, limit: usize) -> Result<ConnectionBudget> {
        if limit == 0 || limit > self.counter.limit {
            return Err(Error::Budget);
        }
        Ok(ConnectionBudget {
            global: self.global.clone(),
            device: Some(self.counter.clone()),
            local: Arc::new(Counter {
                limit,
                used: Mutex::new(0),
            }),
        })
    }
    pub fn used(&self) -> usize {
        self.counter.used()
    }
}
impl ConnectionBudget {
    pub fn global_used(&self) -> usize {
        self.global.used()
    }
    pub fn device_used(&self) -> Option<usize> {
        self.device.as_ref().map(|d| d.used())
    }
    /// Reserve before allocating. The caller can also reserve its socket/decrypt/phone
    /// buffers here; those allocations are not automatically intercepted by this API.
    pub fn reserve(&self, bytes: usize) -> Result<Reservation> {
        self.local.reserve(bytes)?;
        if let Some(device) = &self.device {
            if let Err(e) = device.reserve(bytes) {
                self.local.release(bytes);
                return Err(e);
            }
        }
        if let Err(e) = self.global.0.reserve(bytes) {
            if let Some(device) = &self.device {
                device.release(bytes);
            }
            self.local.release(bytes);
            return Err(e);
        }
        Ok(Reservation {
            budget: self.clone(),
            bytes,
        })
    }
    pub fn used(&self) -> usize {
        self.local.used()
    }
    pub(crate) fn standalone() -> Self {
        static GLOBAL: OnceLock<GlobalBudget> = OnceLock::new();
        GLOBAL
            .get_or_init(|| GlobalBudget::new(256 * 1024 * 1024).unwrap())
            .connection(64 * 1024 * 1024)
            .unwrap()
    }
}
impl Reservation {
    pub(crate) fn held_bytes(&self) -> usize {
        self.bytes
    }
    /// Transfer part of an existing charge without releasing/reacquiring counters.
    pub(crate) fn split(&mut self, bytes: usize) -> Result<Self> {
        if bytes > self.bytes {
            return Err(Error::Budget);
        }
        self.bytes -= bytes;
        Ok(Self {
            budget: self.budget.clone(),
            bytes,
        })
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.budget.global.0.release(self.bytes);
        if let Some(device) = &self.budget.device {
            device.release(self.bytes);
        }
        self.budget.local.release(self.bytes);
    }
}

#[cfg(test)]
impl Reservation {
    pub(crate) fn budget_for_test(&self) -> ConnectionBudget {
        self.budget.clone()
    }
}
