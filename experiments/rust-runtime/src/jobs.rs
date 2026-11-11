//! Bounded execution of owner-issued transcript capabilities. No paths or replay.
use milagre_owner_store::{
    chat_host::ChatHost,
    transcripts::{TranscriptJob, MAX_TRANSCRIPT_JOBS},
};
use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
    thread::{self, JoinHandle},
};

#[derive(Default)]
pub(crate) struct Workers {
    threads: Vec<JoinHandle<()>>,
    pending: VecDeque<TranscriptJob>,
    #[cfg(test)]
    pub(crate) before_run: Option<std::sync::Arc<dyn Fn() -> bool + Send + Sync>>,
}
impl Workers {
    /// Called outside the publication lane. The owner reserves at most four jobs;
    /// finished threads may briefly coexist with their replacement reservations.
    pub(crate) fn drive(&mut self, host: &mut ChatHost) {
        let mut index = 0;
        while index < self.threads.len() {
            if self.threads[index].is_finished() {
                let _ = self.threads.swap_remove(index).join();
            } else {
                index += 1;
            }
        }
        if self.pending.is_empty() {
            for job in host.take_jobs() {
                if self.pending.len() < MAX_TRANSCRIPT_JOBS {
                    self.pending.push_back(job);
                }
                // An unexpected excess is dropped, reporting Unknown through its
                // owner guard. Never leak a reservation or replay a capability.
            }
        }
        while self.threads.len() < MAX_TRANSCRIPT_JOBS {
            let Some(job) = self.pending.pop_front() else {
                break;
            };
            #[cfg(test)]
            let hook = self.before_run.clone();
            let spawned = thread::Builder::new()
                .name("isolated-transcript".into())
                .spawn(move || {
                    let _ = catch_unwind(AssertUnwindSafe(move || {
                        #[cfg(test)]
                        if hook.is_some_and(|hook| !hook()) {
                            return;
                        }
                        job.run();
                    }));
                });
            if let Ok(thread) = spawned {
                self.threads.push(thread);
            }
            // spawn failure drops its closure/job and reports Unknown too.
        }
    }
    pub(crate) fn is_empty(&self) -> bool {
        self.pending.is_empty() && self.threads.is_empty()
    }
    pub(crate) fn join(&mut self) {
        self.pending.clear();
        for thread in self.threads.drain(..) {
            let _ = thread.join();
        }
    }
}
impl Drop for Workers {
    fn drop(&mut self) {
        self.join();
    }
}
