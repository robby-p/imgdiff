const DIFFER = require("../differ");
const imgdiff = require("../main");
const helpers = require("../helpers");
const minio = require("minio");
const { EventEmitter } = require("events");
const fs = require("../fs");
const fakeDataStream = (..._data) => {
  const data = [].concat(_data);
  const ee = new EventEmitter();
  process.nextTick(() => {
    data.forEach((d) => ee.emit("data", d));
    ee.emit("end");
  });

  return ee;
};

const mockReaddirSync = (dirStruct) => {
  const jstfn = (fs.readdirSync = jest.fn());

  for (const level of dirStruct) {
    jstfn.mockReturnValueOnce(level);
  }

  fs.statSync = jest.fn(function (dir) {
    return {
      isDirectory() {
        //dir1,dir2,dir3        or  dirA_1,dirB_2,dirC_3
        if (/dir\d+$/.test(dir) || /dir[A-z]_\d+$/.test(dir)) return true;
        return false;
      },
    };
  });
};

describe("recurseDir", function () {
  it("should recursively list a directory", function () {
    mockReaddirSync([
      ["dir1", "root_file1.png", "root_file2.png"],
      ["dir2", "dir1_file1.png", "dir1_file2.png"],
      ["dir3"],
      [],
      ["dir4", "root_file1.png", "root_file2.png"],
      ["dir5", "dir4_file1.png", "dir4_file2.png"],
      ["dir6"],
      [],
    ]);

    const { recurseDir } = require("../helpers");

    expect(recurseDir("/")).toEqual([
      "/dir1",
      "/dir1/dir2",
      "/dir1/dir2/dir3",
      "/dir1/dir1_file1.png",
      "/dir1/dir1_file2.png",
      "/root_file1.png",
      "/root_file2.png",
    ]);
    expect(recurseDir("/")).toEqual([
      "/dir4",
      "/dir4/dir5",
      "/dir4/dir5/dir6",
      "/dir4/dir4_file1.png",
      "/dir4/dir4_file2.png",
      "/root_file1.png",
      "/root_file2.png",
    ]);
  });
});

describe("writeFile", function () {
  it("should write file system file", function () {
    fs.writeFileSync = jest.fn();
    helpers.writeFile(imgdiff.protocolify("./file.png"), "<content>");
    helpers.writeFile(imgdiff.protocolify("./file.json"), "<content>");
    helpers.writeFile(imgdiff.protocolify("./file.foo"), "<content>");
    expect(fs.writeFileSync.mock.calls).toMatchSnapshot();
  });
  it("should write file to s3 bucket", function () {
    const putObject = jest.fn();
    jest.spyOn(minio, "Client").mockImplementation(() => ({
      putObject,
    }));
    const config = {
      endPoint: "_ep",
      useSSL: false,
      accessKey: "_ak",
      secretKey: "_sk",
    };
    helpers.writeFile(
      imgdiff.protocolify("s3://bucket/file.png"),
      "<content>",
      config
    );
    helpers.writeFile(
      imgdiff.protocolify("s3://bucket/file.json"),
      "<content>",
      config
    );
    helpers.writeFile(
      imgdiff.protocolify("s3://bucket/file.foo"),
      "<content>",
      config
    );
    expect(putObject.mock.calls).toMatchSnapshot();
  });
});

