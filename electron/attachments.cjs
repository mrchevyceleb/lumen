const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");
const { fileURLToPath } = require("node:url");
const { nativeImage, clipboard, dialog } = require("electron");
const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
const videoExtensions = { "video/mp4": ".mp4", "video/webm": ".webm", "video/quicktime": ".mov", "video/x-matroska": ".mkv", "video/x-msvideo": ".avi", "video/x-m4v": ".m4v" };
const isVideo = (file) => /\.(mp4|webm|mov|mkv|avi|m4v)$/i.test(file);
class Attachments {
  constructor(directory) { this.root = path.join(directory, "attachments"); }
  folder(controlId) {
    if (!validId(controlId)) throw new Error("Invalid attachment conversation.");
    return path.join(this.root, controlId);
  }
  async save(controlId, image, name) {
    if (image.isEmpty()) throw new Error("Choose a PNG, JPEG, or WebP image.");
    const data = image.toPNG();
    if (!data.length || data.length > MAX_BYTES) throw new Error("Images must be under 20 MB after decoding.");
    const id = crypto.randomUUID(), folder = this.folder(controlId);
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, id + ".png"), data, { flag: "wx", mode: 0o600 });
    return { id, name: name || "Screenshot.png", mimeType: "image/png", bytes: data.length,
      preview: image.resize({ width: 160 }).toDataURL() };
  }
  async paste(controlId) {
    const items = await clipboard.read();
    const files = [];
    for (const item of items) {
      if (!item.types.includes("text/uri-list")) continue;
      const uris = await (await item.getType("text/uri-list")).text();
      for (const uri of uris.split(/\r?\n/).map((value) => value.trim())) {
        if (uri.startsWith("file:")) files.push(fileURLToPath(uri));
      }
    }
    // Prefer the actual recording/file over any thumbnail on the clipboard.
    if (files.length) return this.import(controlId, [...new Set(files)]);
    for (const item of items) {
      const videoType = item.types.find((type) => videoExtensions[type]);
      const imageType = item.types.find((type) => /^image\/(png|jpeg|webp)$/.test(type));
      const type = videoType || imageType;
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > (videoType ? MAX_VIDEO_BYTES : MAX_BYTES)) throw new Error(videoType ? "Videos must be under 500 MB." : "Images must be under 20 MB.");
      const data = Buffer.from(await blob.arrayBuffer());
      if (videoType) return { images: [], references: [await this.saveVideo(controlId, data, "Recording" + videoExtensions[videoType])] };
      return { images: [await this.save(controlId, nativeImage.createFromBuffer(data), "Screenshot.png")], references: [] };
    }
    return { images: [], references: [] };
  }
  async saveVideo(controlId, source, name) {
    const size = Buffer.isBuffer(source) ? source.length : (await fs.stat(source)).size;
    if (!size || size > MAX_VIDEO_BYTES) throw new Error("Videos must be non-empty and under 500 MB.");
    const folder = this.folder(controlId);
    await fs.mkdir(folder, { recursive: true });
    const file = path.join(folder, crypto.randomUUID() + "-" + path.basename(name));
    if (Buffer.isBuffer(source)) await fs.writeFile(file, source, { flag: "wx", mode: 0o600 });
    else await fs.copyFile(source, file, constants.COPYFILE_EXCL);
    return file;
  }
  async import(controlId, files) {
    if (!Array.isArray(files) || files.length > 8 || files.some((file) => typeof file !== "string" || !path.isAbsolute(file))) throw new Error("Choose up to eight image or video files.");
    const result = { images: [], references: [] };
    try {
      for (const file of files) {
        if (!/\.(png|jpe?g|webp)$/i.test(file) && !isVideo(file)) throw new Error("Choose PNG, JPEG, WebP, MP4, WebM, MOV, MKV, AVI, or M4V files.");
        const stat = await fs.stat(file);
        if (!stat.isFile()) throw new Error("Choose an image or video file, not a folder.");
        if (isVideo(file)) result.references.push(await this.saveVideo(controlId, file, path.basename(file)));
        else {
          if (stat.size > MAX_BYTES) throw new Error("Images must be under 20 MB.");
          result.images.push(await this.save(controlId, nativeImage.createFromBuffer(await fs.readFile(file)), path.basename(file)));
        }
      }
    } catch (error) {
      const saved = [...result.references, ...result.images.map((image) => path.join(this.folder(controlId), image.id + ".png"))];
      await Promise.allSettled(saved.map((file) => fs.unlink(file)));
      throw error;
    }
    return result;
  }
  async choose(window, controlId) {
    const choice = await dialog.showOpenDialog(window, { title: "Attach images or videos", properties: ["openFile", "multiSelections"], filters: [{ name: "Images and videos", extensions: ["png", "jpg", "jpeg", "webp", "mp4", "webm", "mov", "mkv", "avi", "m4v"] }] });
    return choice.canceled ? { images: [], references: [] } : this.import(controlId, choice.filePaths);
  }
  async resolve(controlId, attachments = []) {
    if (!Array.isArray(attachments) || attachments.length > 8) throw new Error("Attach up to eight images.");
    const result = [];
    let total = 0;
    for (const attachment of attachments) {
      if (!validId(attachment?.id)) throw new Error("Invalid image attachment.");
      const file = path.join(this.folder(controlId), attachment.id + ".png");
      let data;
      try { data = await fs.readFile(file); } catch { throw new Error(`Image ${attachment.name || "attachment"} is unavailable. Attach it again before sending.`); }
      total += data.length;
      if (total > MAX_BYTES) throw new Error("Keep image attachments under 20 MB in total.");
      result.push({ ...attachment, path: file, data: data.toString("base64"), mimeType: "image/png" });
    }
    return result;
  }
}
module.exports = { Attachments };
