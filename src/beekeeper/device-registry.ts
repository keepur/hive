import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import { randomUUID, randomInt } from "node:crypto";
import jwt from "jsonwebtoken";

const log = createLogger("beekeeper-device-registry");

export interface BeekeeperDevice {
  _id: string;
  name: string;
  pairingCode?: string;
  pairingCodeExpiresAt?: Date;
  createdAt: Date;
  lastSeenAt: Date;
  pairedAt?: Date;
  active: boolean;
}

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export class BeekeeperDeviceRegistry {
  private client: MongoClient;
  private dbName: string;
  private db!: Db;
  private collection!: Collection<BeekeeperDevice>;
  private jwtSecret: string;

  constructor(mongoUri: string, dbName: string, jwtSecret: string) {
    this.client = new MongoClient(mongoUri);
    this.dbName = dbName;
    this.jwtSecret = jwtSecret;
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collection = this.db.collection<BeekeeperDevice>("beekeeper_devices");
    await this.collection.createIndex({ pairingCode: 1 }, { sparse: true });
    log.info("Beekeeper device registry connected", { db: this.dbName });
  }

  async createDevice(name: string): Promise<BeekeeperDevice> {
    const now = new Date();
    const device: BeekeeperDevice = {
      _id: randomUUID(),
      name,
      pairingCode: randomInt(100000, 1000000).toString(),
      pairingCodeExpiresAt: new Date(now.getTime() + PAIRING_CODE_TTL_MS),
      createdAt: now,
      lastSeenAt: now,
      active: true,
    };
    await this.collection.insertOne(device);
    log.info("Device created", { id: device._id, name });
    return device;
  }

  async verifyPairingCode(code: string, name?: string): Promise<{ device: BeekeeperDevice; token: string } | null> {
    const device = await this.collection.findOne({
      pairingCode: code,
      pairingCodeExpiresAt: { $gt: new Date() },
    });

    if (!device) {
      log.warn("Pairing code invalid or expired");
      return null;
    }

    const now = new Date();
    const updates: Record<string, unknown> = { pairedAt: now };
    if (name) updates.name = name;

    await this.collection.updateOne(
      { _id: device._id },
      { $set: updates, $unset: { pairingCode: "", pairingCodeExpiresAt: "" } },
    );

    const finalName = name ?? device.name;
    const token = jwt.sign({ deviceId: device._id }, this.jwtSecret, { expiresIn: "90d" });
    log.info("Device paired", { id: device._id, name: finalName });

    const paired: BeekeeperDevice = {
      ...device,
      name: finalName,
      pairedAt: now,
      pairingCode: undefined,
      pairingCodeExpiresAt: undefined,
    };
    return { device: paired, token };
  }

  async verifyToken(token: string): Promise<BeekeeperDevice | null> {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { deviceId: string };
      const device = await this.collection.findOne({ _id: payload.deviceId, active: true });
      if (!device) {
        log.warn("Token valid but device not found or inactive", { deviceId: payload.deviceId });
        return null;
      }
      return device;
    } catch (e: unknown) {
      log.warn("Token verification failed", { error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  }

  async refreshPairingCode(deviceId: string): Promise<string | null> {
    const code = randomInt(100000, 1000000).toString();
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const result = await this.collection.updateOne(
      { _id: deviceId },
      { $set: { pairingCode: code, pairingCodeExpiresAt: expiresAt } },
    );
    if (result.matchedCount === 0) {
      log.warn("Refresh pairing code failed — device not found", { deviceId });
      return null;
    }
    log.info("Pairing code refreshed", { deviceId });
    return code;
  }

  async updateLastSeen(deviceId: string): Promise<void> {
    await this.collection.updateOne({ _id: deviceId }, { $set: { lastSeenAt: new Date() } });
  }

  async getDevice(deviceId: string): Promise<BeekeeperDevice | null> {
    return this.collection.findOne({ _id: deviceId });
  }

  async updateDevice(deviceId: string, fields: { name?: string }): Promise<BeekeeperDevice | null> {
    const result = await this.collection.findOneAndUpdate(
      { _id: deviceId },
      { $set: fields },
      { returnDocument: "after" },
    );
    if (result) log.info("Device updated", { deviceId, ...fields });
    return result;
  }

  async deactivateDevice(deviceId: string): Promise<boolean> {
    const result = await this.collection.updateOne({ _id: deviceId }, { $set: { active: false } });
    if (result.modifiedCount > 0) {
      log.info("Device deactivated", { deviceId });
      return true;
    }
    return false;
  }

  async listDevices(): Promise<BeekeeperDevice[]> {
    return this.collection.find().toArray();
  }

  async close(): Promise<void> {
    await this.client.close();
    log.info("Beekeeper device registry closed");
  }
}
