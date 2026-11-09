
import express from "express";
import helmet from "helmet";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.BUILDER_API_KEY || "";

const FRONTEND = path.resolve(__dirname, "../frontend");
const TEMPLATE = path.join(__dirname, "template");

const GRADLE = process.env.GRADLE_BIN || "/opt/gradle-8.7/bin/gradle";
const MAX_BUILD_TIME = 8 * 60 * 1000;
const MAX_LOGS = 200;
const MAX_LOG_SIZE = 3000;

const builds = new Map();
let buildRunning = false;

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  }
}));

app.use(express.static(FRONTEND));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND, "index.html"));
});

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1
  }
});

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ""));
  const y = Buffer.from(String(b || ""));
  return x.length === y.length && timingSafeEqual(x, y);
}

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "BUILDER_API_KEY सेट नहीं है।"
    });
  }

  if (!safeEqual(req.get("x-builder-key"), API_KEY)) {
    return res.status(401).json({
      error: "API Key गलत है।"
    });
  }

  next();
}

function safeName(value, fallback) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .slice(0, 40) || fallback;
}

function safePackage(value) {
  const p = String(value || "com.vipmaster.generated").trim();

  if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/.test(p)) {
    throw new Error("Invalid Package ID");
  }

  return p;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function addLog(id, message) {
  const item = builds.get(id);
  if (!item) return;

  for (const line of String(message || "").split(/\r?\n/)) {
    if (!line.trim()) continue;

    item.logs.push({
      time: new Date().toISOString(),
      message: line.slice(0, MAX_LOG_SIZE)
    });
  }

  if (item.logs.length > MAX_LOGS) {
    item.logs = item.logs.slice(-MAX_LOGS);
  }
}

async function extractZipSafely(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > 500) {
    throw new Error("ZIP में 500 से अधिक फाइलें हैं।");
  }

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");

    if (
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      throw new Error("Unsafe ZIP path मिला।");
    }

    if (entry.isDirectory) continue;

    const target = path.resolve(destination, name);

    if (!target.startsWith(path.resolve(destination) + path.sep)) {
      throw new Error("Invalid ZIP path");
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.getData());
  }
}

async function writeProject(work, html, appName, packageId) {
  await fs.access(TEMPLATE);

  const project = path.join(work, "project");

  await fs.cp(TEMPLATE, project, { recursive: true });

  const appDir = path.join(project, "app");
  const assets = path.join(appDir, "src/main/assets");

  await fs.mkdir(assets, { recursive: true });

  if (html) {
    await fs.writeFile(
      path.join(assets, "index.html"),
      html,
      "utf8"
    );
  } else {
    const extracted = path.join(work, "uploaded");

    await fs.mkdir(extracted, { recursive: true });

    await extractZipSafely(
      path.join(work, "upload.zip"),
      extracted
    );

    let root = extracted;

    try {
      await fs.access(path.join(root, "index.html"));
    } catch {
      const items = await fs.readdir(root, { withFileTypes: true });

      if (items.length === 1 && items[0].isDirectory()) {
        root = path.join(root, items[0].name);
      }
    }

    await fs.access(path.join(root, "index.html"));
    await fs.cp(root, assets, { recursive: true });
  }

  const javaRoot = path.join(appDir, "src/main/java");
  const oldJava = path.join(
    javaRoot,
    "com/vipmaster/generated/MainActivity.java"
  );

  let java = await fs.readFile(oldJava, "utf8");

  java = java.replace(
    "package com.vipmaster.generated;",
    "package " + packageId + ";"
  );

  const packagePath = path.join(javaRoot, ...packageId.split("."));

  await fs.mkdir(packagePath, { recursive: true });

  await fs.writeFile(
    path.join(packagePath, "MainActivity.java"),
    java
  );

  await fs.rm(path.join(javaRoot, "com"), {
    recursive: true,
    force: true
  });

  const manifestPath = path.join(
    appDir,
    "src/main/AndroidManifest.xml"
  );

  let manifest = await fs.readFile(manifestPath, "utf8");

  manifest = manifest
    .replaceAll("__PACKAGE_ID__", packageId)
    .replaceAll("__APP_LABEL__", escapeXml(appName));

  await fs.writeFile(manifestPath, manifest);

  const gradlePath = path.join(appDir, "build.gradle");

  let gradle = await fs.readFile(gradlePath, "utf8");

  gradle = gradle.replaceAll("__PACKAGE_ID__", packageId);

  await fs.writeFile(gradlePath, gradle);

  return project;
}

