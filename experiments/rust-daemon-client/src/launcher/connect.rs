//! AF_UNIX connection admission never blocks on a full listener backlog.
use super::{failure, invalid, io, Result};
use std::{
    mem,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{ffi::OsStrExt, net::UnixStream},
    },
    path::Path,
    thread,
    time::{Duration, Instant},
};

fn remaining(until: Instant) -> Result<Duration> {
    let left = until.saturating_duration_since(Instant::now());
    if left.is_zero() {
        Err(failure(
            "FIXTURE_CONNECT_TIMEOUT",
            "Owned fixture socket connect timed out",
        ))
    } else {
        Ok(left)
    }
}

fn nonblocking_socket() -> Result<OwnedFd> {
    let raw = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM, 0) };
    if raw < 0 {
        return Err(io(std::io::Error::last_os_error()));
    }
    // Ownership starts before every fallible setup operation. The descriptor is
    // private; neither a timeout nor cancellation leaves a connecting socket.
    let socket = unsafe { OwnedFd::from_raw_fd(raw) };
    if unsafe { libc::fcntl(raw, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
        || unsafe { libc::fcntl(raw, libc::F_SETFL, libc::O_NONBLOCK) } < 0
    {
        return Err(io(std::io::Error::last_os_error()));
    }
    Ok(socket)
}

pub(super) fn until(path: &Path, deadline: Instant) -> Result<UnixStream> {
    remaining(deadline)?;
    let socket = nonblocking_socket()?;
    let raw = socket.as_raw_fd();
    let mut address: libc::sockaddr_un = unsafe { mem::zeroed() };
    address.sun_family = libc::AF_UNIX as libc::sa_family_t;
    let bytes = path.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.len() >= address.sun_path.len() || bytes.contains(&0) {
        return Err(invalid());
    }
    for (target, value) in address.sun_path.iter_mut().zip(bytes) {
        *target = *value as libc::c_char;
    }
    let length =
        (mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(target_os = "macos")]
    {
        address.sun_len = length as u8;
    }
    loop {
        remaining(deadline)?;
        let result =
            unsafe { libc::connect(raw, (&address as *const libc::sockaddr_un).cast(), length) };
        if result == 0 {
            break;
        }
        let error = std::io::Error::last_os_error();
        match error.raw_os_error() {
            Some(libc::EISCONN) => break,
            Some(libc::EINTR) => continue,
            Some(libc::EAGAIN) => {
                // AF_UNIX may reject a nonblocking admission until its backlog
                // has space instead of putting the descriptor into EINPROGRESS.
                thread::sleep(remaining(deadline)?.min(Duration::from_millis(5)));
                continue;
            }
            Some(libc::EINPROGRESS) | Some(libc::EALREADY) => {}
            Some(libc::ECONNREFUSED) => {
                return Err(failure(
                    "FIXTURE_CONNECT_REFUSED",
                    "Owned fixture listener refused connection",
                ))
            }
            _ => return Err(io(error)),
        }
        loop {
            let left = remaining(deadline)?;
            let mut poll = libc::pollfd {
                fd: socket.as_raw_fd(),
                events: libc::POLLOUT,
                revents: 0,
            };
            let ready =
                unsafe { libc::poll(&mut poll, 1, left.as_millis().clamp(1, 100) as libc::c_int) };
            if ready < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(io(error));
            }
            if ready == 0 {
                continue;
            }
            let mut error: libc::c_int = 0;
            let mut size = mem::size_of_val(&error) as libc::socklen_t;
            if unsafe {
                libc::getsockopt(
                    raw,
                    libc::SOL_SOCKET,
                    libc::SO_ERROR,
                    (&mut error as *mut libc::c_int).cast(),
                    &mut size,
                )
            } != 0
                || size as usize != mem::size_of_val(&error)
            {
                return Err(io(std::io::Error::last_os_error()));
            }
            if error != 0 {
                return Err(io(std::io::Error::from_raw_os_error(error)));
            }
            break;
        }
        break;
    }
    remaining(deadline)?;
    let stream = UnixStream::from(socket);
    stream.set_nonblocking(false).map_err(io)?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_socket_is_nonblocking_and_close_on_exec_before_connect() {
        let socket = nonblocking_socket().unwrap();
        assert_ne!(
            unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK,
            0
        );
        assert_ne!(
            unsafe { libc::fcntl(socket.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
            0
        );
    }
}
