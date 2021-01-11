const fs = require("./fs");
const Minio = require("minio");
const furi = { fileUriToPath: require("file-uri-to-path") };
const path = require("path");
const { saveImgFactory } = require("./helpers");
const PM = { pixelmatch: require("pixelmatch") };
const png = { PNG: require("pngjs").PNG };
const GURI = { getUri: require("get-uri") };

const {
  isFileURI,
  isS3URI,
  log,
  recurseDir,
  getBasename,
  getKeyname,
  streamToBuffer,
  diffName,
  asyncEvent,
} = require("./helpers");

let Differ = {};

async function differ({ HandleA, HandleB, threshold }) {
  log.info(`
🔄 Processing:
    Key: ${HandleA.keyname}
    A: ${HandleA.uri} 
    B: ${HandleB.uri}
  `);
  const A = png.PNG.sync.read(await HandleA.fetch());
  const B = png.PNG.sync.read(await HandleB.fetch());
  const { width, height } = A;
  const diff = new png.PNG({ width, height });
  const pixels = PM.pixelmatch(A.data, B.data, diff.data, width, height, {
    threshold,
  });
  const match = pixels === 0;
  log.info(`${match ? "✅" : "🚫"} Result:
    match: ${match}
    pixels: ${pixels}

  `);

  return {
    pixels,
    match,
    BufferDiff: png.PNG.sync.write(diff),
  };
}
function BatchFilesFactory(uri, config) {
  if (isFileURI(uri)) {
    log.info(`Batch file system processing for ${uri}`);
    return new FileBatch({ ...config, uri });
  } else {
    if (isS3URI(uri)) {
      log.info(`Batch S3 object processing for ${uri}`);
      return new S3Batch({ ...config, uri });
    }
    throw new Error(
      `Invalid URI, only file:// and s3:// uris are supported for batch processing \n given: ${uri} `
    );
  }
}
class BaseBatchFiles {
  constructor({ uri }) {
    this.uri = uri;
    this.collection = new Map();
  }

  async hydrate() {
    const paths = await this.list();
    for (const filePath of paths) {
      const handle = this.HandleFactory(filePath);
      //Being naïve and keying by filename minus extension, this could possibly collide but _should_ be unique hopefully
      this.collection.set(handle.keyname, handle);
    }
    return this.collection;
  }
  HandleFactory() {
    return {}; //implement
  }
  list() {
    return Promise.resolve([]); //implement
  }
}

class Handle {
  constructor(uri) {
    this.uri = uri;
    this.basename = getBasename(uri);
    this.keyname = getKeyname(uri);
  }
  serialize() {
    const { uri, keyname, bucket, path } = this;
    return { uri, keyname, bucket, path };
  }
}

class URIHandle extends Handle {
  constructor(uri) {
    super(uri);
    this.path = furi.fileUriToPath(uri);
  }
  async fetch({ forceFetch = false } = {}) {
    if (!forceFetch && this.buffer) return this.buffer;
    try {
      this.buffer = await streamToBuffer(await GURI.getUri(this.uri));
      return this.buffer;
    } catch (e) {
      if (e.code === "EISDIR") {
        throw new Error(
          "Attempting to run single diff operation on directory, if intended use '--batch' flag"
        );
      }
    }
  }
}
class S3Handle extends Handle {
  constructor(uri, client) {
    super(uri);
    this.client = client;
    this.uri = uri;
    const [bucket, ...pathSplit] = uri.replace("s3://", "").split("/");
    this.bucket = bucket;
    this.path = pathSplit.join("/");
  }
  async fetch({ forceFetch = false } = {}) {
    if (!forceFetch && this.buffer) return this.buffer;
    this.buffer = await streamToBuffer(
      await this.client.getObject(this.bucket, this.path)
    );
    return this.buffer;
  }
}
class S3Batch extends BaseBatchFiles {
  constructor(args) {
    super(args);
    this.bucket = args.uri.split("s3://")[1].split("/")[0];
    if (this.bucket.includes("_")) {
      throw new Error("Bucket names cannot contain underscores");
    }
    this.collection = new Map();
    this.client = new Minio.Client({
      endPoint: args.s3EndPoint,
      useSSL: args.useSSL,
      accessKey: args.s3AccessKey,
      secretKey: args.s3SecretKey,
    });
  }
  HandleFactory(uri) {
    return new S3Handle(uri, this.client);
  }
  async list() {
    const objList = await asyncEvent(
      await this.client.listObjectsV2(this.bucket, "", true, "")
    ).then((objs) => objs.map(({ name }) => `s3://${this.bucket}/${name}`));
    return objList.filter((obj) => obj.endsWith(".png"));
  }
}
class FileBatch extends BaseBatchFiles {
  constructor(args) {
    super(args);
    this.path = furi.fileUriToPath(args.uri);
    return this;
  }
  async list() {
    return Promise.resolve(
      Array.from(recurseDir(this.path))
        .filter((f) => f.endsWith(".png"))
        .map((f) => `file://${f}`)
    );
  }
  HandleFactory(uri) {
    return new URIHandle(uri);
  }
}

async function batchProcess(config) {
  const report = {
    new: [],
    diff: [],
    match: [],
    removed: [],
  };

  const saveImg = saveImgFactory(config);
  const [CollectionA, CollectionB] = await Promise.all(
    ["A", "B"].map((key) => BatchFilesFactory(config[key], config).hydrate())
  );
  for (const key of CollectionB.keys()) {
    if (!CollectionA.has(key)) {
      const HandleB = CollectionB.get(key);
      report.removed.push(HandleB.serialize());
    }
  }
  for (const key of CollectionA.keys()) {
    const HandleA = CollectionA.get(key);
    if (!CollectionB.has(key)) {
      // log.info(`Unsymmetrical file found ${key}`);
      report.new.push(HandleA.serialize());

      if (config.write) {
        await saveImg(HandleA.basename, await HandleA.fetch());
      }
    } else {
      const HandleB = CollectionB.get(key);
      const { BufferDiff, match, pixels } = await Differ.differ({
        ...config,
        HandleA,
        HandleB,
      });
      if (!match) {
        if (config.write && config.diff) {
          const diffFileName = diffName(config.diff, HandleA.basename);
          await saveImg(diffFileName, BufferDiff);
          await saveImg(HandleA.basename, await HandleA.fetch()); //saves new version
        }
        report.diff.push({ ...HandleA.serialize(), pixels });
      } else {
        report.match.push({ ...HandleA.serialize(), pixels });
      }
    }
  }
  return report;
}

Differ = {
  furi,
  PM,
  png,
  differ,
  BatchFilesFactory,
  BaseBatchFiles,
  Handle,
  URIHandle,
  S3Handle,
  GURI,
  S3Batch,
  FileBatch,
  batchProcess,
};

module.exports = Differ;
