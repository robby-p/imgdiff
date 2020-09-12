#!/usr/bin/env node

const fs = require("fs");
const PNG = require("pngjs").PNG;
const path = require("path");
const pixelmatch = require("pixelmatch");
const getUri = require("get-uri");

function streamToBuffer(stream) {
  let chunks = [];
  return new Promise((rs, rj) => {
    stream.once("end", () => rs(Buffer.concat(chunks)));
    stream.once("error", (err) => rj(err));
    stream.on("data", (chunk) => chunks.push(chunk));
  });
}

async function main(
  _config = {
    diff: "[name].diff.png",
    silent: true,
  }
) {
  const config = {
    ..._config,
    ...process.argv
      .map((a) => a.trim())
      .map((d) => (d.match(/--([\w|-|_]+?)=(.+)/) || []).slice(1, 3))
      .filter((arg) => !!arg.length)
      .reduce((p, [k, v]) => ({ ...p, [k]: v }), {}),
  };

  const log = config.silent !== "false" ? () => {} : console.log.bind(console);
  ["A", "B"].forEach((key) => {
    if (!config[key])
      throw new Error(` '${key}' not specified, use ${key}=<uri>`);
    if (!/[a-z]+?:\/\//.test(config[key])) {
      config[key] = `file://${path.join(__dirname, config[key])}`.replace(
        ":///",
        "://"
      );
    }
  });

  log(`Parsing A: ${config.A} ...`);
  const A = PNG.sync.read(await streamToBuffer(await getUri(config.A)));
  log(`Parsing B: ${config.A} ...`);
  const B = PNG.sync.read(await streamToBuffer(await getUri(config.B)));
  const { width, height } = A;
  const diff = new PNG({ width, height });
  const AName = config.A.split("/").slice(-1)[0].split(".png")[0];
  if (config.diff.includes("[name]")) {
    config.diff = config.diff.replace("[name]", AName);
  }
  pixelmatch(A.data, B.data, diff.data, width, height, { threshold: 0 });
  log(`Saving output: ${config.diff}`);
  fs.writeFileSync(config.diff, PNG.sync.write(diff));
}

if (require.main === module) {
  main();
}
module.exports = main;
