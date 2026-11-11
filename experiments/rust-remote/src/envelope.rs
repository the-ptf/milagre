//! Relay multiplexing, distinct from the encrypted channel's 0x03 DATA tag.
use crate::{Error, Result};
/// apps/relay/src/room.mjs MAX_FRAME, excluding the host multiplex header.
pub const MAX_PAYLOAD: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Open = 1,
    Data = 2,
    Close = 3,
    Hook = 4,
    HookSet = 5,
    HookAck = 6,
    HookResult = 7,
}
impl TryFrom<u8> for Kind {
    type Error = Error;
    fn try_from(byte: u8) -> Result<Self> {
        Ok(match byte {
            1 => Self::Open,
            2 => Self::Data,
            3 => Self::Close,
            4 => Self::Hook,
            5 => Self::HookSet,
            6 => Self::HookAck,
            7 => Self::HookResult,
            _ => return Err(Error::Envelope),
        })
    }
}
#[derive(Debug, PartialEq, Eq)]
pub struct Envelope<'a> {
    pub kind: Kind,
    pub connection: u64,
    pub payload: &'a [u8],
}
impl<'a> Envelope<'a> {
    pub fn decode(bytes: &'a [u8]) -> Result<Self> {
        if bytes.len() < 9 {
            return Err(Error::Envelope);
        }
        if bytes.len() > MAX_PAYLOAD + 9 {
            return Err(Error::TooLarge);
        }
        let kind = Kind::try_from(bytes[0])?;
        let connection = u64::from_be_bytes(bytes[1..9].try_into().unwrap());
        if (kind as u8 >= 4) != (connection == 0) {
            return Err(Error::Envelope);
        }
        Ok(Self {
            kind,
            connection,
            payload: &bytes[9..],
        })
    }
    pub fn encode(&self) -> Result<Vec<u8>> {
        if self.payload.len() > MAX_PAYLOAD {
            return Err(Error::TooLarge);
        }
        if (self.kind as u8 >= 4) != (self.connection == 0) {
            return Err(Error::Envelope);
        }
        let mut out = Vec::with_capacity(9 + self.payload.len());
        out.push(self.kind as u8);
        out.extend_from_slice(&self.connection.to_be_bytes());
        out.extend_from_slice(self.payload);
        Ok(out)
    }
}
