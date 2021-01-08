#!/usr/bin/env node

const fs = require("./fs");
const path = require("path");
const DIFFER = require("./differ");
const { tryParse, diffName, isS3URI, writeFile } = require("./helpers");
const { log, saveImgFactory } = require("./helpers");

const DIR = { __dirname: process.cwd() };
const { URIHandle } = DIFFER;

exports.DIR = DIR;
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const defaultConfig = {
  diff: "[name].diff.png",
  write: false,
  jsonReport: "",
  A: "",
  B: "",
  batchCopy: false,
  from: "",
  to: "",
  s3EndPoint: "ceph.squarespace.net",
  s3AccessKey: process.env.S3_ACCESS_KEY || "",
  s3SecretKey: process.env.S3_SECRET_KEY || "",
  exitCode: false,
  useSSL: false,
  threshold: 0.1,
  batch: false,
  silent: true,
};

function parseCLI(args = process.argv) {
  const config = {
    ...args
      .map((a) => a.trim())
      .map((d) => (d.match(/^--([\w|\-|_]+?)=(.+)/) || []).slice(1, 3))
      .reduce((p, [k, v]) => (k ? { ...p, [k]: tryParse(v) } : p), {}),
    ...args
      .map((a) => a.trim())
      .map((d) => (d.match(/^--([\w|\-|_]+?)$/) || []).slice(1))
      .reduce((p, [k]) => (k ? { ...p, [k]: true } : p), {}),
  };
  return config;
}
exports.parseCLI = parseCLI;
function protocolify(p) {
  if (!/^[\w]+?:\/\//.test(p)) return `file://${path.join(DIR.__dirname, p)}`;
  return p;
}

exports.protocolify = protocolify;
async function exec(_config = {}) {
  const config = {
    ...defaultConfig,
    ..._config,
  };
  log.silent(!!_config.silent);
  const protocolifyConfigKey = (key, required = true) => {
    if (required && !config[key]) {
      throw new Error(` '${key}' not specified, use --${key}=<uri>`);
    } else {
      return protocolify(config[key]);
    }
  };

  if (config.batchCopy) {
    for (const key of ["from", "to"]) {
      config[key] = protocolifyConfigKey(key);
    }
    return batchCopy(config);
  }

  for (const key of ["A", "B"]) {
    config[key] = protocolifyConfigKey(key);
  }
  config.write = config.write
    ? protocolifyConfigKey("write", false)
    : config.write;

  return config.batch ? runBatch(config) : runSingle(config);
}

async function batchCopy(config) {
  const CollectionA = await DIFFER.BatchFilesFactory(
    config["from"],
    config
  ).hydrate();
  const saveImg = saveImgFactory(config, "to");
  for (const handle of CollectionA.values()) {
    await saveImg(handle.basename, await handle.fetch());
  }
}
async function runBatch(config) {
  const getKeyNames = (handles) =>
    handles.map((h) => `'${h.keyname}'`).join(",\n           ");
  const report = await DIFFER.batchProcess(config);
  log.info(`📊 Batch Total Report
    match: [${getKeyNames(report.match)}]
    diff: [${getKeyNames(report.diff)}]
    removed: [${getKeyNames(report.removed)}]
    new: [${getKeyNames(report.new)}]

  `);
  if (config.jsonReport) {
    const reportString = JSON.stringify(report, null, 4);
    const jsonReportFiles = config.jsonReport
      .split(",")
      .map((jr) => jr.trim())
      .filter(Boolean);
    for (const jsonReport of jsonReportFiles) {
      await writeFile(protocolify(jsonReport), reportString, config);
      log.info(`👉 written to: ${jsonReport}`);
    }
  }
  return report;
}
exports.batchCopy = batchCopy;

async function runSingle(config) {
  if (isS3URI(config.A) || isS3URI(config.B)) {
    throw new Error("Single can only be ran locally");
  }
  const HandleA = new URIHandle(config.A);
  const HandleB = new URIHandle(config.B);
  const { BufferDiff } = await DIFFER.differ({
    ...config,
    HandleA,
    HandleB,
  });
  if (config.write) {
    const outName = diffName(config.diff, HandleA.basename);
    log(`Writing to: ${outName}`);
    fs.writeFileSync(outName, BufferDiff);
  }
}

exports.runSingle = runSingle;

process.on("unhandledRejection", (error) => {
  // Will print "unhandledRejection err is not defined"
  console.error("unhandledRejection", error);
});

//---------------------------------------------

// @ts-ignore
if (require.main === module) {
  exec({ ...parseCLI(), silent: false });
}
exports.exec = exec;
