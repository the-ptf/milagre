const m = await import(process.cwd() + "/packages/shared/src/simulator-receiver.mjs");
const devices = [
  ["iphone16pro", 1179, 2556],
  ["iphonese", 750, 1334],
  ["ipadair", 1640, 2360],
];
const boxes = [
  [341, 760],
  [600, 420],
];
const orients = ["portrait", "landscape-left", "landscape-right", "portrait-upside-down"];
const pts = [
  [60, 120],
  [170, 380],
  [5, 5],
  [330, 700],
  [400, 200],
];
const out = [];
for (const [name, w, h] of devices)
  for (const [bw, bh] of boxes)
    for (const o of orients) {
      const g = m.simulatorGeometry({ width: w, height: h, orientation: o }, { width: bw, height: bh }, 24);
      const mapped = pts.map(([x, y]) => [
        m.simulatorPoint({ x, y }, g, false, 0),
        m.simulatorPoint({ x, y }, g, true, 0),
        m.simulatorPoint({ x, y }, g, false, Math.min(g.width, g.height) * 0.14),
      ]);
      out.push({ name, w, h, bw, bh, o, g, mapped });
    }
// already-rotated landscape buffer
const g2 = m.simulatorGeometry({ width: 2556, height: 1179, orientation: "landscape-left" }, { width: 341, height: 760 }, 24);
out.push({
  name: "rotated-buffer",
  w: 2556,
  h: 1179,
  bw: 341,
  bh: 760,
  o: "landscape-left",
  g: g2,
  mapped: pts.map(([x, y]) => [
    m.simulatorPoint({ x, y }, g2, false, 0),
    m.simulatorPoint({ x, y }, g2, true, 0),
    m.simulatorPoint({ x, y }, g2, false, Math.min(g2.width, g2.height) * 0.14),
  ]),
});
const names = [
  ["ios", "iPhone 16 Pro", null],
  ["ios", "My phone", "com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro"],
  ["ios", "iPhone SE (3rd generation)", null],
  ["ios", "iPhone 8", null],
  ["ios", "iPhone Xs Max", null],
  ["ios", "iPhone Air", null],
  ["ios", "iPhone 16e", null],
  ["ios", "iPad Air 11-inch (M2)", null],
  ["android", "Pixel 9", null],
  ["ios", "Custom", null],
  ["ios", "iPhone 11", null],
];
const app = names.map(([platform, name, deviceType]) => m.simulatorAppearance({ platform, name, deviceType }).radius);
console.log(JSON.stringify({ out, app }));
