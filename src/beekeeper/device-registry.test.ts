import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks (before module under test) ---

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const mockCollection = {
  insertOne: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  find: vi.fn(),
  createIndex: vi.fn(),
};

const mockDb = {
  collection: vi.fn(() => mockCollection),
};

const mockClient = {
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn(() => mockDb),
};

vi.mock("mongodb", () => ({
  MongoClient: vi.fn(() => mockClient),
}));

vi.mock("jsonwebtoken", () => ({
  default: {
    sign: vi.fn(() => "mock-jwt-token"),
    verify: vi.fn(() => ({ deviceId: "device-123" })),
  },
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "test-uuid-1234"),
  randomInt: vi.fn(() => 123456),
}));

import { BeekeeperDeviceRegistry, type BeekeeperDevice } from "./device-registry.js";
import jwt from "jsonwebtoken";

function makeDevice(overrides: Partial<BeekeeperDevice> = {}): BeekeeperDevice {
  const now = new Date();
  return {
    _id: "test-uuid-1234",
    name: "Test Device",
    pairingCode: "123456",
    pairingCodeExpiresAt: new Date(now.getTime() + 600_000),
    createdAt: now,
    lastSeenAt: now,
    active: true,
    ...overrides,
  };
}

describe("BeekeeperDeviceRegistry", () => {
  let registry: BeekeeperDeviceRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new BeekeeperDeviceRegistry("mongodb://localhost", "test_db", "secret");
  });

  describe("connect", () => {
    it("connects client, sets up collection, and creates index", async () => {
      await registry.connect();

      expect(mockClient.connect).toHaveBeenCalledOnce();
      expect(mockClient.db).toHaveBeenCalledWith("test_db");
      expect(mockDb.collection).toHaveBeenCalledWith("beekeeper_devices");
      expect(mockCollection.createIndex).toHaveBeenCalledWith({ pairingCode: 1 }, { sparse: true });
    });
  });

  describe("createDevice", () => {
    it("returns device with expected shape", async () => {
      await registry.connect();
      const device = await registry.createDevice("My iPad");

      expect(device._id).toBe("test-uuid-1234");
      expect(device.name).toBe("My iPad");
      expect(device.pairingCode).toBe("123456");
      expect(device.pairingCodeExpiresAt).toBeInstanceOf(Date);
      expect(device.pairingCodeExpiresAt!.getTime()).toBeGreaterThan(device.createdAt.getTime());
      expect(device.createdAt).toBeInstanceOf(Date);
      expect(device.lastSeenAt).toBeInstanceOf(Date);
      expect(device.active).toBe(true);
      expect(device.pairedAt).toBeUndefined();
      expect(mockCollection.insertOne).toHaveBeenCalledWith(device);
    });
  });

  describe("verifyPairingCode", () => {
    it("returns device and JWT on success", async () => {
      await registry.connect();
      const existing = makeDevice();
      mockCollection.findOne.mockResolvedValueOnce(existing);

      const result = await registry.verifyPairingCode("123456");

      expect(result).not.toBeNull();
      expect(result!.token).toBe("mock-jwt-token");
      expect(result!.device._id).toBe(existing._id);
      expect(result!.device.pairedAt).toBeInstanceOf(Date);
      expect(result!.device.pairingCode).toBeUndefined();
      expect(result!.device.pairingCodeExpiresAt).toBeUndefined();
      expect(jwt.sign).toHaveBeenCalledWith({ deviceId: existing._id }, "secret", { expiresIn: "90d" });
    });

    it("applies optional name override", async () => {
      await registry.connect();
      mockCollection.findOne.mockResolvedValueOnce(makeDevice({ name: "Old Name" }));

      const result = await registry.verifyPairingCode("123456", "New Name");

      expect(result).not.toBeNull();
      expect(result!.device.name).toBe("New Name");
      // Check that updateOne was called with name in $set
      const updateCall = mockCollection.updateOne.mock.calls[0];
      expect(updateCall[1].$set).toEqual(expect.objectContaining({ name: "New Name" }));
    });

    it("returns null for invalid/expired code", async () => {
      await registry.connect();
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await registry.verifyPairingCode("000000");

      expect(result).toBeNull();
      expect(mockCollection.updateOne).not.toHaveBeenCalled();
    });

    it("clears pairing code fields after successful pairing", async () => {
      await registry.connect();
      mockCollection.findOne.mockResolvedValueOnce(makeDevice());

      await registry.verifyPairingCode("123456");

      const updateCall = mockCollection.updateOne.mock.calls[0];
      expect(updateCall[1].$unset).toEqual({
        pairingCode: "",
        pairingCodeExpiresAt: "",
      });
    });
  });

  describe("verifyToken", () => {
    it("returns device on success", async () => {
      await registry.connect();
      const device = makeDevice({ pairedAt: new Date() });
      mockCollection.findOne.mockResolvedValueOnce(device);

      const result = await registry.verifyToken("mock-jwt-token");

      expect(result).toEqual(device);
      expect(jwt.verify).toHaveBeenCalledWith("mock-jwt-token", "secret");
      expect(mockCollection.findOne).toHaveBeenCalledWith({
        _id: "device-123",
        active: true,
      });
    });

    it("returns null for invalid token", async () => {
      await registry.connect();
      vi.mocked(jwt.verify).mockImplementationOnce(() => {
        throw new Error("invalid token");
      });

      const result = await registry.verifyToken("bad-token");

      expect(result).toBeNull();
    });

    it("returns null when device is inactive", async () => {
      await registry.connect();
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await registry.verifyToken("mock-jwt-token");

      expect(result).toBeNull();
    });
  });

  describe("deactivateDevice", () => {
    it("returns true when device found and deactivated", async () => {
      await registry.connect();
      mockCollection.updateOne.mockResolvedValueOnce({ modifiedCount: 1 });

      const result = await registry.deactivateDevice("device-123");

      expect(result).toBe(true);
      expect(mockCollection.updateOne).toHaveBeenCalledWith({ _id: "device-123" }, { $set: { active: false } });
    });

    it("returns false when device not found", async () => {
      await registry.connect();
      mockCollection.updateOne.mockResolvedValueOnce({ modifiedCount: 0 });

      const result = await registry.deactivateDevice("nonexistent");

      expect(result).toBe(false);
    });
  });

  describe("refreshPairingCode", () => {
    it("returns new code when device exists", async () => {
      await registry.connect();
      mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 1 });

      const code = await registry.refreshPairingCode("device-123");

      expect(code).toBe("123456");
      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: "device-123", active: true },
        { $set: { pairingCode: "123456", pairingCodeExpiresAt: expect.any(Date) } },
      );
    });

    it("returns null when device not found", async () => {
      await registry.connect();
      mockCollection.updateOne.mockResolvedValueOnce({ matchedCount: 0 });

      const code = await registry.refreshPairingCode("nonexistent");

      expect(code).toBeNull();
    });
  });

  describe("listDevices", () => {
    it("returns all devices", async () => {
      await registry.connect();
      const devices = [makeDevice(), makeDevice({ _id: "device-2", name: "Second" })];
      mockCollection.find.mockReturnValueOnce({ toArray: vi.fn().mockResolvedValueOnce(devices) });

      const result = await registry.listDevices();

      expect(result).toEqual(devices);
    });
  });

  describe("getDevice", () => {
    it("returns device by ID", async () => {
      await registry.connect();
      const device = makeDevice();
      mockCollection.findOne.mockResolvedValueOnce(device);

      const result = await registry.getDevice("test-uuid-1234");

      expect(result).toEqual(device);
      expect(mockCollection.findOne).toHaveBeenCalledWith({ _id: "test-uuid-1234" });
    });

    it("returns null when not found", async () => {
      await registry.connect();
      mockCollection.findOne.mockResolvedValueOnce(null);

      const result = await registry.getDevice("nonexistent");

      expect(result).toBeNull();
    });
  });

  describe("updateDevice", () => {
    it("updates and returns device", async () => {
      await registry.connect();
      const updated = makeDevice({ name: "New Name" });
      mockCollection.findOneAndUpdate.mockResolvedValueOnce(updated);

      const result = await registry.updateDevice("test-uuid-1234", { name: "New Name" });

      expect(result).toEqual(updated);
      expect(mockCollection.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: "test-uuid-1234" },
        { $set: { name: "New Name" } },
        { returnDocument: "after" },
      );
    });

    it("returns null when device not found", async () => {
      await registry.connect();
      mockCollection.findOneAndUpdate.mockResolvedValueOnce(null);

      const result = await registry.updateDevice("nonexistent", { name: "X" });

      expect(result).toBeNull();
    });
  });

  describe("updateLastSeen", () => {
    it("updates lastSeenAt timestamp", async () => {
      await registry.connect();

      await registry.updateLastSeen("device-123");

      expect(mockCollection.updateOne).toHaveBeenCalledWith(
        { _id: "device-123" },
        { $set: { lastSeenAt: expect.any(Date) } },
      );
    });
  });

  describe("close", () => {
    it("closes MongoDB client", async () => {
      await registry.connect();

      await registry.close();

      expect(mockClient.close).toHaveBeenCalledOnce();
    });
  });
});
