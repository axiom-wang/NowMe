/**
 * PNG 工具：读尺寸、压缩到体积上限（封面 ≤ 600 KB，contracts 1.4）。
 *
 * 压缩用纯 JS 的 UPNG（photopea/UPNG.js）：先无损重新编码，仍然超出就量化到 256 / 128 / … 色的调色板 PNG，
 * 直到不超过上限。尺寸始终不变。
 */
import UPNG from 'upng-js';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG 的宽高（读 IHDR）；不是 PNG 时返回 null。 */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface CompressedPng {
  png: Uint8Array;
  /** 量化后的颜色数；null 表示没有量化（原图或无损重新编码）。 */
  colors: number | null;
}

/** 依次尝试的调色板颜色数。 */
const PALETTE_STEPS = [256, 192, 128, 96, 64, 48, 32, 24, 16, 8];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * 把 PNG 压到 `maxBytes` 以内（尺寸不变）。已经不超过时原样返回。最少的颜色数仍然超出时抛错。
 */
export function compressPng(png: Uint8Array, maxBytes: number): CompressedPng {
  if (png.byteLength <= maxBytes) return { png, colors: null };
  const image = UPNG.decode(toArrayBuffer(png));
  const [rgba] = UPNG.toRGBA8(image);
  if (!rgba) throw new Error('PNG 解码失败');
  const lossless = new Uint8Array(UPNG.encode([rgba], image.width, image.height, 0));
  if (lossless.byteLength <= maxBytes) return { png: lossless, colors: null };
  for (const colors of PALETTE_STEPS) {
    const quantized = new Uint8Array(UPNG.encode([rgba], image.width, image.height, colors));
    if (quantized.byteLength <= maxBytes) return { png: quantized, colors };
  }
  throw new Error(`PNG 量化到 ${PALETTE_STEPS[PALETTE_STEPS.length - 1]} 色后仍超过 ${maxBytes} 字节`);
}