describe("imgdiff", function () {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(DIFFER, "differ");
    fs.writeFileSync = jest.fn();

    DIFFER.URIHandle.prototype.fetch = jest
      .fn()
      .mockReturnValueOnce(Promise.resolve(Buffer.from("__data_a__")))
      .mockReturnValueOnce(Promise.resolve(Buffer.from("__data_b__")));
    DIFFER.png.PNG.sync.write = jest.fn(() => Buffer.from("__data_diff__"));
    DIFFER.png.PNG.sync.read = jest
      .fn()
      .mockReturnValueOnce({ data: "__data_a__", width: 1, height: 1 })
      .mockReturnValueOnce({ data: "__data_b__", width: 1, height: 1 })
      .mockReturnValueOnce({ data: "__data_a__", width: 1, height: 1 })
      .mockReturnValueOnce({ data: "__data_b__", width: 1, height: 1 });
    jest.spyOn(DIFFER, "batchProcess");
    spyOn(DIFFER.png, "PNG").and.returnValue({
      data: "data",
    });
  });

  it("should call SINGLE differ on A,B file set", async function () {
    jest.spyOn(DIFFER.PM, "pixelmatch").mockImplementation(() => 0);
    await imgdiff.exec({ A: "file1.png", B: "file2.png" });

    expect(DIFFER.png.PNG.sync.read).toMatchSnapshot();
    expect(DIFFER.PM.pixelmatch).toHaveBeenCalledTimes(1);
    expect(DIFFER.PM.pixelmatch).toHaveBeenCalledWith(
      "__data_a__",
      "__data_b__",
      "data",
      1,
      1,
      { threshold: 0.1 }
    );
  });

  it("should call BATCH differ on file:// A,B locations ", async function () {
    jest.spyOn(DIFFER.PM, "pixelmatch").mockImplementation(() => 0);
    let { DIR } = require("../main");
    DIR.__dirname = "/TestFileSystemPath";
    jest.spyOn(DIFFER.furi, "fileUriToPath");
    jest.spyOn(helpers.log, "info");
    const hydrate = jest.spyOn(DIFFER.BaseBatchFiles.prototype, "hydrate");

    mockReaddirSync([
      ["dirA_1", "file1.png", "file2.png"],
      ["dirA_2", "file3.txt", "file4.txt"],
      ["dirA_3"],
      [],
      ["dirB_1", "file1.png", "file2.png"],
      ["dirB_2", "file3.txt", "file4.txt"],
      ["dirB_3"],
      [],
    ]);

    await imgdiff.exec({
      A: "file://dirA_1",
      B: "dirB_2",
      silent: false,
      batch: true,
      jsonReport: "test_json_report.json",
    });
    expect(helpers.log._silent).toBe(false);
    await expect(
      DIFFER.differ.mock.results[0].value
    ).resolves.toMatchSnapshot();
    expect(helpers.log.info.mock.calls).toMatchSnapshot();
    expect(DIFFER.furi.fileUriToPath).toBeCalledTimes(6);
    expect(DIFFER.furi.fileUriToPath.mock.calls).toMatchSnapshot();
    expect(DIFFER.furi.fileUriToPath.mock.calls).toMatchSnapshot();
    expect(hydrate.mock.results[0].value).resolves.toMatchSnapshot();
    expect(hydrate.mock.results[1].value).resolves.toMatchSnapshot();
    await expect(
      DIFFER.batchProcess.mock.results[0].value
    ).resolves.toMatchSnapshot();
    expect(fs.writeFileSync.mock.calls[0]).toMatchSnapshot();
  });

  it("should call BATCH differ on file:// and s3:// A,B locations and snapshots do not match ", async function () {
    let { DIR } = require("../main");
    DIR.__dirname = "/TestFileSystemPath";

    jest.spyOn(DIFFER.PM, "pixelmatch").mockImplementation(() => 32);
    jest.spyOn(DIFFER.furi, "fileUriToPath");
    jest.spyOn(DIFFER.BaseBatchFiles.prototype, "hydrate");

    mockReaddirSync([
      ["dir1", "file1.png", "file2.png"],
      ["dir2", "file3.txt", "file4.txt"],
      ["dir3"],
      [],
    ]);
    const listObjectsV2 = jest.fn(() =>
      Promise.resolve(
        fakeDataStream(
          { name: "file1.png", size: 1024 },
          { name: "file2.png", size: 1024 }
        )
      )
    );
    const getObject = jest
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(fakeDataStream(Buffer.from("__data_a__")))
      )
      .mockImplementationOnce(() =>
        Promise.resolve(fakeDataStream(Buffer.from("__data_b__")))
      );
    const putObject = jest.fn();
    jest.spyOn(minio, "Client").mockImplementation(() => ({
      listObjectsV2,
      getObject,
      putObject,
    }));

    await imgdiff.exec({
      A: "file://dir1",
      B: "s3://test--bucket/dir",
      batch: true,
      s3EndPoint: "ep__test",
      s3AccessKey: "ak__test",
      s3SecretKey: "sk__test",
      useSSL: true,
      jsonReport: "s3://test-bucket/output.json",
      write: "s3://diff-bucket/files/",
    });
    expect(minio.Client).toBeCalledWith({
      accessKey: "ak__test",
      endPoint: "ep__test",
      secretKey: "sk__test",
      useSSL: true,
    });
    expect(getObject).toBeCalledWith("test--bucket", "dir/file1.png");
    expect(getObject).toBeCalledWith("test--bucket", "dir/file2.png");
    expect(DIFFER.png.PNG.sync.read).toMatchSnapshot();
    expect(DIFFER.png.PNG).toBeCalledWith({ width: 1, height: 1 });

    expect(DIFFER.PM.pixelmatch).toHaveBeenCalledWith(
      "__data_a__",
      "__data_b__",
      "data",
      1,
      1,
      { threshold: 0.1 }
    );

    await expect(DIFFER.differ.mock.results[0].value).resolves.toMatchObject({
      pixels: 32,
      match: false,
      BufferDiff: Buffer.from("__data_diff__"),
    });

    await expect(
      DIFFER.batchProcess.mock.results[0].value
    ).resolves.toMatchSnapshot();

    expect(putObject.mock.calls[0][0]).toEqual("diff-bucket");
    expect(putObject.mock.calls[0][1]).toEqual("files/file1.diff.png");

    expect(JSON.parse(putObject.mock.calls[2][2])).toMatchObject({
      new: [],
      diff: [
        {
          uri: "file:///dir1/file1.png",
          keyname: "file1",
          path: "/dir1/file1.png",
          pixels: 32,
        },
        {
          uri: "file:///dir1/file2.png",
          keyname: "file2",
          path: "/dir1/file2.png",
          pixels: 32,
        },
      ],
      match: [],
      removed: [],
    });
  });

  it.only("should call BATCH differ on file:// and s3:// A,B locations and snapshots match ", async function () {
    jest.spyOn(DIFFER.PM, "pixelmatch").mockImplementation(() => 0);
    let { DIR } = require("../main");
    DIR.__dirname = "/TestFileSystemPath";
    jest.spyOn(DIFFER.furi, "fileUriToPath");
    jest.spyOn(DIFFER.BaseBatchFiles.prototype, "hydrate");

    mockReaddirSync([
      ["dir1", "file1.png", "file2.png"],
      ["dir2", "file3.png", "file4.txt"],
      ["dir3"],
      [],
    ]);
    const listObjectsV2 = jest.fn(() =>
      Promise.resolve(
        fakeDataStream(
          { name: "file1.png", size: 1024 },
          { name: "file2.png", size: 1024 }
        )
      )
    );
    const getObject = jest
      .fn()
      .mockImplementationOnce(() =>
        Promise.resolve(fakeDataStream(Buffer.from("__data_a__")))
      )
      .mockImplementationOnce(() =>
        Promise.resolve(fakeDataStream(Buffer.from("__data_b__")))
      );
    const putObject = jest.fn();
    jest.spyOn(minio, "Client").mockImplementation(() => ({
      listObjectsV2,
      getObject,
      putObject,
    }));
    await imgdiff.exec({
      A: "file://dir1",
      B: "s3://test--bucket/dir",
      batch: true,
      s3EndPoint: "ep__test",
      s3AccessKey: "ak__test",
      s3SecretKey: "sk__test",
      useSSL: true,
      write: "s3://diff-bucket",
    });
    expect(minio.Client).toBeCalledWith({
      accessKey: "ak__test",
      endPoint: "ep__test",
      secretKey: "sk__test",
      useSSL: true,
    });
    expect(getObject).toBeCalledWith("test--bucket", "dir/file1.png");
    expect(getObject).toBeCalledWith("test--bucket", "dir/file2.png");
    expect(DIFFER.png.PNG.sync.read).toMatchSnapshot();
    expect(DIFFER.png.PNG).toBeCalledWith({ width: 1, height: 1 });

    expect(DIFFER.PM.pixelmatch).toHaveBeenCalledWith(
      "__data_a__",
      "__data_b__",
      "data",
      1,
      1,
      { threshold: 0.1 }
    );
    await expect(DIFFER.differ.mock.results[0].value).resolves.toMatchObject({
      pixels: 0,
      match: true,
      BufferDiff: Buffer.from("__data_diff__"),
    });

    await expect(
      DIFFER.batchProcess.mock.results[0].value
    ).resolves.toMatchSnapshot();

    expect(putObject.mock.calls).toMatchSnapshot();

    console.log(putObject.mock.calls);
  });

  it("should parse cli options", function () {
    const { parseCLI } = require("../main");
    expect(parseCLI(["--foo=foo"])).toMatchObject({
      foo: "foo",
    });

    expect(parseCLI(["--foo=foo"])).toMatchObject({
      foo: "foo",
    });

    const args = {
      diff: "[name].diff.png",
      jsonReport: "test_json_report.json",
      A: "/some test dir",
      B: "/some_test_dir",
      s3EndPoint: "ceph.squarespace.net",
      s3AccessKey: "ak__",
      s3SecretKey: "sk__",
      exitCode: true,
      useSSL: false,
      threshold: 0.1,
      batch: false,
      silent: true,
    };
    const argv = Object.entries(args).map(
      ([k, v]) => `--${k}=${JSON.stringify(v).replace(/"/g, "")}`
    );
    expect(parseCLI(argv)).toEqual(args);
    expect(parseCLI(argv)).toMatchSnapshot();

    expect(parseCLI(["--foo"])).toEqual({ foo: true });
  });
  it.skip("should report removed files", () => {});
  it.skip("should report diff files", () => {});
  it.skip("should report match files", () => {});
  it.skip("should gracefully handle empty dirs or collections", () => {});
});
