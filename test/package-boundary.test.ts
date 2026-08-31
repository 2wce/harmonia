import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceDirectory = fileURLToPath(new URL("../src/", import.meta.url));
const productionRootEntryPoint = join(sourceDirectory, "index.ts");

const prohibitedPackagePatterns: ReadonlyArray<{
  name: string;
  matches: (specifier: string) => boolean;
}> = [
  { name: "React", matches: (specifier) => /^(?:react|react-dom)(?:\/|$)/.test(specifier) },
  { name: "TanStack DB", matches: (specifier) => /^@tanstack\/db(?:\/|$)/.test(specifier) },
  {
    name: "SQLite",
    matches: (specifier) =>
      /^(?:sqlite|sqlite3|better-sqlite3|@libsql\/|@sqlite\.org\/sqlite-wasm)(?:\/|$)/.test(
        specifier,
      ),
  },
  { name: "Electron", matches: (specifier) => /^electron(?:\/|$)/.test(specifier) },
  { name: "Hono", matches: (specifier) => /^hono(?:\/|$)/.test(specifier) },
  { name: "D1", matches: (specifier) => /^(?:d1|@cloudflare\/d1)(?:\/|$)/.test(specifier) },
  { name: "Drizzle", matches: (specifier) => /^(?:drizzle-|drizzle-orm)(?:\/|$)/.test(specifier) },
  { name: "R2", matches: (specifier) => /^(?:r2|@cloudflare\/r2)(?:\/|$)/.test(specifier) },
  {
    name: "Better Reader",
    matches: (specifier) => /^(?:@2wce\/better-reader|better-reader)(?:\/|$)/.test(specifier),
  },
  {
    name: "Easy HMS",
    matches: (specifier) => /^(?:@easy-hms\/|easy-hms)(?:\/|$)/.test(specifier),
  },
];

function productionSourceFiles(directory = sourceDirectory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return entry.name === "testing" ? [] : productionSourceFiles(path);
    }

    return extname(entry.name) === ".ts" ? [path] : [];
  });
}

function importedModuleSpecifiers(filePath: string): string[] {
  const source = readFileSync(filePath, "utf8");
  const staticImports = /\b(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [...source.matchAll(staticImports), ...source.matchAll(dynamicImports)].map(
    ([, specifier]) => specifier,
  );
}

describe("production package boundary", () => {
  it("keeps production sources independent of product frameworks and infrastructure", () => {
    const prohibitedImports = productionSourceFiles().flatMap((filePath) =>
      importedModuleSpecifiers(filePath).flatMap((specifier) => {
        const prohibitedPackage = prohibitedPackagePatterns.find(({ matches }) =>
          matches(specifier),
        );
        return prohibitedPackage === undefined
          ? []
          : [`${basename(filePath)} imports ${prohibitedPackage.name} via ${specifier}`];
      }),
    );

    expect(prohibitedImports).toEqual([]);
  });

  it("does not import the testing entry point from the production root", () => {
    expect(importedModuleSpecifiers(productionRootEntryPoint)).not.toContain(
      "@2wce/harmonia/testing",
    );
  });
});
