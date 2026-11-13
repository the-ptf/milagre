//! Fixed-shape, bounded synthetic snapshot codec. Never emits parser input in errors.
use super::{StoreFault, StoreLimits};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{
    de::{DeserializeSeed, SeqAccess, Visitor},
    Deserialize, Serialize,
};
use std::{
    fmt,
    io::{self, Write},
};

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Phone,
    Desktop,
}
#[derive(Clone, Copy)]
pub(crate) struct Device {
    pub key: [u8; 32],
    pub kind: Kind,
    pub epoch: u64,
    pub removed: Option<u64>,
    pub last_removed: Option<u64>,
}
#[derive(Clone)]
pub(crate) struct Snapshot {
    pub profile: [u8; 16],
    pub revision: u64,
    pub identity: u64,
    pub boot: u64,
    pub policy: u64,
    pub retired: bool,
    pub running: bool,
    pub secret: [u8; 32],
    pub token: [u8; 32],
    pub devices: Vec<Device>,
}
pub(crate) fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex<const N: usize>(s: &str) -> Result<[u8; N], StoreFault> {
    if s.len() != N * 2
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(StoreFault::InvalidSchema);
    }
    let mut out = [0; N];
    for (i, p) in s.as_bytes().as_chunks::<2>().0.iter().enumerate() {
        out[i] = u8::from_str_radix(
            std::str::from_utf8(p).map_err(|_| StoreFault::InvalidSchema)?,
            16,
        )
        .map_err(|_| StoreFault::InvalidSchema)?;
    }
    Ok(out)
}
fn key(s: &str) -> Result<[u8; 32], StoreFault> {
    if s.len() != 43 {
        return Err(StoreFault::InvalidSchema);
    }
    let mut out = [0; 32];
    if URL_SAFE_NO_PAD
        .decode_slice(s, &mut out)
        .map_err(|_| StoreFault::InvalidSchema)?
        != 32
        || URL_SAFE_NO_PAD.encode(out) != s
    {
        return Err(StoreFault::InvalidSchema);
    }
    Ok(out)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Wire<'a> {
    version: u8,
    profile_id: &'a str,
    revision: u64,
    identity_generation: u64,
    boot_generation: u64,
    policy_generation: u64,
    identity_status: &'a str,
    run_state: &'a str,
    box_secret: &'a str,
    pairing_token: &'a str,
    #[serde(borrow)]
    devices: &'a serde_json::value::RawValue,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireDevice<'a> {
    key: &'a str,
    kind: &'a str,
    epoch: u64,
    state: &'a str,
    #[serde(deserialize_with = "required_optional_u64")]
    removal_generation: Option<u64>,
}
fn required_optional_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Option::<u64>::deserialize(d)
}
struct Records {
    limit: usize,
}
impl<'de> DeserializeSeed<'de> for Records {
    type Value = Vec<Device>;
    fn deserialize<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
        d.deserialize_seq(self)
    }
}
impl<'de> Visitor<'de> for Records {
    type Value = Vec<Device>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded device array")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
        let mut out: Vec<Device> = Vec::new();
        out.try_reserve_exact(self.limit)
            .map_err(|_| serde::de::Error::custom("allocation"))?;
        while let Some(w) = seq.next_element::<WireDevice<'de>>()? {
            if out.len() >= self.limit {
                return Err(serde::de::Error::custom("limit"));
            }
            let k = key(w.key).map_err(|_| serde::de::Error::custom("schema"))?;
            if out.last().is_some_and(|prev| prev.key >= k) {
                return Err(serde::de::Error::custom("order"));
            }
            let kind = match w.kind {
                "phone" => Kind::Phone,
                "desktop" => Kind::Desktop,
                _ => return Err(serde::de::Error::custom("kind")),
            };
            out.push(Device {
                key: k,
                kind,
                epoch: w.epoch,
                removed: match w.state {
                    "active" => None,
                    "removed" => Some(
                        w.removal_generation
                            .ok_or_else(|| serde::de::Error::custom("removal"))?,
                    ),
                    _ => return Err(serde::de::Error::custom("state")),
                },
                last_removed: w.removal_generation,
            });
        }
        Ok(out)
    }
}
// Before serde sees data: no string escapes/large string or numeric scratch, shallow
// fixed schema only. serde still validates the complete JSON syntax and duplicate fields.
fn precheck(bytes: &[u8], max: usize) -> Result<(), StoreFault> {
    if bytes.len() > max {
        return Err(StoreFault::TooLarge);
    }
    let (mut string, mut length, mut depth, mut digits) = (false, 0usize, 0usize, 0usize);
    for &b in bytes {
        if string {
            if b == b'"' {
                string = false;
            } else {
                length += 1;
                if b == b'\\' || !(32..=126).contains(&b) || length > 128 {
                    return Err(StoreFault::InvalidSchema);
                }
            }
        } else {
            match b {
                b'"' => {
                    string = true;
                    length = 0;
                }
                b'{' | b'[' => {
                    depth += 1;
                    if depth > 4 {
                        return Err(StoreFault::InvalidSchema);
                    }
                }
                b'}' | b']' => {
                    depth = depth.checked_sub(1).ok_or(StoreFault::InvalidSchema)?;
                }
                _ => {}
            }
        }
        if !string && b.is_ascii_digit() {
            digits += 1;
            if digits > 20 {
                return Err(StoreFault::InvalidSchema);
            }
        } else {
            digits = 0;
        }
    }
    if string || depth != 0 {
        return Err(StoreFault::InvalidSchema);
    }
    Ok(())
}
impl Snapshot {
    pub fn decode(bytes: &[u8], limits: StoreLimits) -> Result<Self, StoreFault> {
        precheck(bytes, limits.snapshot_bytes)?;
        let wire: Wire<'_> =
            serde_json::from_slice(bytes).map_err(|_| StoreFault::InvalidSchema)?;
        if wire.version != 1 || wire.identity_generation != 1 {
            return Err(StoreFault::InvalidSchema);
        }
        let mut d = serde_json::Deserializer::from_str(wire.devices.get());
        let devices = Records {
            limit: limits.history_slots.min(limits.parsed_bytes / 640),
        }
        .deserialize(&mut d)
        .map_err(|_| StoreFault::InvalidSchema)?;
        d.end().map_err(|_| StoreFault::InvalidSchema)?;
        let state = Self {
            profile: unhex(wire.profile_id)?,
            revision: wire.revision,
            identity: wire.identity_generation,
            boot: wire.boot_generation,
            policy: wire.policy_generation,
            retired: match wire.identity_status {
                "current" => false,
                "retired" => true,
                _ => return Err(StoreFault::InvalidSchema),
            },
            running: match wire.run_state {
                "clean" => false,
                "running" => true,
                _ => return Err(StoreFault::InvalidSchema),
            },
            secret: key(wire.box_secret)?,
            token: unhex(wire.pairing_token)?,
            devices,
        };
        state.validate(limits)?;
        Ok(state)
    }
    pub fn validate(&self, limits: StoreLimits) -> Result<(), StoreFault> {
        if self.identity != 1
            || self.revision == 0
            || self.devices.len() > limits.history_slots
            || self.devices.capacity() * 640 > limits.parsed_bytes
        {
            return Err(StoreFault::TooLarge);
        }
        if (self.retired && (self.secret != [0; 32] || self.token != [0; 32]))
            || self.boot > self.revision
            || self.policy > self.revision
            || (self.running && (self.boot == 0 || self.retired))
            || (self.boot == 0 && (self.retired || self.policy != 0 || !self.devices.is_empty()))
            || self
                .boot
                .checked_add(self.policy)
                .is_none_or(|n| n > self.revision)
        {
            return Err(StoreFault::InvalidSchema);
        }
        for (i, d) in self.devices.iter().enumerate() {
            if (d.epoch == 0) != d.last_removed.is_none()
                || d.last_removed
                    .is_some_and(|g| g == 0 || g > self.policy || g < d.epoch)
                || (d.removed.is_some() && d.removed != d.last_removed)
                || d.epoch > self.policy
                || (i > 0 && self.devices[i - 1].key >= d.key)
                || d.removed
                    .is_some_and(|g| g == 0 || g > self.policy || d.epoch == 0)
            {
                return Err(StoreFault::InvalidSchema);
            }
        }
        Ok(())
    }
    pub fn encode(&self, limits: StoreLimits) -> Result<Vec<u8>, StoreFault> {
        self.validate(limits)?;
        // Reserve the output's maximum capacity once; Writer refuses before exceeding it.
        struct Bounded {
            bytes: Vec<u8>,
            limit: usize,
        }
        impl Write for Bounded {
            fn write(&mut self, b: &[u8]) -> io::Result<usize> {
                if b.len() > self.limit - self.bytes.len() {
                    return Err(io::ErrorKind::FileTooLarge.into());
                }
                self.bytes.extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        #[derive(Serialize)]
        struct Record<'a> {
            key: String,
            kind: Kind,
            epoch: u64,
            state: &'static str,
            removal_generation: &'a Option<u64>,
        }
        struct Array<'a>(&'a [Device]);
        impl Serialize for Array<'_> {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                use serde::ser::SerializeSeq;
                let mut seq = s.serialize_seq(Some(self.0.len()))?;
                for d in self.0 {
                    seq.serialize_element(&Record {
                        key: URL_SAFE_NO_PAD.encode(d.key),
                        kind: d.kind,
                        epoch: d.epoch,
                        state: if d.removed.is_some() {
                            "removed"
                        } else {
                            "active"
                        },
                        removal_generation: &d.last_removed,
                    })?;
                }
                seq.end()
            }
        }
        #[derive(Serialize)]
        struct Output<'a> {
            version: u8,
            profile_id: String,
            revision: u64,
            identity_generation: u64,
            boot_generation: u64,
            policy_generation: u64,
            identity_status: &'static str,
            run_state: &'static str,
            box_secret: String,
            pairing_token: String,
            devices: Array<'a>,
        }
        let mut out = Bounded {
            bytes: Vec::new(),
            limit: limits.snapshot_bytes,
        };
        out.bytes
            .try_reserve_exact(limits.snapshot_bytes)
            .map_err(|_| StoreFault::TooLarge)?;
        if out.bytes.capacity() > limits.snapshot_bytes {
            return Err(StoreFault::TooLarge);
        }
        serde_json::to_writer(
            &mut out,
            &Output {
                version: 1,
                profile_id: hex(&self.profile),
                revision: self.revision,
                identity_generation: self.identity,
                boot_generation: self.boot,
                policy_generation: self.policy,
                identity_status: if self.retired { "retired" } else { "current" },
                run_state: if self.running { "running" } else { "clean" },
                box_secret: URL_SAFE_NO_PAD.encode(self.secret),
                pairing_token: hex(&self.token),
                devices: Array(&self.devices),
            },
        )
        .map_err(|_| StoreFault::TooLarge)?;
        out.write_all(b"\n").map_err(|_| StoreFault::TooLarge)?;
        Ok(out.bytes)
    }
}
