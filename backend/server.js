import express from "express";
import helmet from "helmet";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.BUILDER_API_KEY || "";

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(express.static(path.join(__dirname, "../frontend")));

const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 }
});

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function requireKey(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: "Server admin ने BUILDER_API_KEY सेट नहीं किया है।" });
  const key = req.get("x-builder-key") || req.body?.apiKey || "";
  if (!safeEqual(key, API_KEY)) return res.status(401).json({ error: "API key गलत है।" });
  next();
}
function safeName(value, fallback) {
  const s = String(value || "").trim().replace(/[^a-zA-Z0-9._ -]/g, "").slice(0, 40);
  return s || fallback;
}
function safePackage(value) {
  const p = String(value || "com.vipmaster.generated").trim();
  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/.test(p)) {
    throw new Error("Package ID गलत है। उदाहरण: com.example.mygame");
  }
  return p;
}
async function extractZipSafely(zipPath, dest) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();
  if (entries.length > 500) throw new Error("ZIP में 500 से ज्यादा फाइलें हैं।");
  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");
    if (name.startsWith("/") || name.split("/").includes("..")) throw new Error("ZIP में unsafe file path मिला।");
    if (!entry.isDirectory) {
      const target = path.join(dest, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, entry.getData());
    }
  }
}
async function writeProject(work, html, appName, packageId) {
  const project = path.join(work, "project");
  const appDir = path.join(project, "app");
  const assets = path.join(appDir, "src/main/assets");
  await fs.mkdir(assets, { recursive: true });

  const template = path.join(__dirname, "template");
  await fs.cp(template, project, { recursive: true });
  await fs.mkdir(assets, { recursive: true });

  if (html) {
    await fs.writeFile(path.join(assets, "index.html"), html, "utf8");
  } else {
    const extracted = path.join(work, "uploaded");
    await fs.mkdir(extracted, { recursive: true });
    await extractZipSafely(work + "/upload.zip", extracted);
    let sourceRoot = extracted;
    try { await fs.access(path.join(extracted, "index.html")); }
    catch { 
      const items = await fs.readdir(extracted, { withFileTypes: true });
      if (items.length === 1 && items[0].isDirectory()) sourceRoot = path.join(extracted, items[0].name);
    }
    try { await fs.access(path.join(sourceRoot, "index.html")); }
    catch { throw new Error("ZIP के root या एक अंदरूनी folder में index.html नहीं मिली।"); }
    await fs.cp(sourceRoot, assets, { recursive: true });
  }

  const javaRoot = path.join(appDir, "src/main/java");
  const javaSource = path.join(javaRoot, "com/vipmaster/generated/MainActivity.java");
  const packagePath = path.join(javaRoot, ...packageId.split("."));
  await fs.mkdir(packagePath, { recursive: true });
  let javaCode = await fs.readFile(javaSource, "utf8");
  javaCode = javaCode.replace("package com.vipmaster.generated;", "package " + packageId + ";");
  await fs.writeFile(path.join(packagePath, "MainActivity.java"), javaCode);
  await fs.rm(path.join(javaRoot, "com"), { recursive: true, force: true });

  const manifestPath = path.join(appDir, "src/main/AndroidManifest.xml");
  let manifest = await fs.readFile(manifestPath, "utf8");
  manifest = manifest.replaceAll("__PACKAGE_ID__", packageId).replaceAll("__APP_LABEL__", appName.replace(/&/g, "&amp;").replace(/"/g, ""));
  await fs.writeFile(manifestPath, manifest);
  let gradle = await fs.readFile(path.join(appDir, "build.gradle"), "utf8");
  gradle = gradle.replaceAll("__PACKAGE_ID__", packageId);
  await fs.writeFile(path.join(appDir, "build.gradle"), gradle);
  return project;
}

app.post("/api/build", upload.single("projectFile"), requireKey, async (req, res) => {
  const id = randomUUID();
  const work = path.join(os.tmpdir(), "vip-build-" + id);
  try {
    await fs.mkdir(work, { recursive: true });
    const appName = safeName(req.body.appName, "VIP HTML App");
    const packageId = safePackage(req.body.packageId);
    let html = String(req.body.html || "");
    if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) throw new Error("Pasted HTML 2 MB से बड़ी है।");

    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      if (ext === ".zip") {
        await fs.copyFile(req.file.path, path.join(work, "upload.zip"));
        html = "";
      } else if (ext === ".html" || ext === ".htm" || ext === ".txt") {
        html = await fs.readFile(req.file.path, "utf8");
      } else {
        throw new Error("केवल .html या .zip फाइल अपलोड करें।");
      }
    }
    if (!html && !req.file) throw new Error("HTML paste करें या HTML/ZIP file upload करें।");

    const project = await writeProject(work, html, appName, packageId);
    const gradle = path.join(project, "gradlew");
    await fs.chmod(gradle, 0o755);
    const { stdout, stderr } = await execFileAsync(gradle, ["--no-daemon", "assembleDebug"], {
      cwd: project, timeout: 300000, maxBuffer: 5 * 1024 * 1024
    });
    const apk = path.join(project, "app/build/outputs/apk/debug/app-debug.apk");
    await fs.access(apk);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    res.setHeader("Content-Disposition", `attachment; filename="${packageId.split(".").pop()}-debug.apk"`);
    res.setHeader("X-Build-Status", "success");
    res.sendFile(apk, async () => { await fs.rm(work, { recursive: true, force: true }); });
  } catch (e) {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
    res.status(400).json({ error: e.message || "Build failed", details: e.stderr || e.stdout || "" });
  } finally {
    if (req.file?.path) await fs.rm(req.file.path, { force: true }).catch(() => {});
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "VIP MASTER APK BUILDER", androidSdk: process.env.ANDROID_HOME || "not-configured" }));
app.listen(PORT, "0.0.0.0", () => console.log(`VIP Builder listening on ${PORT}`));
