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
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.BUILDER_API_KEY || "";

const FRONTEND_DIR = path.resolve(__dirname, "../frontend");
const TEMPLATE_DIR = path.join(__dirname, "template");

// -------------------------------------
// SECURITY + FRONTEND
// -------------------------------------

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        ...helmet.contentSecurityPolicy.getDefaultDirectives(),
        "script-src": ["'self'", "'unsafe-inline'"],
        "style-src": ["'self'", "'unsafe-inline'"]
      }
    },
    crossOriginResourcePolicy: {
      policy: "cross-origin"
    }
  })
);

app.use(express.static(FRONTEND_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// -------------------------------------
// FILE UPLOAD
// -------------------------------------

const upload = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 20 * 1024 * 1024,
    files: 1
  }
});

// -------------------------------------
// API KEY CHECK
// -------------------------------------

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));

  if (aa.length !== bb.length) {
    return false;
  }

  return timingSafeEqual(aa, bb);
}

function requireKey(req, res, next) {
  if (!API_KEY) {
    return res.status(503).json({
      error: "Server पर BUILDER_API_KEY सेट नहीं है।"
    });
  }

  const key = req.get("x-builder-key") || "";

  if (!safeEqual(key, API_KEY)) {
    return res.status(401).json({
      error: "API key गलत है।"
    });
  }

  next();
}

// -------------------------------------
// APP NAME VALIDATION
// -------------------------------------

function safeName(value, fallback) {
  const name = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._ -]/g, "")
    .slice(0, 40);

  return name || fallback;
}

// -------------------------------------
// PACKAGE NAME VALIDATION
// -------------------------------------

function safePackage(value) {
  const packageId = String(
    value || "com.vipmaster.generated"
  ).trim();

  const valid =
    /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*){1,5}$/
      .test(packageId);

  if (!valid) {
    throw new Error(
      "Package ID गलत है। उदाहरण: com.example.mygame"
    );
  }

  return packageId;
}

// -------------------------------------
// XML ESCAPE
// -------------------------------------

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// -------------------------------------
// SAFE ZIP EXTRACTION
// -------------------------------------

async function extractZipSafely(zipPath, destination) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > 500) {
    throw new Error(
      "ZIP में 500 से ज्यादा फाइलें हैं।"
    );
  }

  for (const entry of entries) {
    const name = entry.entryName.replace(/\\/g, "/");

    if (
      name.startsWith("/") ||
      name.split("/").includes("..")
    ) {
      throw new Error(
        "ZIP में unsafe file path मिला।"
      );
    }

    if (entry.isDirectory) {
      continue;
    }

    const target = path.resolve(destination, name);
    const base = path.resolve(destination) + path.sep;

    if (!target.startsWith(base)) {
      throw new Error(
        "ZIP में invalid file path मिला।"
      );
    }

    await fs.mkdir(path.dirname(target), {
      recursive: true
    });

    await fs.writeFile(
      target,
      entry.getData()
    );
  }
}

// -------------------------------------
// CREATE ANDROID PROJECT
// -------------------------------------

async function writeProject(
  work,
  html,
  appName,
  packageId
) {
  const project = path.join(work, "project");

  // Template check
  await fs.access(TEMPLATE_DIR);

  // Copy Android template
  await fs.cp(TEMPLATE_DIR, project, {
    recursive: true
  });

  const appDir = path.join(project, "app");

  const assets = path.join(
    appDir,
    "src",
    "main",
    "assets"
  );

  await fs.mkdir(assets, {
    recursive: true
  });

  // ---------------------------------
  // HTML OR ZIP
  // ---------------------------------

  if (html) {
    await fs.writeFile(
      path.join(assets, "index.html"),
      html,
      "utf8"
    );
  } else {
    const extracted = path.join(
      work,
      "uploaded"
    );

    await fs.mkdir(extracted, {
      recursive: true
    });

    await extractZipSafely(
      path.join(work, "upload.zip"),
      extracted
    );

    let sourceRoot = extracted;

    try {
      await fs.access(
        path.join(extracted, "index.html")
      );
    } catch {
      const items = await fs.readdir(
        extracted,
        { withFileTypes: true }
      );

      if (
        items.length === 1 &&
        items[0].isDirectory()
      ) {
        sourceRoot = path.join(
          extracted,
          items[0].name
        );
      }
    }

    try {
      await fs.access(
        path.join(sourceRoot, "index.html")
      );
    } catch {
      throw new Error(
        "ZIP के root या एक अंदरूनी folder में index.html नहीं मिली।"
      );
    }

    await fs.cp(sourceRoot, assets, {
      recursive: true
    });
  }

  // ---------------------------------
  // JAVA PACKAGE UPDATE
  // ---------------------------------

  const javaRoot = path.join(
    appDir,
    "src",
    "main",
    "java"
  );

  const oldJavaSource = path.join(
    javaRoot,
    "com",
    "vipmaster",
    "generated",
    "MainActivity.java"
  );

  const packagePath = path.join(
    javaRoot,
    ...packageId.split(".")
  );

  await fs.access(oldJavaSource);

  await fs.mkdir(packagePath, {
    recursive: true
  });

  let javaCode = await fs.readFile(
    oldJavaSource,
    "utf8"
  );

  javaCode = javaCode.replace(
    "package com.vipmaster.generated;",
    "package " + packageId + ";"
  );

  await fs.writeFile(
    path.join(packagePath, "MainActivity.java"),
    javaCode,
    "utf8"
  );

  await fs.rm(
    path.join(javaRoot, "com"),
    {
      recursive: true,
      force: true
    }
  );

  // ---------------------------------
  // ANDROID MANIFEST UPDATE
  // ---------------------------------

  const manifestPath = path.join(
    appDir,
    "src",
    "main",
    "AndroidManifest.xml"
  );

  let manifest = await fs.readFile(
    manifestPath,
    "utf8"
  );

  manifest = manifest
    .replaceAll(
      "__PACKAGE_ID__",
      packageId
    )
    .replaceAll(
      "__APP_LABEL__",
      escapeXml(appName)
    );

  await fs.writeFile(
    manifestPath,
    manifest,
    "utf8"
  );

  // ---------------------------------
  // GRADLE PACKAGE UPDATE
  // ---------------------------------

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
    gradle,
    "utf8"
  );

  return project;
}

