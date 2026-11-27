import { crc32 } from "node:zlib";

export function eventFrame(payload, headers = { ":message-type": "event", ":event-type": "chunk", ":content-type": "application/json" }) {
  const entries = Object.entries(headers).map(([name, value]) => {
    const key = Buffer.from(name), text = Buffer.from(value), length = Buffer.alloc(2);
    length.writeUInt16BE(text.length);
    return Buffer.concat([Buffer.from([key.length]), key, Buffer.from([7]), length, text]);
  });
  const metadata = Buffer.concat(entries), data = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
  const message = Buffer.alloc(16 + metadata.length + data.length);
  message.writeUInt32BE(message.length); message.writeUInt32BE(metadata.length, 4);
  message.writeUInt32BE(crc32(message.subarray(0, 8)), 8);
  metadata.copy(message, 12); data.copy(message, 12 + metadata.length);
  message.writeUInt32BE(crc32(message.subarray(0, -4)), message.length - 4);
  return message;
}
export const chunk = value => eventFrame({ bytes: Buffer.from(JSON.stringify(value)).toString("base64") });
export const novaFinal = { metadata: { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } };
