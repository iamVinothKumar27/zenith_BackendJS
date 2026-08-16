import { GridFSBucket, ObjectId } from "mongodb";

export function getBucket(db, bucketName = "fs") {
  return new GridFSBucket(db, { bucketName });
}

export async function gridfsPut(db, buffer, filename, contentType) {
  const bucket = getBucket(db);
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(filename, { contentType });
    uploadStream.on("error", reject);
    uploadStream.on("finish", () => resolve(uploadStream.id));
    uploadStream.end(buffer);
  });
}

export async function gridfsGet(db, fileId) {
  const bucket = getBucket(db);
  const id = typeof fileId === "string" ? new ObjectId(fileId) : fileId;
  const chunks = [];
  return new Promise((resolve, reject) => {
    const downloadStream = bucket.openDownloadStream(id);
    downloadStream.on("data", (chunk) => chunks.push(chunk));
    downloadStream.on("error", reject);
    downloadStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

export async function gridfsDelete(db, fileId) {
  const bucket = getBucket(db);
  const id = typeof fileId === "string" ? new ObjectId(fileId) : fileId;
  try {
    await bucket.delete(id);
  } catch {
    // ignore missing file
  }
}
