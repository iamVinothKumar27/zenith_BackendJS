import { MongoClient } from "mongodb";
import { config } from "./env.js";

let client = null;
let dbInstance = null;

export async function getDb() {
  if (!config.mongodbUri) {
    throw new Error("MONGODB_URI is not set");
  }
  if (!dbInstance) {
    const pending = client || new MongoClient(config.mongodbUri, { serverSelectionTimeoutMS: 5000 });
    try {
      await pending.connect();
      client = pending;
      dbInstance = client.db(config.mongodbDb);
    } catch (e) {
      // Don't cache a half-connected client — retry fresh on the next call
      // instead of permanently failing every request after one transient blip.
      client = null;
      throw e;
    }
  }
  return dbInstance;
}

export async function getMongoClient() {
  await getDb();
  return client;
}
