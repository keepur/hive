import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:os", () => ({
  homedir: () => "/Users/testuser",
}));

vi.mock("node:fs", () => ({
  realpathSync: vi.fn(),
  statSync: vi.fn(),
}));

import { realpathSync, statSync } from "node:fs";
import { validatePath } from "./path-utils.js";

const mockRealpathSync = vi.mocked(realpathSync);
const mockStatSync = vi.mocked(statSync);

beforeEach(() => {
  vi.resetAllMocks();
  // Default: statSync returns a directory
  mockStatSync.mockReturnValue({ isDirectory: () => true } as ReturnType<typeof statSync>);
});

describe("validatePath", () => {
  it("returns resolved path for a valid path under home", () => {
    const resolvedPath = "/Users/testuser/projects/myapp";
    // First call: realpathSync(homedir()) → home
    // Second call: realpathSync(absolute) → resolved path
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce(resolvedPath);

    const result = validatePath("/Users/testuser/projects/myapp");

    expect(result).toBe(resolvedPath);
  });

  it("expands ~ to home directory and resolves correctly", () => {
    const resolvedPath = "/Users/testuser/documents/notes";
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce(resolvedPath);

    const result = validatePath("~/documents/notes");

    expect(result).toBe(resolvedPath);
  });

  it("throws 'outside home directory' for path outside home", () => {
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce("/tmp/some-other-dir");

    expect(() => validatePath("/tmp/some-other-dir")).toThrow("Path is outside home directory: /tmp/some-other-dir");
  });

  it("throws 'does not exist' when realpathSync throws for the input path", () => {
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockImplementationOnce(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    expect(() => validatePath("/Users/testuser/nonexistent")).toThrow(
      "Path does not exist: /Users/testuser/nonexistent",
    );
  });

  it("rejects sibling directory with shared home prefix", () => {
    // /Users/testusermalicious should NOT pass when home is /Users/testuser
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce("/Users/testusermalicious");

    expect(() => validatePath("/Users/testusermalicious")).toThrow("Path is outside home directory");
  });

  it("allows home directory itself", () => {
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce("/Users/testuser");

    const result = validatePath("~");

    expect(result).toBe("/Users/testuser");
  });

  it("throws 'not a directory' when path points to a file", () => {
    mockRealpathSync.mockReturnValueOnce("/Users/testuser").mockReturnValueOnce("/Users/testuser/somefile.txt");
    mockStatSync.mockReturnValue({ isDirectory: () => false } as ReturnType<typeof statSync>);

    expect(() => validatePath("/Users/testuser/somefile.txt")).toThrow(
      "Path is not a directory: /Users/testuser/somefile.txt",
    );
  });
});
