import { rm } from "node:fs/promises";

const generatedPaths = [
  "dist",
  "dist-native",
  "dist-server",
];

await Promise.all(
  generatedPaths.map((path) => rm(path, { recursive: true, force: true })),
);
