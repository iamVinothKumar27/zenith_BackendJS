import multer from "multer";

// In-memory storage; handlers persist bytes to GridFS/disk as needed (mirrors Flask's request.files access).
const storage = multer.memoryStorage();

export const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
