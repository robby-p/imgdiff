const fs = require("./fs");
const Minio = require("minio");
const furi = { fileUriToPath: require("file-uri-to-path") };
const path = require("path");
class Log {
  constructor() {
    this._silent = false;
  }
  silent(b) {
    this._silent = b;
  }
  info(...args) {
    if (!this._silent) console.log(...args);
  }
}

const log = new Log();

function getBasename(filepath) {
  return filepath.split("/").slice(-1)[0];
}
function getKeyname(filepath) {
  return filepath.split("/").slice(-1)[0].replace(/.png$/, "");
}
function isFileURI(uri) {
  return uri.startsWith("file://");
}
function isNonProtocol(uri) {
  //assume local file path?
  if (!/^[\w]+?:\/\//.test(uri)) return `file://${uri}`;
}

function asyncEvent(emitter) {
  let chunks = [];
  return new Promise((rs, rj) => {
    emitter.once("end", () => rs(chunks));
    emitter.once("error", (err) => rj(err));
    emitter.on("data", (chunk) => chunks.push(chunk));
  });
}
function streamToBuffer(stream) {
  return asyncEvent(stream).then((chunks) => Buffer.concat(chunks));
}

function diffName(pattern, name) {
  return pattern.replace("[name]", name.replace(/.png$/, ""));
}

function isS3URI(uri) {
  return uri.startsWith("s3://");
}

function tryParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return str;
  }
}

function recurseDir(dir) {
  return fs
    .readdirSync(dir)
    .reduce(
      (p, n) => [
        ...p,
        path.join(dir, n),
        ...(fs.statSync(path.join(dir, n)).isDirectory()
          ? recurseDir(path.join(dir, n))
          : []),
      ],
      []
    );
}

async function writeFile(uriPath, content, config) {
  if (isFileURI(uriPath)) {
    fs.writeFileSync(furi.fileUriToPath(uriPath), content);
  }
  if (isS3URI(uriPath)) {
    const [bucket, ..._dir] = uriPath.split("s3://")[1].split("/");
    const dir = _dir.join("/");

    const contentType = uriPath.endsWith(".json")
      ? "application/json"
      : uriPath.endsWith(".png")
      ? "image/png"
      : undefined;
    const minioClient = new Minio.Client({
      endPoint: config.s3EndPoint,
      useSSL: config.useSSL,
      accessKey: config.s3AccessKey,
      secretKey: config.s3SecretKey,
    });
    let opts = {
      "x-amz-acl": "public-read",
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
    await minioClient.putObject(bucket, dir, content, opts);
  }
}

const saveImgFactory = (config, outputKeying = "write") => async (
  name,
  buffer
) => {
  const fullPath = `${config[outputKeying].replace(/\/$/, "")}/${name.replace(
    /^\//,
    ""
  )}`;
  log.info(`Saving ${name} to ${fullPath}`);
  await writeFile(fullPath, buffer, config);
};
module.exports = {
  getBasename,
  getKeyname,
  writeFile,
  isFileURI,
  log,
  asyncEvent,
  saveImgFactory,
  streamToBuffer,
  diffName,
  isNonProtocol,
  isS3URI,
  tryParse,
  recurseDir,
};
