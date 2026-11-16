const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { ORCHESTRATOR_MAX_IMAGES: MAX_TASK_IMAGES } = require("@milagre/shared/orchestrator");
const { decodeImages } = require("../image-input.cjs");

const TASK_ID = /^[A-Za-z0-9-]{1,100}$/;

function checkedImages(images) {
  if (images === undefined || images === null) return [];
  if (!Array.isArray(images)) throw new Error("Images must be an array.");
  if (images.length > MAX_TASK_IMAGES) throw new Error(`Attach at most ${MAX_TASK_IMAGES} images.`);
  decodeImages(images);
  return images.map((image, index) => ({
    id: typeof image.id === "string" && image.id ? image.id.slice(0, 100) : `image-${index + 1}`,
    name: typeof image.name === "string" && image.name ? image.name.slice(0, 180) : `Image ${index + 1}`,
    dataUrl: image.dataUrl,
  }));
}

function savedImages(port, task) {
  if (!task?.images) return [];
  const images = port.load(task.id);
  if (!images) throw new Error("This task's images are gone. Send it again with the images.");
  return images;
}

function createTaskImages({ dir }) {
  const fileOf = (taskId) => {
    if (!TASK_ID.test(taskId)) throw new Error("Invalid task id");
    return path.join(dir, `${taskId}.json`);
  };
  return {
    save(taskId, images) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = fileOf(taskId);
      const temp = `${file}.${randomUUID()}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(images), { mode: 0o600 });
      fs.renameSync(temp, file);
    },
    load(taskId) {
      try {
        return checkedImages(JSON.parse(fs.readFileSync(fileOf(taskId), "utf8")));
      } catch {
        return null;
      }
    },
    drop(taskId) {
      if (TASK_ID.test(taskId)) fs.rmSync(fileOf(taskId), { force: true });
    },
    prune(keep) {
      const kept = new Set(keep);
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const taskId = name.replace(/\.json$/, "");
        if (name.endsWith(".json") && !kept.has(taskId)) fs.rmSync(path.join(dir, name), { force: true });
      }
    },
  };
}

module.exports = { createTaskImages, checkedImages, savedImages };
