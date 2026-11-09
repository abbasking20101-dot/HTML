
import express from "express";
import helmet from "helmet";
import multer from "multer";
import AdmZip from "adm-zip";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.BUILDER_API_KEY || "";

const FRONTEND = path.resolve(__dirname, "../frontend");
const TEMPLATE = path.join(__dirname, "template");

const builds = new Map();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      "script-src": ["'self'", "'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  },
  crossOriginResourcePolicy: { policy: "cross-origin" }
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
      error: "BUILDER_API_KEY server environment में सेट नहीं है।"
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
    throw new Error(
      "गलत Package ID। उदाहरण: com.example.mygame"
    );
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

  const lines = String(message || "")
    .split(/\r?\n/)
    .filter(line => line.trim());

  for (const line of lines) {
    item.logs.push({
      time: new Date().toISOString(),
      message: line.slice(0, 3000)
    });
  }

  if (item.logs.length > 200) {
    item.logs = item.logs.slice(-200);
  }
}

async function extractZipSafely(zipPath, dest) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > 500) {
    throw new Error("ZIP में 500 से ज्यादा फाइलें हैं।");
  }

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");

    if (
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      throw new Error("ZIP में unsafe file path मिला।");
    }

    if (entry.isDirectory) continue;

    const target = path.resolve(dest, name);

    if (!target.startsWith(path.resolve(dest) + path.sep)) {
      throw new Error("ZIP में invalid file path मिला।");
    }

    await fs.mkdir(path.dirname(target), {
      recursive: true
    });

    await fs.writeFile(target, entry.getData());
  }
}

async function writeProject(work, html, appName, packageId) {
  await fs.access(TEMPLATE);

  const project = path.join(work, "project");

  await fs.cp(TEMPLATE, project, {
    recursive: true
  });

  const appDir = path.join(project, "app");

  const assets = path.join(
    appDir,
    "src/main/assets"
  );

  await fs.mkdir(assets, {
    recursive: true
  });

  if (html) {
    await fs.writeFile(
      path.join(assets, "index.html"),
      html,
      "utf8"
    );
  } else {
    const extracted = path.join(work, "uploaded");

    await fs.mkdir(extracted, {
      recursive: true
    });

    await extractZipSafely(
      path.join(work, "upload.zip"),
      extracted
    );

    let root = extracted;

    try {
      await fs.access(path.join(root, "index.html"));
    } catch {
      const items = await fs.readdir(root, {
        withFileTypes: true
      });

      if (
        items.length === 1 &&
        items[0].isDirectory()
      ) {
        root = path.join(root, items[0].name);
      }
    }

    await fs.access(
      path.join(root, "index.html")
    ).catch(() => {
      throw new Error("ZIP में index.html नहीं मिली।");
    });

    await fs.cp(root, assets, {
      recursive: true
    });
  }

  const javaRoot = path.join(
    appDir,
    "src/main/java"
  );

  const oldJava = path.join(
    javaRoot,
    "com/vipmaster/generated/MainActivity.java"
  );

  await fs.access(oldJava);

  const packagePath = path.join(
    javaRoot,
    ...packageId.split(".")
  );

  await fs.mkdir(packagePath, {
    recursive: true
  });

  let java = await fs.readFile(oldJava, "utf8");

  java = java.replace(
    "package com.vipmaster.generated;",
    "package " + packageId + ";"
  );

  await fs.writeFile(
    path.join(packagePath, "MainActivity.java"),
    java
  );

  await fs.rm(
    path.join(javaRoot, "com"),
    {
      recursive: true,
      force: true
    }
  );

  const manifestPath = path.join(
    appDir,
    "src/main/AndroidManifest.xml"
  );

  let manifest = await fs.readFile(
    manifestPath,
    "utf8"
  );

  manifest = manifest
    .replaceAll("__PACKAGE_ID__", packageId)
    .replaceAll("__APP_LABEL__", escapeXml(appName));

  await fs.writeFile(
    manifestPath,
    manifest
  );

  const gradlePath = path.join(
    appDir,
    "build.gradle"
  );

  let gradle = await fs.readFile(
    gradlePath,
    "utf8"
  );

  gradle = gradle.replaceAll(
    "__PACKAGE_ID__",
    packageId
  );

  await fs.writeFile(
    gradlePath,
    gradle
  );

  return project;
}

