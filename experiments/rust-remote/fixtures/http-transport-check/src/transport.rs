use crate::owner::Control;
use bytes::Buf;
use http_body::{Body, Frame, SizeHint};
use hyper::rt::{Read, ReadBufCursor, Write};
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

pub const BLOCK: usize = 65_536;
pub const MAX_BODY: usize = 64 * 1024 * 1024;
const MAX_WIRE: usize = 72 * 1024 * 1024;
pub const STACK: usize = 2 * 1024 * 1024;

pub enum Segment {
    Bytes(Box<[u8]>),
    Repeat { byte: u8, len: usize },
}
pub struct Script {
    pub parts: Arc<[Segment]>,
    pub fragment: usize,
    pub stall_after: Option<usize>,
    pub panic_after: Option<usize>,
}
impl Clone for Script {
    fn clone(&self) -> Self {
        Self {
            parts: self.parts.clone(),
            ..*self
        }
    }
}
pub struct RequestStorage {
    pub bytes: Box<[u8]>,
}
pub struct ResponseStorage {
    blocks: Box<[Box<[u8; BLOCK]>]>,
    pub len: usize,
    pub hash: u64,
}
impl ResponseStorage {
    pub fn new() -> Self {
        let mut blocks = Vec::with_capacity(MAX_BODY / BLOCK);
        for _ in 0..MAX_BODY / BLOCK {
            let block: Box<[u8; BLOCK]> = vec![0; BLOCK].into_boxed_slice().try_into().unwrap();
            blocks.push(block);
        }
        Self {
            blocks: blocks.into_boxed_slice(),
            len: 0,
            hash: 0,
        }
    }
    fn append(&mut self, bytes: &[u8]) -> bool {
        if bytes.len() > MAX_BODY - self.len {
            return false;
        }
        let mut rest = bytes;
        while !rest.is_empty() {
            let count = rest.len().min(BLOCK - self.len % BLOCK);
            self.blocks[self.len / BLOCK][self.len % BLOCK..self.len % BLOCK + count]
                .copy_from_slice(&rest[..count]);
            self.hash = self
                .hash
                .wrapping_add(rest[..count].iter().map(|b| u64::from(*b)).sum::<u64>());
            self.len += count;
            rest = &rest[count..];
        }
        true
    }
    pub fn capacity(&self) -> usize {
        self.blocks.len() * BLOCK
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct Stats {
    pub turns: usize,
    pub read_calls: usize,
    pub write_calls: usize,
    pub raw_bytes: usize,
    pub raw_reads: usize,
    pub max_raw_read: usize,
    pub written_bytes: usize,
    pub request_body_bytes: usize,
    pub request_body_hash: u64,
    pub max_read: usize,
    pub max_write: usize,
    pub max_frame: usize,
    pub blocked_reads: usize,
    pub blocked_writes: usize,
    pub incoming_frames: usize,
    pub headers: usize,
    pub trailers: usize,
    pub infos: usize,
}
#[derive(Default)]
struct Turn {
    read: bool,
    write: bool,
    body: bool,
    stats: Stats,
}
impl Turn {
    fn next(&mut self) {
        self.read = false;
        self.write = false;
        self.body = false;
        self.stats.turns += 1;
    }
}
struct Chunk {
    owner: Arc<RequestStorage>,
    at: usize,
    end: usize,
}
impl Buf for Chunk {
    fn remaining(&self) -> usize {
        self.end - self.at
    }
    fn chunk(&self) -> &[u8] {
        &self.owner.bytes[self.at..self.end]
    }
    fn advance(&mut self, n: usize) {
        assert!(n <= self.remaining());
        self.at += n;
    }
}
struct RequestBody {
    owner: Arc<RequestStorage>,
    at: usize,
    turn: Arc<Mutex<Turn>>,
}
impl Body for RequestBody {
    type Data = Chunk;
    type Error = io::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Chunk>, io::Error>>> {
        if self.at == self.owner.bytes.len() {
            return Poll::Ready(None);
        }
        {
            let mut turn = self.turn.lock().unwrap();
            if turn.body {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            turn.body = true;
        }
        let end = (self.at + BLOCK).min(self.owner.bytes.len());
        let chunk = Chunk {
            owner: self.owner.clone(),
            at: self.at,
            end,
        };
        self.at = end;
        Poll::Ready(Some(Ok(Frame::data(chunk))))
    }
    fn size_hint(&self) -> SizeHint {
        SizeHint::with_exact((self.owner.bytes.len() - self.at) as u64)
    }
    fn is_end_stream(&self) -> bool {
        self.at == self.owner.bytes.len()
    }
}
struct Source {
    script: Script,
    part: usize,
    offset: usize,
    total: usize,
    reads: usize,
    max_read: usize,
}
impl Source {
    fn read(&mut self, out: &mut [u8], control: &Control) -> io::Result<Option<usize>> {
        if self.script.panic_after.is_some_and(|n| self.total >= n) {
            panic!("offline scripted unwind");
        }
        if self.script.stall_after.is_some_and(|n| self.total >= n) {
            control.stalled();
            return Ok(None);
        }
        let limit = out
            .len()
            .min(self.script.fragment)
            .min(MAX_WIRE + 1 - self.total);
        let mut n = 0;
        while n < limit && self.part < self.script.parts.len() {
            let part = &self.script.parts[self.part];
            let len = match part {
                Segment::Bytes(v) => v.len(),
                Segment::Repeat { len, .. } => *len,
            };
            let take = (len - self.offset).min(limit - n);
            match part {
                Segment::Bytes(v) => {
                    out[n..n + take].copy_from_slice(&v[self.offset..self.offset + take])
                }
                Segment::Repeat { byte, .. } => out[n..n + take].fill(*byte),
            }
            self.offset += take;
            n += take;
            if self.offset == len {
                self.part += 1;
                self.offset = 0;
            }
        }
        self.total += n;
        self.reads += 1;
        self.max_read = self.max_read.max(n);
        if self.total > MAX_WIRE {
            return Err(io::Error::other("offline wire limit"));
        }
        Ok(Some(n))
    }
}
struct HeadGate {
    bytes: Box<[u8; BLOCK]>,
    len: usize,
    served: usize,
    end: usize,
    final_head: bool,
    body: bool,
    infos: usize,
    info_bytes: usize,
}
impl HeadGate {
    fn new() -> Self {
        Self {
            bytes: Box::new([0; BLOCK]),
            len: 0,
            served: 0,
            end: 0,
            final_head: false,
            body: false,
            infos: 0,
            info_bytes: 0,
        }
    }
    fn read(
        &mut self,
        source: &mut Source,
        out: &mut [u8],
        control: &Control,
    ) -> io::Result<Option<usize>> {
        // At most one raw-source read per adapter read. Releasing a previously
        // validated head or buffered body tail makes no raw read.
        let mut fetched = false;
        loop {
            if self.end > self.served {
                let n = (self.end - self.served).min(out.len());
                out[..n].copy_from_slice(&self.bytes[self.served..self.served + n]);
                self.served += n;
                if self.served == self.end {
                    self.bytes.copy_within(self.end..self.len, 0);
                    self.len -= self.end;
                    self.end = 0;
                    self.served = 0;
                    self.body |= self.final_head;
                }
                return Ok(Some(n));
            }
            if self.body {
                if self.len > 0 {
                    let n = self.len.min(out.len());
                    out[..n].copy_from_slice(&self.bytes[..n]);
                    self.bytes.copy_within(n..self.len, 0);
                    self.len -= n;
                    return Ok(Some(n));
                }
                return source.read(out, control);
            }
            let mut headers = [httparse::EMPTY_HEADER; 100];
            let mut parsed = httparse::Response::new(&mut headers);
            match parsed.parse(&self.bytes[..self.len]) {
                Ok(httparse::Status::Complete(n)) => {
                    let code = parsed.code.unwrap();
                    if code == 101 {
                        return Err(io::Error::other("offline upgrade refused"));
                    }
                    self.final_head = !(100..200).contains(&code);
                    if !self.final_head {
                        self.infos += 1;
                        self.info_bytes += n;
                        if self.infos > 8 || self.info_bytes > BLOCK {
                            return Err(io::Error::other("offline informational limit"));
                        }
                    }
                    self.end = n;
                }
                Ok(httparse::Status::Partial) => {
                    if self.len == BLOCK {
                        return Err(io::Error::other("offline head limit"));
                    }
                    if fetched {
                        return Ok(None);
                    }
                    match source.read(&mut self.bytes[self.len..], control)? {
                        Some(0) => {
                            return Err(io::Error::new(
                                io::ErrorKind::UnexpectedEof,
                                "offline truncated head",
                            ))
                        }
                        Some(n) => {
                            self.len += n;
                            fetched = true;
                        }
                        None => return Ok(None),
                    }
                }
                Err(_) => return Err(io::Error::other("offline malformed head")),
            }
        }
    }
}
struct MemoryIo {
    source: Source,
    gate: HeadGate,
    scratch: Box<[u8; BLOCK]>,
    request_head: Box<[u8]>,
    request_head_len: usize,
    expected_body: Option<usize>,
    body_received: usize,
    control: Arc<Control>,
    turn: Arc<Mutex<Turn>>,
}
impl MemoryIo {
    fn consume_request(&mut self, input: &[u8]) -> io::Result<()> {
        let mut at = 0;
        if self.expected_body.is_none() {
            while at < input.len() {
                if self.request_head_len == self.request_head.len() {
                    return Err(io::Error::other("offline request head limit"));
                }
                self.request_head[self.request_head_len] = input[at];
                self.request_head_len += 1;
                at += 1;
                if self.request_head[..self.request_head_len].ends_with(b"\r\n\r\n") {
                    let mut headers = [httparse::EMPTY_HEADER; 100];
                    let mut request = httparse::Request::new(&mut headers);
                    if !request
                        .parse(&self.request_head[..self.request_head_len])
                        .is_ok_and(|s| s.is_complete())
                    {
                        return Err(io::Error::other("offline bad request"));
                    }
                    let length = request
                        .headers
                        .iter()
                        .find(|h| h.name.eq_ignore_ascii_case("content-length"))
                        .map(|h| {
                            std::str::from_utf8(h.value)
                                .unwrap()
                                .parse::<usize>()
                                .unwrap()
                        })
                        .unwrap_or(0);
                    self.expected_body = Some(length);
                    break;
                }
            }
        }
        if at < input.len() {
            let mut turn = self.turn.lock().unwrap();
            turn.stats.request_body_bytes += input.len() - at;
            turn.stats.request_body_hash += input[at..].iter().map(|b| u64::from(*b)).sum::<u64>();
            self.body_received += input.len() - at;
        }
        Ok(())
    }
}
impl Read for MemoryIo {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        mut buf: ReadBufCursor<'_>,
    ) -> Poll<io::Result<()>> {
        {
            let mut turn = self.turn.lock().unwrap();
            if turn.read {
                turn.stats.blocked_reads += 1;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            turn.read = true;
        }
        if !self.expected_body.is_some_and(|n| self.body_received == n) {
            cx.waker().wake_by_ref();
            return Poll::Pending;
        }
        let this = &mut *self;
        let limit = buf.remaining().min(BLOCK);
        let result = this
            .gate
            .read(&mut this.source, &mut this.scratch[..limit], &this.control);
        {
            let mut turn = this.turn.lock().unwrap();
            turn.stats.raw_bytes = this.source.total;
            turn.stats.raw_reads = this.source.reads;
            turn.stats.max_raw_read = this.source.max_read;
            turn.stats.infos = this.gate.infos;
        }
        match result {
            Ok(Some(n)) => {
                buf.put_slice(&this.scratch[..n]);
                let mut turn = this.turn.lock().unwrap();
                turn.stats.read_calls += 1;
                turn.stats.max_read = turn.stats.max_read.max(n);
                turn.stats.raw_bytes = this.source.total;
                turn.stats.infos = this.gate.infos;
                Poll::Ready(Ok(()))
            }
            Ok(None) => {
                if !this.control.is_stalled() {
                    cx.waker().wake_by_ref();
                }
                Poll::Pending
            }
            Err(e) => Poll::Ready(Err(e)),
        }
    }
}
impl Write for MemoryIo {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        {
            let mut turn = self.turn.lock().unwrap();
            if turn.write {
                turn.stats.blocked_writes += 1;
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            turn.write = true;
        }
        let n = input.len().min(BLOCK);
        self.consume_request(&input[..n])?;
        let mut turn = self.turn.lock().unwrap();
        turn.stats.write_calls += 1;
        turn.stats.written_bytes += n;
        turn.stats.max_write = turn.stats.max_write.max(n);
        Poll::Ready(Ok(n))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn is_write_vectored(&self) -> bool {
        false
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Success,
    Invalid,
    TooLarge,
    Cancelled,
    TurnLimit,
    Panic,
}
#[derive(Clone, Copy, Debug)]
pub struct Report {
    pub outcome: Outcome,
    pub status: u16,
    pub stats: Stats,
}

pub fn run(
    script: Script,
    request: Arc<RequestStorage>,
    response: Arc<Mutex<ResponseStorage>>,
    control: Arc<Control>,
) -> Report {
    let turn = Arc::new(Mutex::new(Turn::default()));
    let io = MemoryIo {
        source: Source {
            script,
            part: 0,
            offset: 0,
            total: 0,
            reads: 0,
            max_read: 0,
        },
        gate: HeadGate::new(),
        scratch: Box::new([0; BLOCK]),
        request_head: vec![0; 96 * 1024].into_boxed_slice(),
        request_head_len: 0,
        expected_body: None,
        body_received: 0,
        control: control.clone(),
        turn: turn.clone(),
    };
    let waker = control.waker();
    let mut cx = Context::from_waker(&waker);
    let mut builder = hyper::client::conn::http1::Builder::new();
    builder
        .max_buf_size(BLOCK)
        .max_header_size(BLOCK)
        .writev(true);
    let handshake = builder.handshake(io);
    let mut handshake = std::pin::pin!(handshake);
    let (mut sender, connection) = match handshake.as_mut().poll(&mut cx) {
        Poll::Ready(Ok(pair)) => pair,
        _ => unreachable!("HTTP/1 handshake is immediate over owned IO"),
    };
    let mut connection = std::pin::pin!(connection);
    let body = RequestBody {
        owner: request,
        at: 0,
        turn: turn.clone(),
    };
    let request = http::Request::builder()
        .method("POST")
        .uri("/offline")
        .header("host", "synthetic.invalid")
        .header("connection", "close")
        .header("authorization", "Bearer public-offline-fixture")
        .body(body)
        .unwrap();
    let sent = sender.send_request(request);
    let mut sent = std::pin::pin!(sent);
    let mut incoming = None;
    let mut connection_done = false;
    let mut status = 0;
    let outcome = 'driver: loop {
        turn.lock().unwrap().next();
        if control.register_and_cancelled(&cx) {
            break Outcome::Cancelled;
        }
        if turn.lock().unwrap().stats.turns > 200_000 {
            break Outcome::TurnLimit;
        }
        let connection_state = if connection_done {
            Poll::Pending
        } else {
            connection.as_mut().poll(&mut cx)
        };
        if connection_state.is_ready() {
            connection_done = true;
        }
        if control.is_cancelled() {
            break Outcome::Cancelled;
        }
        if incoming.is_none() {
            match sent.as_mut().poll(&mut cx) {
                Poll::Ready(Ok(result)) => {
                    status = result.status().as_u16();
                    turn.lock().unwrap().stats.headers = result.headers().len();
                    incoming = Some(result.into_body());
                }
                Poll::Ready(Err(_)) => break Outcome::Invalid,
                Poll::Pending => {}
            }
        }
        if let Some(body) = incoming.as_mut() {
            match Pin::new(body).poll_frame(&mut cx) {
                Poll::Ready(Some(Ok(frame))) => {
                    if let Some(data) = frame.data_ref() {
                        {
                            let mut t = turn.lock().unwrap();
                            t.stats.incoming_frames += 1;
                            t.stats.max_frame = t.stats.max_frame.max(data.len());
                        }
                        if !response.lock().unwrap().append(data) {
                            break 'driver Outcome::TooLarge;
                        }
                    }
                    if let Some(trailers) = frame.trailers_ref() {
                        turn.lock().unwrap().stats.trailers = trailers.len();
                    }
                    drop(frame); // before another connection poll; no collected body
                }
                Poll::Ready(Some(Err(_))) => break Outcome::Invalid,
                Poll::Ready(None) => break Outcome::Success,
                Poll::Pending => {}
            }
        }
        if let Poll::Ready(Err(_)) = connection_state {
            break Outcome::Invalid;
        }
        if control.is_stalled() {
            control.park_until_cancelled();
        }
    };
    let stats = turn.lock().unwrap().stats;
    Report {
        outcome,
        status,
        stats,
    }
}
