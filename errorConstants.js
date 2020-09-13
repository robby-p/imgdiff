const errors = {
  1: "S3 bucket uri provided (s3://), but configuration for was not",
  2: "diffing directories must be flagged, '--batch' flag must be provided, otherwise A= and B= must point to a file",
};
module.exports = {
  codes: Object.keys(errors),
  msgs: errors,
};
