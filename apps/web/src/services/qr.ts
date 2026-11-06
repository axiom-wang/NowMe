/**
 * 邀请二维码（W02、W04）：服务端用 `qrcode` 生成矩阵，自己拼成 SVG。
 *
 * 主站 CSP 是 `img-src 'self' data:`，且不允许内联样式：SVG 只用 `fill` 等展示属性（不写 `style`），
 * 以 `data:image/svg+xml;base64,...` 放进 `<img>`。四周留 4 个模块的静区，`shape-rendering="crispEdges"`。
 */
import QRCode from 'qrcode';

/** 静区宽度（模块数，QR 规范要求至少 4）。 */
const QUIET_ZONE = 4;

/** 文本 → 二维码 SVG 字符串（纠错等级 M）。 */
export function qrSvg(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const { size } = qr.modules;
  const total = size + QUIET_ZONE * 2;
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    let col = 0;
    while (col < size) {
      if (!qr.modules.get(row, col)) {
        col += 1;
        continue;
      }
      // 同一行连续的深色模块合并成一段
      let run = 1;
      while (col + run < size && qr.modules.get(row, col + run)) run += 1;
      parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`);
      col += run;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${total * 8}" height="${total * 8}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
    `<path fill="#1d1b18" d="${parts.join('')}"/>` +
    '</svg>'
  );
}

/** 文本 → 二维码 SVG 的 data URI（`<img src>` 与下载链接用）。 */
export function qrSvgDataUri(text: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(qrSvg(text), 'utf8').toString('base64')}`;
}
