import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { decodeAndValidate, handleImage, handleFile } from "./file-handler.js";

describe("decodeAndValidate", () => {
  it("decodes valid base64 and sanitizes filename", () => {
    const data = Buffer.from("hello world").toString("base64");
    const result = decodeAndValidate(data, "test file (1).txt");
    expect(result.buffer.toString()).toBe("hello world");
    expect(result.safeName).toBe("test_file__1_.txt");
  });

  it("throws on missing filename", () => {
    const data = Buffer.from("hello").toString("base64");
    expect(() => decodeAndValidate(data, "")).toThrow("Missing required field: filename");
  });

  it("throws on invalid base64 data", () => {
    expect(() => decodeAndValidate("not!valid@base64", "test.txt")).toThrow("Invalid base64 data");
  });

  it("throws on oversized file", () => {
    // Create a buffer just over 10 MB
    const bigBuffer = Buffer.alloc(10 * 1024 * 1024 + 1);
    const data = bigBuffer.toString("base64");
    expect(() => decodeAndValidate(data, "big.bin")).toThrow("File too large");
  });
});

describe("handleImage", () => {
  it("saves image to disk and returns directive prompt", async () => {
    const imageData = Buffer.from("fake-png-data").toString("base64");
    const result = await handleImage(imageData, "screenshot.png");

    expect(result).toContain("The user attached an image: screenshot.png");
    expect(result).toContain("Read this file before responding (it is an image):");
    expect(result).toContain(join(tmpdir(), "bk-files"));

    // Verify file was written
    const pathMatch = result.match(/: (\/.*\.png)$/m);
    expect(pathMatch).toBeTruthy();
    if (pathMatch) {
      expect(existsSync(pathMatch[1])).toBe(true);
      expect(readFileSync(pathMatch[1]).toString()).toBe("fake-png-data");
    }
  });
});

describe("handleFile", () => {
  it("extracts text from a .txt file", async () => {
    const textData = Buffer.from("Hello, this is a text file.").toString("base64");
    const result = await handleFile(textData, "notes.txt", "text/plain");

    expect(result).toContain("📎 File: notes.txt");
    expect(result).toContain("text/plain");
    expect(result).toContain("Hello, this is a text file.");
    expect(result).toContain("--- file content ---");
  });

  it("falls back to metadata for unsupported types", async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02]).toString("base64");
    const result = await handleFile(binaryData, "data.bin", "application/octet-stream");

    expect(result).toContain("📎 File: data.bin");
    expect(result).toContain("unsupported format");
    expect(result).toContain("content not extracted");
  });

  it("treats image sent via file type as image", async () => {
    const imageData = Buffer.from("fake-image").toString("base64");
    const result = await handleFile(imageData, "photo.jpg", "image/jpeg");

    expect(result).toContain("The user attached an image: photo.jpg");
    expect(result).toContain("Read this file before responding");
  });

  it("extracts CSV content", async () => {
    const csvData = Buffer.from("name,age\nAlice,30\nBob,25").toString("base64");
    const result = await handleFile(csvData, "data.csv", "text/csv");

    expect(result).toContain("📎 File: data.csv");
    expect(result).toContain("Alice,30");
  });
});