// -------------------------------------
// BUILD APK API
// -------------------------------------

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

      let html = String(
        req.body.html || ""
      );

      if (
        Buffer.byteLength(html, "utf8") >
        2 * 1024 * 1024
      ) {
        throw new Error(
          "Pasted HTML 2 MB से बड़ी है।"
        );
      }

      // Uploaded file
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
          ext === ".html" ||
          ext === ".htm" ||
          ext === ".txt"
        ) {
          html = await fs.readFile(
            req.file.path,
            "utf8"
          );
        } else {
          throw new Error(
            "केवल .html या .zip फाइल अपलोड करें।"
          );
        }
      }

      if (!html && !req.file) {
        throw new Error(
          "HTML paste करें या HTML/ZIP file upload करें।"
        );
      }

      // Create project
      const project = await writeProject(
        work,
        html,
        appName,
        packageId
      );

      // ---------------------------------
      // GRADLE BUILD
      // ---------------------------------

      const gradle = path.join(
        project,
        "gradlew"
      );

      await fs.chmod(
        gradle,
        0o755
      );

      const result = await execFileAsync(
        gradle,
        [
          "--no-daemon",
          "assembleDebug"
        ],
        {
          cwd: project,
          timeout: 300000,
          maxBuffer: 5 * 1024 * 1024
        }
      );

      const apk = path.join(
        project,
        "app",
        "build",
        "outputs",
        "apk",
        "debug",
        "app-debug.apk"
      );

      await fs.access(apk);

      // ---------------------------------
      // APK DOWNLOAD
      // ---------------------------------

      res.setHeader(
        "Content-Type",
        "application/vnd.android.package-archive"
      );

      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${packageId.split(".").pop()}-debug.apk"`
      );

      res.setHeader(
        "X-Build-Status",
        "success"
      );

      res.sendFile(
        apk,
        async (error) => {
          await fs.rm(work, {
            recursive: true,
            force: true
          }).catch(() => {});

          if (error) {
            console.error(
              "APK download error:",
              error.message
            );
          }
        }
      );

    } catch (error) {
      console.error(
        "APK BUILD ERROR:",
        error
      );

      await fs.rm(work, {
        recursive: true,
        force: true
      }).catch(() => {});

      if (!res.headersSent) {
        res.status(400).json({
          error: error.message || "Build failed",
          details:
            error.stderr ||
            error.stdout ||
            ""
        });
      }

    } finally {
      if (req.file?.path) {
        await fs.rm(
          req.file.path,
          { force: true }
        ).catch(() => {});
      }
    }
  }
);

// -------------------------------------
// HEALTH CHECK
// -------------------------------------

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      ok: true,
      service: "VIP MASTER APK BUILDER",
      androidSdk:
        process.env.ANDROID_HOME || "not-configured",
      api: "/api/build"
    });
  }
);

// -------------------------------------
// UNKNOWN API ROUTES
// -------------------------------------

app.use("/api", (req, res) => {
  res.status(404).json({
    error: "API route not found",
    requested: req.originalUrl
  });
});

// -------------------------------------
// SERVER START
// -------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `VIP MASTER APK BUILDER running on port ${PORT}`
    );
  }
);