// Gradle process और उसके वास्तविक output को पढ़ना
function runGradle(id, gradle, project) {
  return new Promise((resolve, reject) => {
    let output = "";
    let finished = false;

    const child = spawn(
      gradle,
      [
        "--no-daemon",
        "assembleDebug",
        "--console=plain",
        "--stacktrace"
      ],
      {
        cwd: project,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    const timer = setTimeout(() => {
      child.kill("SIGTERM");

      setTimeout(() => {
        if (!finished) child.kill("SIGKILL");
      }, 5000).unref();

      finish(
        new Error("Gradle Build timeout: 8 मिनट पूरे हो गए।")
      );
    }, 8 * 60 * 1000);

    function finish(error, code = 0) {
      if (finished) return;

      finished = true;
      clearTimeout(timer);

      if (error) {
        error.stdout = output;
        reject(error);
      } else if (code !== 0) {
        const err = new Error(
          "Gradle Build Failed. Exit Code: " + code
        );

        err.stdout = output;
        reject(err);
      } else {
        resolve(output);
      }
    }

    child.stdout.on("data", data => {
      const text = data.toString();

      output += text;

      if (output.length > 500000) {
        output = output.slice(-500000);
      }

      addLog(id, text);
    });

    child.stderr.on("data", data => {
      const text = data.toString();

      output += text;

      if (output.length > 500000) {
        output = output.slice(-500000);
      }

      addLog(id, text);
    });

    child.on("error", error => {
      finish(error);
    });

    child.on("close", code => {
      finish(
        code === 0
          ? null
          : new Error("Gradle process बंद हो गया।"),
        code
      );
    });
  });
}

// BUILD API
app.post(
  "/api/build",
  upload.single("projectFile"),
  requireKey,
  async (req, res) => {
    const id = randomUUID();

    const work = path.join(
      os.tmpdir(),
      "vip-build-" + id
    );

    builds.set(id, {
      status: "starting",
      logs: [],
      error: null,
      apk: null,
      work: null,
      createdAt: new Date().toISOString()
    });

    // पहला और एकमात्र HTTP response
    res.status(202).json({
      buildId: id,
      status: "starting",
      message: "Build शुरू हो रहा है।"
    });

    try {
      await fs.mkdir(work, {
        recursive: true
      });

      const appName = safeName(
        req.body.appName,
        "VIP HTML App"
      );

      const packageId = safePackage(
        req.body.packageId
      );

      let html = String(req.body.html || "");

      if (Buffer.byteLength(html, "utf8") > 2 * 1024 * 1024) {
        throw new Error("Pasted HTML 2 MB से बड़ी है।");
      }

      if (req.file) {
        const ext = path.extname(
          req.file.originalname
        ).toLowerCase();

        if (ext === ".zip") {
          await fs.copyFile(
            req.file.path,
            path.join(work, "upload.zip")
          );

          html = "";
        } else if (
          [".html", ".htm"].includes(ext)
        ) {
          html = await fs.readFile(
            req.file.path,
            "utf8"
          );
        } else {
          throw new Error(
            "केवल HTML या ZIP फाइल अपलोड करें।"
          );
        }
      }

      if (!html && !req.file) {
        throw new Error("HTML या ZIP फाइल दें।");
      }

      addLog(id, "HTML प्राप्त हो गई।");

      builds.get(id).status = "project";

      addLog(
        id,
        "Android Project तैयार किया जा रहा है।"
      );

      const project = await writeProject(
        work,
        html,
        appName,
        packageId
      );

      builds.get(id).status = "gradle";

      addLog(id, "Gradle APK Build शुरू हुआ।");

      const gradle = path.join(
        project,
        "gradlew"
      );

      await fs.chmod(gradle, 0o755);

      await runGradle(id, gradle, project);

      const apk = path.join(
        project,
        "app/build/outputs/apk/debug/app-debug.apk"
      );

      await fs.access(apk);

      const item = builds.get(id);

      if (!item) {
        throw new Error(
          "Build Status उपलब्ध नहीं है।"
        );
      }

      item.apk = apk;
      item.work = work;
      item.status = "success";

      addLog(
        id,
        "APK सफलतापूर्वक तैयार हो गई।"
      );

    } catch (error) {
      console.error("BUILD ERROR:", error);

      const item = builds.get(id);

      if (item) {
        item.status = "failed";
        item.error = error.message || "Build failed";

        addLog(id, "BUILD ERROR: " + item.error);

        if (error.stdout) {
          addLog(id, error.stdout);
        }

        if (error.stderr) {
          addLog(id, error.stderr);
        }
      }

      await fs.rm(work, {
        recursive: true,
        force: true
      }).catch(() => {});

    } finally {
      if (req.file?.path) {
        await fs.rm(req.file.path, {
          force: true
        }).catch(() => {});
      }
    }
  }
);

// BUILD STATUS API
app.get(
  "/api/build/:id",
  requireKey,
  (req, res) => {
    const item = builds.get(req.params.id);

    if (!item) {
      return res.status(404).json({
        error: "Build ID नहीं मिला। सर्वर Restart हुआ हो सकता है।"
      });
    }

    res.json({
      status: item.status,
      logs: item.logs,
      error: item.error
    });
  }
);

// APK DOWNLOAD API
app.get(
  "/api/download/:id",
  requireKey,
  async (req, res) => {
    const item = builds.get(req.params.id);

    if (
      !item ||
      item.status !== "success" ||
      !item.apk
    ) {
      return res.status(404).json({
        error: "APK अभी उपलब्ध नहीं है।"
      });
    }

    try {
      await fs.access(item.apk);

      res.download(
        item.apk,
        "VIP-MASTER.apk",
        async error => {
          if (error) {
            console.error("DOWNLOAD ERROR:", error);
            return;
          }

          await fs.rm(item.work, {
            recursive: true,
            force: true
          }).catch(() => {});

          builds.delete(req.params.id);
        }
      );

    } catch (error) {
      res.status(404).json({
        error: "APK फाइल नहीं मिली।"
      });
    }
  }
);

// HEALTH CHECK
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "VIP MASTER APK BUILDER",
    androidSdk: process.env.ANDROID_HOME || "not-configured"
  });
});

// API 404
app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    requested: req.originalUrl
  });
});

// GLOBAL ERROR HANDLER
app.use((error, req, res, next) => {
  console.error("SERVER ERROR:", error);

  if (res.headersSent) return next(error);

  res.status(500).json({
    error: error.message || "Internal Server Error"
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "VIP MASTER APK BUILDER running on port " + PORT
  );
});
      
