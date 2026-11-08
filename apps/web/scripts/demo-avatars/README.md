# 演示用户头像

44 位虚构演示人物的本地 WebP 头像，每张 256 × 256。包含当前演示种子及保留的历史演示账号。

- 画风：DiceBear 9.x `notionists-neutral`，基于 Zoish 的 Notionists。
- 来源与许可：https://www.dicebear.com/styles/notionists-neutral/ ，CC0 1.0。
- `manifest.json` 记录每位人物的邮箱、昵称、本地文件和生成地址。邮箱仅用于虚构演示账号的匹配，不向图片服务发送真实用户信息。
- 启动时从本目录读取，不请求远程服务。仅补齐未设置头像的已知演示账号，已有头像不覆盖。
