#!/usr/bin/env node

const fs = require("./fs");
const path = require("path");
const { URIHandle } = require("./differ");
const DIFFER = require("./differ");
const { tryParse, diffName, isS3URI, writeFile } = require("./helpers");
const { log } = require("./helpers");
const DIR = { __dirname: process.cwd() };

exports.DIR = DIR;
// process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const defaultConfig = {
  diff: "[name].diff.png",
  write: false,
  jsonReport: "",
  A: "",
  B: "",
  s3EndPoint: "ceph.squarespace.net",
  s3AccessKey: process.env.S3_ACCESS_KEY || "",
  s3SecretKey: process.env.S3_SECRET_KEY || "",
  exitCode: true,
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

  //make sense of cli params, coercing to file:// as protocol default
  for (const key of ["A", "B"]) {
    if (!config[key]) {
      throw new Error(` '${key}' not specified, use --${key}=<uri>`);
    }
    config[key] = protocolify(config[key]);
  }
  if (config.write && typeof config.write === "string") {
    config.write = protocolify(config.write);
  }
  return config.batch ? runBatch(config) : runSingle(config);
}

async function runBatch(config) {
  const getkeynames = (handles) =>
    handles.map((h) => `'${h.keyname}'`).join(",\n           ");
  const report = await DIFFER.batchProcess(config);
  log.info(`📊 Batch Total Report
    match: [${getkeynames(report.match)}]
    diff: [${getkeynames(report.diff)}]
    removed: [${getkeynames(report.removed)}]
    new: [${getkeynames(report.new)}]

 ${config.jsonReport ? `👉 written to: ${config.jsonReport}` : ""}
  `);
  if (config.jsonReport) {
    const reportString = JSON.stringify(report, null, 4);
    await writeFile(protocolify(config.jsonReport), reportString, config);
  }
  return report;
}

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
