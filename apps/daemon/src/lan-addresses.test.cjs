const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lanAddresses } = require("./lan-addresses.cjs");

const v4 = (address, internal = false) => ({ address, family: "IPv4", internal, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: null });

test("only private IPv4 addresses of physical interfaces and tailnet addresses are advertised", () => {
  const found = lanAddresses({
    lo0: [v4("127.0.0.1", true)],
    en0: [v4("192.168.1.20"), { ...v4("fe80::1"), family: "IPv6" }],
    en1: [v4("10.0.0.7")],
    en5: [v4("172.20.3.4"), v4("172.32.0.1"), v4("169.254.10.10")],
    utun3: [v4("100.101.102.103")],
    utun4: [v4("10.20.30.40"), v4("100.128.0.1")],
    bridge100: [v4("192.168.64.1")],
    vmnet8: [v4("172.16.5.1")],
    awdl0: [v4("10.9.9.9")],
    llw0: [v4("10.8.8.8")],
    en7: [v4("8.8.8.8")],
  });
  assert.deepEqual(found, ["10.0.0.7", "172.20.3.4", "192.168.1.20", "100.101.102.103"]);
});

test("a tailnet address comes after every LAN address and only from a utun", () => {
  const found = lanAddresses({ utun8: [v4("100.107.136.115")], en0: [v4("192.168.1.20")], en1: [v4("100.64.0.9")], bridge0: [v4("100.70.0.1")] });
  assert.deepEqual(found, ["192.168.1.20", "100.107.136.115"]);
});

test("the same address on two interfaces is listed once", () => {
  assert.deepEqual(lanAddresses({ en0: [v4("192.168.1.20")], en1: [v4("192.168.1.20")] }), ["192.168.1.20"]);
});