function runGradle(id, project) {
  return new Promise((resolve, reject) => {
    let output = "";
    let finished = false;

    const args = [
      "--no-daemon",
      "--max-workers=1",
      "--console=plain",
      "--stacktrace",
      "assembleDebug"
    ];

    const env = {
      ...process.env,
      JAVA_TOOL_OPTIONS: [
        process.env.JAVA_TOOL_OPTIONS || "",
        "-Xms128m",
        "-Xmx512m",
        "-XX:MaxMetaspaceSize=256m",
        "-Dfile.encoding=UTF-8"
      ].filter(Boolean).join(" ")
    };

    const child = spawn(GRADLE, args, {
      cwd: project,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      addLog(id, "Build timeout: 8 मिनट पूरे हुए।");
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5000).unref();

      finish(new Error("Build timeout"));
    }, MAX_BUILD_TIME);

    function finish(error, code) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (error) {
        error.stdout = output;
        reject(error);
      } else if (code !== 0) {
        const err = new Error("Gradle exit code: " + code);
        err.stdout = output;
        reject(err);
      } else {
        resolve(output);
      }
    }

    function receive(data) {
      const chunk = data.toString();

      output += chunk;

      if (output.length > 500000) {
        output = output.slice(-500000);
      }

      addLog(id, chunk);
    }

    child.stdout.on("data", receive);
    child.stderr.on("data", receive);

    child.on("error", error => finish(error));

    child.on("close", code => {
      finish(
        code === 0 ? null : new Error("Gradle process failed"),
        code
      );
    });
  });
}

app.post(
  "/api/build",
  upload.single("projectFile"),
  requireKey,
  async (req, res) => {

    if (buildRunning) {
      if (req.file?.path) {
        await fs.rm(req.file.path, { force: true });
      }

      return res.status(429).json({
        error: "दूसरा Build पहले से चल रहा है। कृपया इंतजार करें।"
      });
    }

    buildRunning = true;

    const id = randomUUID();
    const work = path.join(os.tmpdir(), "vip-build-" + id);

    const item = {
      status: "starting",
      logs: [],
      error: null,
      apk: null,
      work: null,
      createdAt: Date.now()
    };

    builds.set(id, item);

    res.status(202).json({
      buildId: id,
      status: "starting"
    });

    try {
      await fs.mkdir(work, { recursive: true });

      const appName = safeName(req.body.appName, "VIP HTML App");
      const packageId = safePackage(req.body.packageId);

      let html = String(req.body.html || "");

      if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) {
        throw new Error("HTML 2 MB से बड़ी है।");
      }

      if (req.file) {
        const ext = path.extname(req.file.originalname).toLowerCase();

        if (ext === ".zip") {
          await fs.copyFile(req.file.path, path.join(work, "upload.zip"));
          html = "";
        } else if (ext === ".html" || ext === ".htm") {
          html = await fs.readFile(req.file.path, "utf8");
        } else {
          throw new Error("केवल HTML या ZIP फाइल अपलोड करें।");
        }
      }

      if (!html && !req.file) {
        throw new Error("HTML या ZIP फाइल आवश्यक है।");
      }

      addLog(id, "HTML प्राप्त हो गई।");
      item.status = "project";

      addLog(id, "Android Project तैयार हो रहा है।");

      const project = await writeProject(
        work,
        html,
        appName,
        packageId
      );

      item.status = "gradle";

      addLog(id, "System Gradle 8.7 Build शुरू हुआ।");

      await runGradle(id, project);

      const apk = path.join(
        project,
        "app/build/outputs/apk/debug/app-debug.apk"
      );

      await fs.access(apk);

      item.apk = apk;
      item.work = work;
      item.status = "success";

      addLog(id, "BUILD SUCCESSFUL");
      addLog(id, "APK सफलतापूर्वक तैयार हुई।");

    } catch (error) {
      console.error("BUILD ERROR:", error);

      item.status = "failed";
      item.error = error.message || "Build Failed";

      addLog(id, "BUILD FAILED: " + item.error);

      if (error.stdout) addLog(id, error.stdout);

      await fs.rm(work, {
        recursive: true,
        force: true
      }).catch(() => {});

    } finally {
      if (req.file?.path) {
        await fs.rm(req.file.path, { force: true }).catch(() => {});
      }

      buildRunning = false;
    }
  }
);

app.get("/api/build/:id", requireKey, (req, res) => {
  const item = builds.get(req.params.id);

  if (!item) {
    return res.status(404).json({
      error: "Build ID नहीं मिला।"
    });
  }

  res.json({
    status: item.status,
    logs: item.logs,
    error: item.error
  });
});

app.get("/api/download/:id", requireKey, async (req, res) => {
  const id = req.params.id;
  const item = builds.get(id);

  if (!item || item.status !== "success" || !item.apk) {
    return res.status(404).json({
      error: "APK अभी तैयार नहीं है।"
    });
  }

  try {
    await fs.access(item.apk);

    res.download(item.apk, "VIP-MASTER.apk", async error => {
      if (error) {
        console.error("Download error:", error);
        return;
      }

      await fs.rm(item.work, {
        recursive: true,
        force: true
      }).catch(() => {});

      builds.delete(id);
    });

  } catch {
    res.status(404).json({
      error: "APK फाइल नहीं मिली।"
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "VIP MASTER APK BUILDER",
    gradle: GRADLE,
    java: process.env.JAVA_HOME || "system",
    activeBuild: buildRunning
  });
});

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found"
  });
});

app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: error.message || "Internal Server Error"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("VIP MASTER APK BUILDER running on port " + PORT);
});
