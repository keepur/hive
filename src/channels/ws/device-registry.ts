/**
 * MongoDB-backed device registry for WebSocket client authentication.
 *
 * Devices are created with a 6-digit pairing code that expires after 10 minutes.
 * Once paired, the client receives a JWT for subsequent connections.
 */

import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../../logging/logger.js";
import { randomUUID, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";

const log = createLogger("device-registry");

export interface Device {
  _id: string;
  name: string;
  pairingCode?: string;
  pairingCodeExpiresAt?: Date;
  defaultAgentId: string;
  createdAt: Date;
  lastSeenAt: Date;
  active: boolean;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class DeviceRegistry {
  private client: MongoClient;
  private dbName: string;
  private db!: Db;
  private collection!: Collection<Device>;
  private jwtSecret: string;

  constructor(mongoUri: string, dbName: string, jwtSecret: string) {
    this.client = new MongoClient(mongoUri);
    this.dbName = dbName;
    this.jwtSecret = jwtSecret;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<Device>("devices");
    await this.collection.createIndex({ pairingCode: 1 }, { sparse: true });
    log.info("Device registry connected", { db: this.dbName });
  }

  async createDevice(name: string, defaultAgentId: string): Promise<Device> {
    const now = new Date();
    const device: Device = {
      _id: randomUUID(),
      name,
      pairingCode: randomInt(100000, 999999).toString(),
      pairingCodeExpiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS),
      defaultAgentId,
      createdAt: now,
      lastSeenAt: now,
      active: true,
    };
    await this.collection.insertOne(device);
    log.info("Device created", { id: device._id, name, pairingCode: device.pairingCode });
    return device;
  }

  async verifyPairingCode(code: string): Promise<{ device: Device; token: string } | null> {
    const device = await this.collection.findOne({
      pairingCode: code,
      pairingCodeExpiresAt: { $gt: new Date() },
    });

    if (!device) {
      log.warn("Pairing code invalid or expired", { code });
      return null;
    }

    // Clear the pairing code so it cannot be reused
    await this.collection.updateOne(
      { _id: device._id },
      { $unset: { pairingCode: "", pairingCodeExpiresAt: "" } },
    );

    const token = jwt.sign({ deviceId: device._id }, this.jwtSecret, { expiresIn: "90d" });
    log.info("Device paired", { id: device._id, name: device.name });

    // Return the device without the pairing fields
    const paired: Device = { ...device, pairingCode: undefined, pairingCodeExpiresAt: undefined };
    return { device: paired, token };
  }

  async verifyToken(token: string): Promise<Device | null> {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { deviceId: string };
      const device = await this.collection.findOne({ _id: payload.deviceId, active: true });
      if (!device) {
        log.warn("Token valid but device not found or inactive", { deviceId: payload.deviceId });
        return null;
      }
      return device;
    } catch (e: any) {
      log.warn("Token verification failed", { error: e.message });
      return null;
    }
  }

  async refreshPairingCode(deviceId: string): Promise<string> {
    const code = randomInt(100000, 999999).toString();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    await this.collection.updateOne(
      { _id: deviceId },
      { $set: { pairingCode: code, pairingCodeExpiresAt: expiresAt } },
    );
    log.info("Pairing code refreshed", { deviceId, code });
    return code;
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    await this.collection.updateOne(
      { _id: deviceId },
      { $set: { lastSeenAt: new Date() } },
    );
  }

  async listDevices(): Promise<Device[]> {
    return this.collection.find().toArray();
  }

  async close(): Promise<void> {
    await this.client.close();
    log.info("Device registry closed");
  }
}
