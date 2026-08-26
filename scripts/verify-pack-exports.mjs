import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const packageTarball = join(
  ".artifacts",
  `${packageJson.name.replace(/^@/, "").replaceAll("/", "-")}-${packageJson.version}.tgz`,
);
const packedFiles = execFileSync("tar", ["-tzf", packageTarball], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .map((file) => file.replace(/^package\//, ""));

const exportTargets = new Set();
const collectTargets = (value) => {
  if (typeof value === "string") {
    exportTargets.add(value);
    return;
  }

  for (const target of Object.values(value)) {
    collectTargets(target);
  }
};

collectTargets(packageJson.exports);

const missingTargets = [...exportTargets].filter(
  (target) => !packedFiles.includes(target.replace(/^\.\//, "")),
);

if (missingTargets.length > 0) {
  throw new Error(
    `Packed artifact ${basename(packageTarball)} is missing export target(s): ${missingTargets.join(", ")}`,
  );
}

console.log(
  `Verified ${exportTargets.size} declared export target(s) in ${basename(packageTarball)}.`,
);
