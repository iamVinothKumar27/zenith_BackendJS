import { Supadata } from "@supadata/js";
import { config } from "../config/env.js";

const supadata = new Supadata({ apiKey: config.supadataKey || "" });

export default supadata;
