const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { nativeImage, clipboard, dialog } = require("electron");
const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
const MAX_BYTES = 20 * 1024 * 1024;
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
    const image = clipboard.readImage();
    return image.isEmpty() ? null : this.save(controlId, image, "Screenshot.png");
  }
  async import(controlId, files) {
    if (!Array.isArray(files) || files.length > 8 || files.some((file) => typeof file !== "string" || !path.isAbsolute(file))) throw new Error("Choose up to eight image files.");
    const result = [];
    for (const file of files) {
      if (!/\.(png|jpe?g|webp)$/i.test(file)) throw new Error("Choose PNG, JPEG, or WebP images.");
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("Images must be under 20 MB.");
      result.push(await this.save(controlId, nativeImage.createFromBuffer(await fs.readFile(file)), path.basename(file)));
    }
    return result;
  }
  async choose(window, controlId) {
    const choice = await dialog.showOpenDialog(window, { title: "Attach images", properties: ["openFile", "multiSelections"], filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }] });
    return choice.canceled ? [] : this.import(controlId, choice.filePaths);
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
