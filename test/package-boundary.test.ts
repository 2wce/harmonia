import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
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
      /^(?:sqlite|sqlite3|better-sqlite3|@libsql|@sqlite\.org\/sqlite-wasm)(?:\/|$)/.test(
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

    return isProductionSourceFile(entry.name) ? [path] : [];
  });
}

function importedModuleSpecifiers(filePath: string): string[] {
  return sourceModuleSpecifiers(readFileSync(filePath, "utf8"));
}

function sourceModuleSpecifiers(source: string): string[] {
  const staticImports = /\b(?:import|export)\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/g;
  const dynamicImports = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const commonJsImports = /\b(?:require|module\.require)\s*\(\s*["']([^"']+)["']\s*\)/g;
  return [
    ...source.matchAll(staticImports),
    ...source.matchAll(dynamicImports),
    ...source.matchAll(commonJsImports),
  ].map(([, specifier]) => specifier);
}

describe("production package boundary", () => {
  it("recognizes ESM and CommonJS dependency declarations", () => {
    expect(
      sourceModuleSpecifiers(
        'import "hono"; export { value } from "drizzle-orm"; const db = require("better-sqlite3"); import sqlite = require("@libsql/client"); import("electron");',
      ),
    ).toEqual(["hono", "drizzle-orm", "electron", "better-sqlite3", "@libsql/client"]);
  });

  it("recognizes all compilable production source extensions", () => {
    expect(
      ["module.ts", "module.tsx", "module.mts", "module.cts"].every(isProductionSourceFile),
    ).toBe(true);
    expect(isProductionSourceFile("README.md")).toBe(false);
  });

  it("normalizes relative paths before checking the testing boundary", () => {
    expect(
      ["./testing.js", "./foo/../testing/index.js", "../src/testing/index.js"].map(isTestingImport),
    ).toEqual([true, true, true]);
  });

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
    const testingImports =
      importedModuleSpecifiers(productionRootEntryPoint).filter(isTestingImport);

    expect(testingImports).toEqual([]);
  });
});

function isTestingImport(specifier: string): boolean {
  if (specifier === "@2wce/harmonia/testing") return true;
  if (!specifier.startsWith(".")) return false;

  const resolved = resolve(dirname(productionRootEntryPoint), specifier);
  const relativePath = relative(sourceDirectory, resolved);
  return (
    relativePath === "testing" ||
    relativePath.startsWith(`testing${sep}`) ||
    relativePath.startsWith("testing.")
  );
}

function isProductionSourceFile(fileName: string): boolean {
  return [".ts", ".tsx", ".mts", ".cts"].includes(extname(fileName));
}
