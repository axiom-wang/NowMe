# 主站界面字体

`font-*.woff2` 是由 `pnpm --filter @nowme/web fonts:build` 从 Kit 字体源文件生成的子集，均以 SIL Open Font License 1.1 授权（https://openfontlicense.org）：

| 文件 | 字体 | 版权 |
| --- | --- | --- |
| `font-display.woff2` | Smiley Sans（得意黑） | © atelier-anchor |
| `font-grotesk-500.woff2`、`font-grotesk-700.woff2` | Space Grotesk | © The Space Grotesk Project Authors |
| `font-mono-500.woff2` | JetBrains Mono | © The JetBrains Mono Project Authors |

改了界面文案（新增汉字）后要重新运行生成脚本，否则 `.display` 标题里的新字会回退到系统字体。
